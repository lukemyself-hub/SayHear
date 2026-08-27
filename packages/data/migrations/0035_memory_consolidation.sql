-- 1A.3a / issue #114: Slow path — daily / weekly consolidation + candidate
-- sweeper (SPEC #107 "Two-speed pipeline", ADR-0115 / ADR-0039 / ADR-0041 /
-- ADR-0048 / ADR-0050 / ADR-0051). Daily and weekly consolidation propose
-- structured diffs through `memory.consolidate`; the deterministic admission
-- validator commits inside one transaction per run. The sweeper enforces the
-- deterministic candidate deadlines (30-day predicate-review stale, 90-day
-- registry-release stale, 7-day terminal content purge).

-- Versioned, immutable policy parameters.
CREATE TABLE memory_consolidation_policies (
  policy_version TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO memory_consolidation_policies (policy_version, created_at)
VALUES ('memory-consolidation:v1', CURRENT_TIMESTAMP);

CREATE FUNCTION reject_memory_consolidation_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Memory consolidation policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER memory_consolidation_policies_immutable
BEFORE UPDATE OR DELETE ON memory_consolidation_policies
FOR EACH ROW
EXECUTE FUNCTION reject_memory_consolidation_policy_mutation();

-- One command per (user, kind, anchor date). The anchor is the consolidated
-- logical date for daily runs, the ISO week start for weekly runs, and the
-- scan's local date for the sweeper; source_revision carries it as YYYYMMDD.
ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'owner_full_purge', 'journal_regeneration', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper'
    ));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
    CHECK (event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'owner_full_purge_requested',
      'journal_regeneration_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested'
    ));

-- The authoritative idempotency anchor: exactly one completed (or failed)
-- run per (user, kind, anchor date, policy). Replays converge here before
-- any diff executes.
CREATE TABLE memory_consolidation_runs (
  memory_consolidation_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  consolidation_kind TEXT NOT NULL
    CHECK (consolidation_kind IN ('daily', 'weekly', 'sweeper')),
  anchor_date DATE NOT NULL,
  policy_version TEXT NOT NULL
    REFERENCES memory_consolidation_policies(policy_version),
  workflow_command_id UUID NOT NULL
    REFERENCES workflow_commands(workflow_command_id),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  model_attempt_id TEXT,
  consolidate_config_version TEXT,
  consolidate_model_version TEXT,
  consolidate_prompt_version TEXT,
  role_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL
    CHECK (status IN ('consolidated', 'swept', 'retryable_failed', 'stale_source')),
  diff_count INTEGER NOT NULL DEFAULT 0 CHECK (diff_count >= 0),
  promoted_count INTEGER NOT NULL DEFAULT 0 CHECK (promoted_count >= 0),
  reinforced_count INTEGER NOT NULL DEFAULT 0 CHECK (reinforced_count >= 0),
  contested_count INTEGER NOT NULL DEFAULT 0 CHECK (contested_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  dormant_count INTEGER NOT NULL DEFAULT 0 CHECK (dormant_count >= 0),
  staled_count INTEGER NOT NULL DEFAULT 0 CHECK (staled_count >= 0),
  purged_count INTEGER NOT NULL DEFAULT 0 CHECK (purged_count >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, consolidation_kind, anchor_date, policy_version),
  UNIQUE (memory_consolidation_run_id, user_id),
  CHECK (consolidation_kind <> 'sweeper'
    OR status IN ('swept', 'retryable_failed', 'stale_source')),
  CHECK (consolidation_kind = 'sweeper'
    OR status IN ('consolidated', 'retryable_failed', 'stale_source'))
);

-- Per-diff audit: what memory.consolidate proposed and what the deterministic
-- validator actually admitted. Outcome is the validator's verdict — the diff
-- kind is advisory and can never force a state change the planner rejects.
CREATE TABLE memory_consolidation_diffs (
  memory_consolidation_diff_id UUID PRIMARY KEY,
  memory_consolidation_run_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  diff_index INTEGER NOT NULL CHECK (diff_index >= 0),
  diff_kind TEXT NOT NULL
    CHECK (diff_kind IN (
      'propose_new', 'reinforce_existing', 'supersede_existing',
      'contest_existing', 'mark_review_due', 'no_change',
      'dormancy_check', 'stale_candidate', 'purge_terminal_content'
    )),
  memory_candidate_id UUID,
  memory_claim_id UUID,
  outcome TEXT NOT NULL
    CHECK (outcome IN (
      'promoted', 'reinforced', 'contested', 'rejected', 'recorded',
      'below_impression_floor', 'pending_conflict', 'blocked_forget_fence',
      'needs_entity_resolution', 'blocked_terminal', 'already_admitted',
      'skipped', 'no_change', 'dormant', 'not_due', 'not_applicable',
      'staled', 'already_terminal', 'missing_original_deadline', 'purged'
    )),
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_consolidation_run_id, diff_index),
  FOREIGN KEY (memory_consolidation_run_id, user_id)
    REFERENCES memory_consolidation_runs(memory_consolidation_run_id, user_id),
  FOREIGN KEY (memory_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id),
  FOREIGN KEY (memory_claim_id, user_id)
    REFERENCES memory_claims(memory_claim_id, user_id)
);

CREATE INDEX memory_consolidation_diffs_run_idx
  ON memory_consolidation_diffs(memory_consolidation_run_id, user_id);

-- Sweeper lookup: terminal candidates whose 7-day content window has elapsed
-- and whose derived semantics still await the audit-envelope sweep (ADR-0051).
CREATE INDEX memory_candidates_terminal_content_expiry_idx
  ON memory_candidates(terminal_content_expires_at)
  WHERE status IN ('rejected', 'stale') AND content_purged_at IS NULL;

-- ADR-0051 sweep semantics (completing migration 0033's stated intent): after
-- the 7-day grace the sweeper clears every field that could restore proposal
-- meaning (typed value, concept, Entity / Predicate bindings, scope, temporal
-- bounds) to NULL, keeping only the contentless Terminal Candidate Audit
-- Envelope. Typed value and scope must therefore become nullable, and the
-- mapped/unmapped shape check gains a purged escape.
ALTER TABLE memory_candidates
  ALTER COLUMN proposed_object_value DROP NOT NULL;
ALTER TABLE memory_candidates
  ALTER COLUMN proposed_scope_key DROP NOT NULL;

DO $$
DECLARE resolution_shape_constraint text;
BEGIN
  SELECT conname INTO resolution_shape_constraint
  FROM pg_constraint
  WHERE conrelid = 'memory_candidates'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid)
      LIKE '%predicate_resolution_status = ''mapped''%';
  IF resolution_shape_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE memory_candidates DROP CONSTRAINT %I',
      resolution_shape_constraint
    );
  END IF;
END $$;

ALTER TABLE memory_candidates
  ADD CONSTRAINT memory_candidates_resolution_shape_check CHECK (
    content_purged_at IS NOT NULL
    OR (
      (
        predicate_resolution_status = 'mapped'
        AND predicate_id IS NOT NULL
        AND predicate_registry_version IS NOT NULL
      )
      OR (
        predicate_resolution_status <> 'mapped'
        AND predicate_id IS NULL
        AND proposed_concept IS NOT NULL
      )
    )
  );

ALTER TABLE memory_candidates
  ADD CONSTRAINT memory_candidates_purge_terminal_only_check CHECK (
    content_purged_at IS NULL OR status IN ('rejected', 'stale')
  );

-- The terminal fence now distinguishes the forever-immutable audit envelope
-- from the sweepable semantic columns: envelope columns may never change;
-- semantic columns may only transition to NULL together with the purge
-- timestamp, and a purged row can never be re-semanticized or re-purged.
CREATE OR REPLACE FUNCTION enforce_memory_candidate_terminal_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('rejected', 'stale') THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'Terminal MemoryCandidate disposition cannot change (ADR-0046)'
        USING ERRCODE = '55000';
    END IF;
    IF (
      OLD.content_purged_at IS NOT NULL
      AND NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at
    ) THEN
      RAISE EXCEPTION
        'A swept Terminal MemoryCandidate cannot be re-purged (ADR-0051)'
        USING ERRCODE = '55000';
    END IF;
    IF (
      NEW.subject_entity_id IS DISTINCT FROM OLD.subject_entity_id
      OR NEW.subject_entity_mention_id IS DISTINCT FROM OLD.subject_entity_mention_id
      OR NEW.object_entity_id IS DISTINCT FROM OLD.object_entity_id
      OR NEW.object_entity_mention_id IS DISTINCT FROM OLD.object_entity_mention_id
      OR NEW.predicate_id IS DISTINCT FROM OLD.predicate_id
      OR NEW.proposed_concept IS DISTINCT FROM OLD.proposed_concept
      OR NEW.mapping_confidence IS DISTINCT FROM OLD.mapping_confidence
      OR NEW.proposed_object_value IS DISTINCT FROM OLD.proposed_object_value
      OR NEW.proposed_scope_key IS DISTINCT FROM OLD.proposed_scope_key
      OR NEW.proposed_valid_from IS DISTINCT FROM OLD.proposed_valid_from
      OR NEW.proposed_valid_to IS DISTINCT FROM OLD.proposed_valid_to
    ) AND NOT (
      OLD.content_purged_at IS NULL
      AND NEW.content_purged_at IS NOT NULL
      AND NEW.subject_entity_id IS NULL
      AND NEW.subject_entity_mention_id IS NULL
      AND NEW.object_entity_id IS NULL
      AND NEW.object_entity_mention_id IS NULL
      AND NEW.predicate_id IS NULL
      AND NEW.proposed_concept IS NULL
      AND NEW.mapping_confidence IS NULL
      AND NEW.proposed_object_value IS NULL
      AND NEW.proposed_scope_key IS NULL
      AND NEW.proposed_valid_from IS NULL
      AND NEW.proposed_valid_to IS NULL
    ) THEN
      RAISE EXCEPTION
        'Terminal MemoryCandidate content may only be swept to NULL together with the purge timestamp, never re-set'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.candidate_kind IS DISTINCT FROM OLD.candidate_kind
      OR NEW.basis IS DISTINCT FROM OLD.basis
      OR NEW.predicate_resolution_status IS DISTINCT FROM OLD.predicate_resolution_status
      OR NEW.predicate_registry_version IS DISTINCT FROM OLD.predicate_registry_version
      OR NEW.proposed_temporal_status IS DISTINCT FROM OLD.proposed_temporal_status
      OR NEW.extraction_policy_version IS DISTINCT FROM OLD.extraction_policy_version
      OR NEW.disposition_reason_code IS DISTINCT FROM OLD.disposition_reason_code
      OR NEW.disposition_policy_version IS DISTINCT FROM OLD.disposition_policy_version
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.terminal_effective_at IS DISTINCT FROM OLD.terminal_effective_at
      OR NEW.terminal_content_expires_at IS DISTINCT FROM OLD.terminal_content_expires_at
      OR NEW.reproposal_policy IS DISTINCT FROM OLD.reproposal_policy
      OR NEW.dedupe_fingerprint IS DISTINCT FROM OLD.dedupe_fingerprint
      OR NEW.dedupe_fingerprint_key_version IS DISTINCT FROM OLD.dedupe_fingerprint_key_version
    THEN
      RAISE EXCEPTION
        'Terminal MemoryCandidate audit envelope is immutable (ADR-0051)'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
