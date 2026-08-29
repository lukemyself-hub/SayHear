-- 1A.3a / #119: Trust actions core (ADR-0118, ADR-0099, SPEC #107 "Trust
-- actions"). Three faces:
--
-- 1. Typed target references for admission-time resolved trust-action
--    targets. ADR-0096 handles stay journal-only (target_handle / target_id);
--    a trust action resolved outside the frozen context records the real
--    Claim it resolved to as typed reference columns on the Execution and on
--    each Receipt, auditable and FK-enforced.
-- 2. User control commands for Memory Correction (ADR-0035 pattern: user
--    control commands, never counter-Evidence). The correction command row
--    is the convergence anchor for repeated corrections and the audit trail
--    of which version a correction deactivated; the impression veto blocks
--    the old evidence chain from re-qualifying same-topic impressions
--    (ADR-0039 fresh-from-zero re-accumulation).
-- 3. The idempotent async follow-up workflow command type (targeted
--    JournalStatement revalidation under one Receipt sequence).

-- ---------------------------------------------------------------------------
-- 1. Typed resolved-target references on executions and receipts.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_action_executions
  DROP CONSTRAINT conversation_action_executions_target_kind_check;
ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_target_kind_check
    CHECK (target_kind IS NULL OR target_kind IN ('journal', 'memory_claim'));

ALTER TABLE conversation_action_executions
  ADD COLUMN resolved_claim_id UUID REFERENCES memory_claims(memory_claim_id),
  ADD COLUMN resolved_claim_version_id UUID
    REFERENCES memory_claim_versions(memory_claim_version_id);

-- A memory_claim target rides the resolved_* pair with the journal target
-- columns absent; a journal target keeps the handle columns and carries no
-- resolved_* pair. Nothing else admits.
ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_target_shape_check CHECK (
    (
      target_kind = 'memory_claim'
      AND resolved_claim_id IS NOT NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_handle IS NULL
    )
    OR (target_kind IS NULL AND resolved_claim_id IS NULL)
    OR (
      target_kind = 'journal'
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
    )
  );

ALTER TABLE conversation_action_receipts
  ADD COLUMN resolved_claim_id UUID REFERENCES memory_claims(memory_claim_id),
  ADD COLUMN resolved_claim_version_id UUID
    REFERENCES memory_claim_versions(memory_claim_version_id),
  -- No-prose structured disposition detail (e.g. the multi-hit candidate
  -- count); IDs, counts, and codes only — never conversation text (ADR-0101).
  ADD COLUMN disposition_detail JSONB;

-- ---------------------------------------------------------------------------
-- 2. Correction command + impression veto (user control commands).
-- ---------------------------------------------------------------------------

CREATE TABLE memory_claim_corrections (
  memory_claim_correction_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  request_event_revision_id UUID NOT NULL,
  target_claim_id UUID NOT NULL
    REFERENCES memory_claims(memory_claim_id),
  deactivated_claim_version_id UUID NOT NULL
    REFERENCES memory_claim_versions(memory_claim_version_id),
  target_scope TEXT NOT NULL
    CHECK (target_scope IN ('whole_claim')),
  -- True when the correction carried an establishment clause; the structured
  -- corrected fact itself forms forward through ordinary extraction and
  -- admission (SPEC trust actions: async follow-ups stay asynchronous).
  corrected_fact_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  correction_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    )
);

CREATE INDEX memory_claim_corrections_claim_idx
  ON memory_claim_corrections(user_id, target_claim_id, created_at);

-- A correction of an AI Impression records the user veto (SPEC #107 trust
-- actions): the deactivated evidence chain never re-qualifies same-topic
-- impressions — new impressions must accumulate fresh cross-Session Evidence
-- from zero (ADR-0039). Each impression correction appends one veto row as
-- normal history; any active veto on the claim keeps the fresh-from-zero
-- rule in force.
CREATE TABLE memory_impression_vetoes (
  memory_impression_veto_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_id UUID NOT NULL
    REFERENCES memory_claims(memory_claim_id),
  vetoed_claim_version_id UUID NOT NULL
    REFERENCES memory_claim_versions(memory_claim_version_id),
  request_event_revision_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active')),
  impression_correction_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    )
);

CREATE INDEX memory_impression_vetoes_claim_active_idx
  ON memory_impression_vetoes(user_id, memory_claim_id)
  WHERE status = 'active';

-- The targeted JournalStatement revalidation result of one correction
-- follow-up run (idempotent: one row per workflow command). It records which
-- journal statements rest on evidence of the corrected claim so the journal
-- layer can re-check them; it never blocks publication (ADR-0107 discipline)
-- and never rewrites journal content.
CREATE TABLE memory_correction_followups (
  memory_correction_followup_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  workflow_command_id UUID NOT NULL
    REFERENCES workflow_commands(workflow_command_id),
  action_execution_id UUID NOT NULL
    REFERENCES conversation_action_executions(action_execution_id),
  target_claim_id UUID NOT NULL
    REFERENCES memory_claims(memory_claim_id),
  affected_journal_statement_count INTEGER NOT NULL
    CHECK (affected_journal_statement_count >= 0),
  followup_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workflow_command_id)
);

-- ---------------------------------------------------------------------------
-- 3. Async follow-up workflow type (idempotent, one Receipt sequence).
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'owner_full_purge', 'journal_regeneration', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup'
    ));

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_subject_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_subject_type_check
    CHECK (subject_type IN (
      'daily_session', 'app_user', 'conversation_event_revision',
      'memory_claim'
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
      'memory_sweeper_requested', 'memory_correction_followup_requested'
    ));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
    CHECK (aggregate_type IN (
      'daily_session', 'app_user', 'conversation_event_revision',
      'memory_claim'
    ));

-- A materially ambiguous trust-action target closes the round's memory on
-- the reply context (SPEC AC 29 fail-closed); the reason stays inspectable.
ALTER TABLE compiled_contexts
  DROP CONSTRAINT compiled_contexts_degraded_reason_check;
ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_degraded_reason_check
    CHECK (degraded_reason IN (
      'raw_event_budget_exceeded',
      'dialogue_state_failed',
      'dialogue_state_lagging',
      'rolling_summary_failed',
      'fast_path_pending',
      'memory_retrieval_failed',
      'trust_action_memory_fenced'
    ));

-- Trust-action clarifications (ADR-0118, issue #119) finalize their honest
-- reply from the frozen Admission Receipt while the execution stays
-- `not_started` (ADR-0099). The 0022 snapshot constraint assumed finalization
-- only froze accepted actions; widen it to admit the not_started receipt.
ALTER TABLE generation_commands
  DROP CONSTRAINT generation_commands_action_receipt_snapshot_check;
ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_action_receipt_snapshot_check
  CHECK (
    generation_stage <> 'action_finalization'
    OR (
      action_execution_id IS NOT NULL
      AND action_receipt_sequence IS NOT NULL
      AND action_receipt_sequence > 0
      AND action_execution_status IN (
        'not_started', 'pending', 'running', 'succeeded', 'failed', 'canceled'
      )
    )
  );
