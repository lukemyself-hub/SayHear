-- 1A.3b A3 / issue #199.
--
-- Daily / Weekly Reflection domain: logical reflections (daily_session and
-- date_range scopes), immutable reflection_versions with the Q3 identity keys
-- (Daily command identity carries the claim-baseline digest; Weekly keeps the
-- composite source digest), typed statements / atomic propositions with
-- Evidence-only support links, the Memory-Candidate proposal lineage, and the
-- daily / weekly run ledger.
--
-- The reflection.daily / reflection.weekly / narrative.validate roles consume
-- the shared generation_commands / model_run_attempts ledger added by 0044.
-- This migration adds the domain surfaces only; it does not seed a provider,
-- model, or active rollout pin, so Reflection admission stays closed until a
-- release manifest publishes an evaluated config (ADR-0136 / ADR-0134).
--
-- Retention follows ADR-0130: current committed content stays readable while
-- it is current; superseded committed content keeps its typed content for 30
-- days from supersede; draft / stale / failed content keeps it for 7 days.
-- Every table here is registered in the Purge Surface Registry in the same
-- change (ADR-0131).

CREATE TABLE reflection_policies (
  policy_version TEXT PRIMARY KEY CHECK (policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO reflection_policies (policy_version, created_at)
VALUES ('reflection-admission:v1', CURRENT_TIMESTAMP),
       ('reflection-readiness:v1', CURRENT_TIMESTAMP);

CREATE FUNCTION reject_reflection_policy_mutation() RETURNS trigger
AS $$
BEGIN
  RAISE EXCEPTION 'reflection_policies rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reflection_policies_immutable
  BEFORE UPDATE OR DELETE ON reflection_policies
  FOR EACH ROW EXECUTE FUNCTION reject_reflection_policy_mutation();

-- Owner-boundary reference for reflection_versions validator FKs (ADR-0085).
CREATE UNIQUE INDEX narrative_validator_requests_owner_boundary_idx
  ON narrative_validator_requests(narrative_validator_request_id, user_id);

CREATE UNIQUE INDEX narrative_validator_results_owner_boundary_idx
  ON narrative_validator_results(narrative_validator_result_id, user_id);

CREATE TABLE reflections (
  reflection_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('daily_session', 'date_range')
  ),
  daily_session_id UUID,
  week_window_id UUID,
  week_identifier TEXT,
  window_start_date TEXT,
  window_end_date TEXT,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (reflection_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  CHECK (
    (scope_type = 'daily_session') = (daily_session_id IS NOT NULL)
  ),
  CHECK (
    (scope_type = 'date_range') = (
      week_window_id IS NOT NULL
      AND week_identifier IS NOT NULL
      AND window_start_date IS NOT NULL
      AND window_end_date IS NOT NULL
    )
  )
);

-- One logical Reflection per Daily Session / week window (SPEC 5.1 identity).
CREATE UNIQUE INDEX reflections_daily_session_idx
  ON reflections(user_id, daily_session_id)
  WHERE scope_type = 'daily_session' AND deleted_at IS NULL;

CREATE UNIQUE INDEX reflections_week_window_idx
  ON reflections(user_id, week_window_id)
  WHERE scope_type = 'date_range' AND deleted_at IS NULL;

CREATE TABLE reflection_versions (
  reflection_version_id UUID PRIMARY KEY,
  reflection_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('daily_session', 'date_range')
  ),
  -- Daily: the Daily Session source-revision head, unchanged semantics
  -- (SPEC 5.3 Q3). Weekly: composite source identity lives in source_digest
  -- and source_revision stays 0.
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  source_digest TEXT CHECK (source_digest IS NULL OR source_digest <> ''),
  claim_baseline_digest TEXT NOT NULL CHECK (claim_baseline_digest <> ''),
  schedule_policy_version TEXT NOT NULL CHECK (schedule_policy_version <> ''),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
  schema_version TEXT NOT NULL CHECK (schema_version <> ''),
  locale TEXT NOT NULL CHECK (locale <> ''),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'failed', 'committed', 'superseded', 'stale')
  ),
  degraded_episode_reason TEXT,
  statements JSONB
    CHECK (statements IS NULL OR jsonb_typeof(statements) = 'object'),
  candidate_proposals JSONB
    CHECK (candidate_proposals IS NULL
      OR jsonb_typeof(candidate_proposals) = 'object'),
  generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  authoritative_model_attempt_id UUID NOT NULL
    REFERENCES model_run_attempts(model_run_attempt_id),
  validator_request_id UUID,
  validator_result_id UUID,
  committed_at TIMESTAMPTZ,
  status_effective_at TIMESTAMPTZ NOT NULL,
  -- Read-time retention deadline (ADR-0130): NULL only while the version is
  -- the current committed content; every other state carries a deadline.
  content_expires_at TIMESTAMPTZ,
  supersedes_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (reflection_version_id, user_id),
  UNIQUE (reflection_id, revision),
  FOREIGN KEY (reflection_id, user_id)
    REFERENCES reflections(reflection_id, user_id),
  FOREIGN KEY (validator_request_id, user_id)
    REFERENCES narrative_validator_requests(
      narrative_validator_request_id, user_id
    ),
  FOREIGN KEY (validator_result_id, user_id)
    REFERENCES narrative_validator_results(
      narrative_validator_result_id, user_id
    ),
  CHECK (
    (scope_type = 'daily_session') = (source_digest IS NULL)
  ),
  CHECK (
    (scope_type = 'date_range') = (source_revision = 0)
  ),
  CHECK (
    (committed_at IS NULL) = (status IN ('draft', 'failed'))
  ),
  CHECK (
    status <> 'committed' OR validator_request_id IS NOT NULL
  ),
  CHECK (
    (supersedes_version_id IS NULL) = (revision = 1)
  ),
  CHECK (
    (degraded_episode_reason IS NULL) OR scope_type = 'daily_session'
  ),
  CHECK (
    status = 'committed' OR content_expires_at IS NOT NULL
  )
);

-- Q3 (SPEC 5.3): the Daily derived-dedupe key must distinguish the
-- claim-baseline digest, so a same-head new-baseline version is never
-- forbidden by the old physical UNIQUE(reflection_id, source_revision,
-- policy_version). Weekly identity uses the composite source digest.
CREATE UNIQUE INDEX reflection_versions_daily_identity_idx
  ON reflection_versions(reflection_id, source_revision, claim_baseline_digest, policy_version)
  WHERE scope_type = 'daily_session';

CREATE UNIQUE INDEX reflection_versions_weekly_identity_idx
  ON reflection_versions(reflection_id, source_digest, policy_version)
  WHERE scope_type = 'date_range';

CREATE UNIQUE INDEX reflection_versions_supersedes_once_idx
  ON reflection_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

CREATE INDEX reflection_versions_reflection_idx
  ON reflection_versions(reflection_id);

CREATE INDEX reflection_versions_owner_status_idx
  ON reflection_versions(user_id, status)
  WHERE content_purged_at IS NULL;

-- Owner-boundary reference for the current-pointer composite FK (ADR-0085).
CREATE UNIQUE INDEX reflection_versions_owner_boundary_idx
  ON reflection_versions(reflection_version_id, reflection_id, user_id);

ALTER TABLE reflections
  ADD CONSTRAINT reflections_current_version_fk
  FOREIGN KEY (current_version_id, reflection_id, user_id)
  REFERENCES reflection_versions(
    reflection_version_id, reflection_id, user_id
  );

CREATE UNIQUE INDEX reflections_current_version_idx
  ON reflections(current_version_id)
  WHERE current_version_id IS NOT NULL;

-- Immutable version history (ADR-0074 / ADR-0130): typed content transitions
-- to NULL only with content_purged_at during Full Purge or retention expiry;
-- status, effective time, expiry, and current-pointer replacement are the
-- only other permitted writes.
CREATE FUNCTION enforce_reflection_version_immutability() RETURNS trigger
AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged reflection version rows are immutable';
  END IF;
  IF (NEW.statements IS NULL) <> (NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reflection version content purge must match content_purged_at';
  END IF;
  IF (NEW.candidate_proposals IS NULL) <> (NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reflection version candidate purge must match content_purged_at';
  END IF;
  IF NEW.statements IS DISTINCT FROM OLD.statements
    AND NOT (OLD.statements IS NOT NULL AND NEW.statements IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reflection version statements are immutable until purge';
  END IF;
  IF NEW.candidate_proposals IS DISTINCT FROM OLD.candidate_proposals
    AND NOT (OLD.candidate_proposals IS NOT NULL
      AND NEW.candidate_proposals IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reflection version candidate proposals are immutable until purge';
  END IF;
  IF OLD.status = 'committed' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a committed reflection version cannot return to draft';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded reflection version is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reflection_versions_immutability
  BEFORE UPDATE ON reflection_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_reflection_version_immutability();

CREATE TABLE reflection_statements (
  reflection_statement_id UUID PRIMARY KEY,
  reflection_version_id UUID NOT NULL
    REFERENCES reflection_versions(reflection_version_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  statement_index INTEGER NOT NULL CHECK (statement_index >= 0),
  statement_kind TEXT NOT NULL CHECK (
    statement_kind IN ('day_observation', 'cross_day_theme', 'change_observation')
  ),
  statement_text TEXT NOT NULL CHECK (statement_text <> ''),
  content_purged_at TIMESTAMPTZ,
  UNIQUE (reflection_statement_id, user_id),
  UNIQUE (reflection_version_id, statement_index),
  FOREIGN KEY (reflection_version_id, user_id)
    REFERENCES reflection_versions(reflection_version_id, user_id)
);

CREATE INDEX reflection_statements_version_idx
  ON reflection_statements(reflection_version_id);

CREATE TABLE reflection_atomic_propositions (
  reflection_atomic_proposition_id UUID PRIMARY KEY,
  reflection_statement_id UUID NOT NULL
    REFERENCES reflection_statements(reflection_statement_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  proposition_index INTEGER NOT NULL CHECK (proposition_index >= 0),
  normalized_proposition TEXT NOT NULL CHECK (normalized_proposition <> ''),
  proposition_kind TEXT NOT NULL CHECK (
    proposition_kind IN ('fact', 'impression', 'synthesis')
  ),
  epistemic_rendering TEXT NOT NULL CHECK (
    epistemic_rendering IN ('confirmed', 'inferred')
  ),
  -- change_observation baseline subset (SPEC 5.2); JSON array of claim IDs.
  baseline_claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(baseline_claim_ids) = 'array'),
  content_purged_at TIMESTAMPTZ,
  UNIQUE (reflection_atomic_proposition_id, user_id),
  UNIQUE (reflection_statement_id, proposition_index),
  FOREIGN KEY (reflection_statement_id, user_id)
    REFERENCES reflection_statements(reflection_statement_id, user_id)
);

CREATE INDEX reflection_atomic_propositions_statement_idx
  ON reflection_atomic_propositions(reflection_statement_id);

-- Support is Evidence-only (SPEC 5.2): one link row per proposition and
-- EvidenceItem, each expandable to a final / corrected User Event revision.
CREATE TABLE reflection_statement_evidence_links (
  reflection_statement_evidence_link_id UUID PRIMARY KEY,
  reflection_atomic_proposition_id UUID NOT NULL
    REFERENCES reflection_atomic_propositions(reflection_atomic_proposition_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_item_id UUID NOT NULL REFERENCES evidence_items(evidence_item_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reflection_atomic_proposition_id, evidence_item_id),
  FOREIGN KEY (reflection_atomic_proposition_id, user_id)
    REFERENCES reflection_atomic_propositions(
      reflection_atomic_proposition_id, user_id
    ),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX reflection_statement_evidence_links_proposition_idx
  ON reflection_statement_evidence_links(reflection_atomic_proposition_id);

CREATE INDEX reflection_statement_evidence_links_evidence_idx
  ON reflection_statement_evidence_links(evidence_item_id, user_id);

-- Lineage of the MemoryCandidate proposals this version handed off
-- (propose_new only, fingerprinted; SPEC 5.2 / 5.3).
CREATE TABLE reflection_candidate_proposals (
  reflection_candidate_proposal_id UUID PRIMARY KEY,
  reflection_version_id UUID NOT NULL
    REFERENCES reflection_versions(reflection_version_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_candidate_id UUID,
  dedupe_fingerprint TEXT,
  dedupe_fingerprint_key_version TEXT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('created', 'blocked_terminal', 'skipped')
  ),
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reflection_candidate_proposal_id, user_id),
  FOREIGN KEY (reflection_version_id, user_id)
    REFERENCES reflection_versions(reflection_version_id, user_id),
  FOREIGN KEY (memory_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id)
);

CREATE INDEX reflection_candidate_proposals_version_idx
  ON reflection_candidate_proposals(reflection_version_id);

-- Run ledger for both scopes. The Daily key matches the Q3 command identity
-- exactly; the Weekly key carries the composite source digest.
CREATE TABLE reflection_runs (
  reflection_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('daily_session', 'date_range')
  ),
  daily_session_id UUID,
  week_window_id UUID,
  window_start_date TEXT,
  window_end_date TEXT,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  source_digest TEXT CHECK (source_digest IS NULL OR source_digest <> ''),
  claim_baseline_digest TEXT NOT NULL CHECK (claim_baseline_digest <> ''),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  generation_command_id UUID REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID REFERENCES model_run_attempts(model_run_attempt_id),
  status TEXT NOT NULL CHECK (
    status IN ('ready', 'built', 'stale_source', 'fenced', 'retryable_failed', 'failed')
  ),
  outcome_detail TEXT,
  statement_count INTEGER CHECK (statement_count IS NULL OR statement_count >= 0),
  candidate_count INTEGER CHECK (candidate_count IS NULL OR candidate_count >= 0),
  degraded_episode_reason TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (reflection_run_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  CHECK (
    (scope_type = 'daily_session') = (daily_session_id IS NOT NULL)
  ),
  CHECK (
    (scope_type = 'date_range') = (week_window_id IS NOT NULL
      AND window_start_date IS NOT NULL AND window_end_date IS NOT NULL)
  ),
  CHECK (
    (scope_type = 'daily_session') = (source_digest IS NULL)
  ),
  CHECK (
    (scope_type = 'date_range') = (source_revision = 0)
  ),
  CHECK (
    (degraded_episode_reason IS NULL) OR scope_type = 'daily_session'
  )
);

CREATE UNIQUE INDEX reflection_runs_daily_identity_idx
  ON reflection_runs(user_id, daily_session_id, source_revision, claim_baseline_digest, policy_version)
  WHERE scope_type = 'daily_session';

CREATE UNIQUE INDEX reflection_runs_weekly_identity_idx
  ON reflection_runs(user_id, week_window_id, source_digest, policy_version)
  WHERE scope_type = 'date_range';

CREATE INDEX reflection_runs_pending_idx
  ON reflection_runs(user_id)
  WHERE status = 'ready';

-- The Reflection scheduler admits through workflow_commands with its own
-- command types; the baseline digest rides the intent key so a baseline-only
-- change creates a fresh command identity (SPEC 5.3 Q3).
ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (
    command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'journal_regeneration', 'owner_full_purge', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup', 'entity_identity_revalidation',
      'model_role', 'episode_build', 'episode_maintenance',
      'reflection_daily', 'reflection_weekly', 'reflection_maintenance'
    )
  );

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (
    event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'journal_regeneration_requested',
      'owner_full_purge_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested', 'memory_correction_followup_requested',
      'entity_identity_revalidation_requested', 'model_role_requested',
      'episode_build_requested', 'episode_maintenance_requested',
      'reflection_daily_requested', 'reflection_weekly_requested',
      'reflection_maintenance_requested'
    )
  );
