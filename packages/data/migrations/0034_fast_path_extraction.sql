-- 1A.3a / issue #113: Fast-path extraction workflow (memory.extract +
-- entity.resolve gate). Every committed final / corrected User Event creates
-- an idempotent asynchronous extraction command via the outbox
-- (SPEC #107 "Two-speed pipeline", ADR-0115). Corrections produce new
-- revisions and new commands and retire the old revision's derivatives.

-- Versioned, immutable policy parameters. The 30 s visibility target and the
-- entity.resolve thresholds are tunable from production evidence through a
-- new policy version, never edited in place.
CREATE TABLE fast_path_extraction_policies (
  policy_version TEXT PRIMARY KEY,
  visibility_target_ms INTEGER NOT NULL
    CHECK (visibility_target_ms > 0),
  max_batch_revisions INTEGER NOT NULL
    CHECK (max_batch_revisions > 0 AND max_batch_revisions <= 50),
  entity_resolve_t_auto NUMERIC(5, 4) NOT NULL
    CHECK (entity_resolve_t_auto > 0 AND entity_resolve_t_auto <= 1),
  entity_resolve_max_candidates INTEGER NOT NULL
    CHECK (entity_resolve_max_candidates > 0 AND entity_resolve_max_candidates <= 10),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO fast_path_extraction_policies (
  policy_version,
  visibility_target_ms,
  max_batch_revisions,
  entity_resolve_t_auto,
  entity_resolve_max_candidates,
  created_at
)
VALUES (
  'fast-path-extraction:v1',
  30000,
  8,
  0.90,
  3,
  CURRENT_TIMESTAMP
);

CREATE FUNCTION reject_fast_path_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Fast path extraction policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fast_path_extraction_policies_immutable
BEFORE UPDATE OR DELETE ON fast_path_extraction_policies
FOR EACH ROW
EXECUTE FUNCTION reject_fast_path_policy_mutation();

-- The fast path owns one outbox command per committed final / corrected User
-- Event revision. Idempotency rests on the existing
-- workflow_commands(command_type, subject_type, subject_id, source_revision,
-- policy_version) unique key with subject = the event revision (source_revision
-- = the revision's ordinal, so a correction at revision N+1 is a new command).
ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'owner_full_purge', 'journal_regeneration', 'fast_path_extraction'
    ));
ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_subject_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_subject_type_check
    CHECK (subject_type IN (
      'daily_session', 'app_user', 'conversation_event_revision'
    ));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
    CHECK (event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'owner_full_purge_requested',
      'journal_regeneration_requested', 'fast_path_extraction_requested'
    ));
ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
    CHECK (aggregate_type IN (
      'daily_session', 'app_user', 'conversation_event_revision'
    ));

-- Per-revision extraction run: the authoritative idempotency anchor. Exactly
-- one row per (event revision, extraction policy); replays and workflow
-- retries converge here. Visibility accounting (extracted_at minus
-- event_committed_at against the versioned target) is recorded per run.
CREATE TABLE fast_path_extraction_runs (
  fast_path_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  event_revision_id UUID NOT NULL,
  event_conversation_event_id UUID NOT NULL,
  extraction_policy_version TEXT NOT NULL
    REFERENCES fast_path_extraction_policies(policy_version),
  workflow_command_id UUID NOT NULL
    REFERENCES workflow_commands(workflow_command_id),
  model_attempt_id TEXT NOT NULL,
  memory_extract_config_version TEXT NOT NULL,
  memory_extract_model_version TEXT NOT NULL,
  memory_extract_prompt_version TEXT NOT NULL,
  entity_resolve_config_version TEXT,
  role_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL
    CHECK (status IN ('extracted', 'retryable_failed', 'stale_source', 'retired')),
  -- Visibility accounting against the versioned P95 target.
  event_committed_at TIMESTAMPTZ NOT NULL,
  extracted_at TIMESTAMPTZ,
  visibility_lag_ms BIGINT CHECK (visibility_lag_ms >= 0),
  visibility_target_met BOOLEAN,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  UNIQUE (event_revision_id, extraction_policy_version),
  UNIQUE (fast_path_run_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (event_revision_id, event_conversation_event_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, conversation_event_id, user_id
    ),
  CHECK (
    (status IN ('extracted', 'retired')) = (extracted_at IS NOT NULL)
  ),
  CHECK (
    status <> 'extracted'
    OR (visibility_lag_ms IS NOT NULL AND visibility_target_met IS NOT NULL)
  ),
  CHECK (
    status <> 'retired'
    OR (retired_at IS NOT NULL AND extracted_at IS NOT NULL)
  )
);

CREATE INDEX fast_path_extraction_runs_session_idx
  ON fast_path_extraction_runs(daily_session_id, user_id)
  WHERE status = 'extracted';

-- Session-local context projection: the same-day surface fast-path output may
-- serve. `item_class` is the person / event / preference / emotion / open
-- marking step; `dedupe_key` is the light in-batch / in-session dedupe;
-- `retired_at` plus the event-currency fence at read time keep corrected-away
-- revisions out of the projection. Never a source for Claims, Recall,
-- Portrait, Profile, or embedding eligibility (SPEC story 29).
CREATE TABLE fast_path_session_items (
  fast_path_item_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  event_revision_id UUID NOT NULL,
  fast_path_run_id UUID NOT NULL,
  item_class TEXT NOT NULL
    CHECK (item_class IN ('person', 'event', 'preference', 'emotion', 'open')),
  summary TEXT NOT NULL CHECK (summary <> ''),
  memory_candidate_id UUID,
  entity_mention_id UUID,
  evidence_item_id UUID,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  UNIQUE (fast_path_item_id, user_id),
  UNIQUE (user_id, daily_session_id, dedupe_key),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (fast_path_run_id, user_id)
    REFERENCES fast_path_extraction_runs(fast_path_run_id, user_id),
  FOREIGN KEY (memory_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id),
  FOREIGN KEY (entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX fast_path_session_items_session_idx
  ON fast_path_session_items(daily_session_id, user_id)
  WHERE retired_at IS NULL;

-- Audit of the single entity.resolve LLM gate: one row per gated mention per
-- resolver policy version. The gate commits only on
-- unique candidate ∧ verdict = match ∧ confidence >= t_auto; every outcome
-- (committed or not) is recorded for manifests and inspection (#97).
CREATE TABLE entity_resolve_gate_outcomes (
  entity_resolve_gate_outcome_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  entity_mention_id UUID NOT NULL,
  gate_policy_version TEXT NOT NULL,
  resolver_policy_version TEXT NOT NULL,
  t_auto NUMERIC(5, 4) NOT NULL
    CHECK (t_auto > 0 AND t_auto <= 1),
  verdict TEXT NOT NULL
    CHECK (verdict IN ('match', 'no_match', 'unclear')),
  selected_entity_id UUID,
  confidence NUMERIC(5, 4) NOT NULL
    CHECK (confidence >= 0 AND confidence <= 1),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  committed BOOLEAN NOT NULL,
  not_committed_reason TEXT
    CHECK (not_committed_reason IN (
      'verdict_not_match', 'confidence_below_t_auto',
      'selection_not_a_candidate', 'invalid_response'
    )),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (entity_mention_id, resolver_policy_version, gate_policy_version),
  FOREIGN KEY (entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  FOREIGN KEY (selected_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  CHECK (
    (committed = TRUE AND selected_entity_id IS NOT NULL)
    OR (committed = FALSE AND not_committed_reason IS NOT NULL)
  )
);

-- Entity Clarification (ADR-0024): the model may propose, deterministic code
-- commits, at most once per (session, topic), triggered only by semantic
-- impact, with a topic-scoped stop that never escalates to the conversation
-- question-stop. Disambiguation evidence resolves the proposal; disengagement
-- drops it for the rest of the session's topic.
CREATE TABLE entity_clarification_proposals (
  entity_clarification_proposal_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  event_revision_id UUID NOT NULL,
  entity_mention_id UUID NOT NULL,
  topic_key TEXT NOT NULL CHECK (topic_key <> ''),
  semantic_impact TEXT NOT NULL
    CHECK (semantic_impact IN ('relationship_attribution', 'person_identity')),
  status TEXT NOT NULL
    CHECK (status IN ('committed', 'resolved', 'dropped')),
  question_text TEXT NOT NULL CHECK (question_text <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_event_revision_id UUID,
  UNIQUE (entity_clarification_proposal_id, user_id),
  UNIQUE (user_id, daily_session_id, topic_key),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  CHECK (
    (status = 'committed') = (decided_at IS NULL)
  )
);

CREATE INDEX entity_clarification_proposals_session_idx
  ON entity_clarification_proposals(daily_session_id, user_id);

-- The fast-path lag degraded reason (issue #113): the compile never waits on
-- extraction; pending committed revisions record `fast_path_pending` and raw
-- Events keep serving (architecture 12.1).
ALTER TABLE compiled_contexts
  DROP CONSTRAINT compiled_contexts_degraded_reason_check;
ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_degraded_reason_check
    CHECK (degraded_reason IN (
      'raw_event_budget_exceeded',
      'dialogue_state_failed',
      'dialogue_state_lagging',
      'rolling_summary_failed',
      'fast_path_pending'
    ));
