-- 1A.3b C1 / issue #204.
--
-- Open Loop domain: logical loops, immutable versions, content-free closure
-- audits, per-Event run settlement and the idempotent expiry ledger.
--
-- The open_loop.extract model role consumes the shared generation_commands /
-- model_run_attempts ledger added by 0044. This migration adds the domain
-- surfaces only; it does not seed a provider, model, or active rollout pin,
-- so Open Loop formation stays closed until a release manifest publishes an
-- evaluated config (ADR-0136 / ADR-0134).
--
-- Retention follows ADR-0130 and SPEC 6.4: current open summaries stay
-- readable while open; superseded and terminal summaries keep a 30-day
-- content grace from leaving current open, read-path enforced. Source
-- deletion clears affected content immediately; Full Purge deletes the whole
-- surface. Every table here is registered in the Purge Surface Registry in
-- the same change (ADR-0131).

CREATE TABLE open_loop_policies (
  policy_version TEXT PRIMARY KEY CHECK (policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO open_loop_policies (policy_version, created_at)
VALUES
  ('open-loop-formation:v1', CURRENT_TIMESTAMP),
  ('open-loop-closure:v1', CURRENT_TIMESTAMP),
  ('open-loop-expiry:v1', CURRENT_TIMESTAMP),
  ('open-loop-near-term-lexical:v1', CURRENT_TIMESTAMP);

CREATE FUNCTION reject_open_loop_policy_mutation() RETURNS trigger
AS $$
BEGIN
  RAISE EXCEPTION 'open_loop_policies rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER open_loop_policies_immutable
  BEFORE UPDATE OR DELETE ON open_loop_policies
  FOR EACH ROW EXECUTE FUNCTION reject_open_loop_policy_mutation();

CREATE TABLE open_loops (
  open_loop_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  open_loop_kind TEXT NOT NULL CHECK (
    open_loop_kind IN ('upcoming_event', 'awaited_outcome')
  ),
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  UNIQUE (open_loop_id, user_id)
);

CREATE TABLE open_loop_versions (
  open_loop_version_id UUID PRIMARY KEY,
  open_loop_id UUID NOT NULL REFERENCES open_loops(open_loop_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  open_loop_kind TEXT NOT NULL CHECK (
    open_loop_kind IN ('upcoming_event', 'awaited_outcome')
  ),
  source_evidence_item_id UUID NOT NULL REFERENCES evidence_items(evidence_item_id),
  source_event_revision_id UUID NOT NULL REFERENCES conversation_event_revisions(conversation_event_revision_id),
  source_claim_version_id UUID,
  source_episode_version_id UUID REFERENCES episode_versions(episode_version_id),
  canonical_claim_key TEXT,
  localized_summary TEXT,
  expected_start_at TIMESTAMPTZ,
  expected_end_at TIMESTAMPTZ,
  time_precision TEXT NOT NULL CHECK (
    time_precision IN ('instant', 'date', 'range', 'approximate', 'unknown')
  ),
  timezone TEXT,
  followup_eligible_from_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  expiry_source TEXT NOT NULL CHECK (
    expiry_source IN (
      'anchored_upcoming_plus_7d', 'anchored_awaited_plus_14d',
      'unanchored_plus_14d'
    )
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'occurred', 'resolved', 'canceled', 'expired', 'retracted')
  ),
  closure_event_revision_id UUID REFERENCES conversation_event_revisions(conversation_event_revision_id),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  generation_command_id UUID NOT NULL REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL REFERENCES model_run_attempts(model_run_attempt_id),
  supersedes_version_id UUID REFERENCES open_loop_versions(open_loop_version_id),
  terminal_effective_at TIMESTAMPTZ,
  terminal_processed_at TIMESTAMPTZ,
  content_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (open_loop_version_id, user_id),
  UNIQUE (open_loop_id, revision),
  CHECK (
    (supersedes_version_id IS NULL) = (revision = 1)
  ),
  CHECK (
    (status = 'open') = (
      terminal_effective_at IS NULL
      AND terminal_processed_at IS NULL
      AND closure_event_revision_id IS NULL
    )
  ),
  CHECK (
    status = 'open' OR (
      terminal_effective_at IS NOT NULL
      AND terminal_processed_at IS NOT NULL
      AND content_expires_at IS NOT NULL
      AND content_expires_at > terminal_effective_at
    )
  ),
  CHECK (
    (open_loop_kind = 'upcoming_event' AND status <> 'resolved')
    OR (open_loop_kind = 'awaited_outcome' AND status <> 'occurred')
  ),
  CHECK (
    expected_end_at IS NULL
    OR expected_start_at IS NULL
    OR expected_end_at > expected_start_at
  ),
  CHECK (
    content_purged_at IS NULL OR localized_summary IS NULL
  )
);

ALTER TABLE open_loops
  ADD CONSTRAINT open_loops_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES open_loop_versions(open_loop_version_id);

CREATE UNIQUE INDEX open_loop_versions_supersedes_once_idx
  ON open_loop_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

CREATE INDEX open_loop_versions_loop_idx
  ON open_loop_versions(open_loop_id);

CREATE INDEX open_loop_versions_owner_status_idx
  ON open_loop_versions(user_id, status, expires_at)
  WHERE content_purged_at IS NULL;

CREATE INDEX open_loop_versions_expiry_idx
  ON open_loop_versions(user_id, expires_at)
  WHERE status = 'open';

-- Immutable domain history (ADR-0074 / ADR-0130): frozen windows, summaries
-- and lifecycle can only move forward. A terminal version never reopens;
-- re-formation appends a new open version on the same logical loop. Summary
-- text can only transition to NULL together with content_purged_at (source
-- deletion, grace expiry, or Full Purge).
CREATE FUNCTION enforce_open_loop_version_immutability() RETURNS trigger
AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged open loop version rows are immutable';
  END IF;
  IF NEW.open_loop_id IS DISTINCT FROM OLD.open_loop_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.open_loop_kind IS DISTINCT FROM OLD.open_loop_kind
    OR NEW.source_evidence_item_id IS DISTINCT FROM OLD.source_evidence_item_id
    OR NEW.source_event_revision_id IS DISTINCT FROM OLD.source_event_revision_id
    OR NEW.followup_eligible_from_at IS DISTINCT FROM OLD.followup_eligible_from_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.expiry_source IS DISTINCT FROM OLD.expiry_source
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.generation_command_id IS DISTINCT FROM OLD.generation_command_id
    OR NEW.model_run_attempt_id IS DISTINCT FROM OLD.model_run_attempt_id
    OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
    OR NEW.terminal_effective_at IS DISTINCT FROM OLD.terminal_effective_at THEN
    RAISE EXCEPTION 'open loop version core fields are immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    OLD.status = 'open' AND NEW.status IN ('occurred', 'resolved', 'canceled', 'expired', 'retracted')
  ) THEN
    RAISE EXCEPTION 'open loop terminal versions never reopen';
  END IF;
  IF NEW.localized_summary IS DISTINCT FROM OLD.localized_summary
    AND NOT (OLD.localized_summary IS NOT NULL AND NEW.localized_summary IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'open loop summary is immutable until purge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER open_loop_versions_immutability
  BEFORE UPDATE ON open_loop_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_open_loop_version_immutability();

-- Content-free closure / suppression audit: evidence and candidate IDs,
-- proposed status, resolver/policy and disposition only. No proposal text,
-- no user summary, no Evidence quote.
CREATE TABLE open_loop_closure_audits (
  open_loop_closure_audit_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  source_event_revision_id UUID NOT NULL REFERENCES conversation_event_revisions(conversation_event_revision_id),
  target_open_loop_id UUID NOT NULL REFERENCES open_loops(open_loop_id),
  proposed_status TEXT NOT NULL CHECK (
    proposed_status IN ('occurred', 'resolved', 'canceled', 'ambiguous_closure')
  ),
  resolver_policy_version TEXT NOT NULL CHECK (resolver_policy_version <> ''),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('closed', 'ambiguous_suppressed', 'skipped')
  ),
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source_event_revision_id, target_open_loop_id, disposition)
);

CREATE INDEX open_loop_closure_audits_target_idx
  ON open_loop_closure_audits(target_open_loop_id);

CREATE INDEX open_loop_closure_audits_source_idx
  ON open_loop_closure_audits(source_event_revision_id);

-- Per-Event run settlement: all valid effects and the settlement commit
-- atomically; a failed run leaves no partial Loop/Version/link behind.
CREATE TABLE open_loop_run_outcomes (
  open_loop_run_outcome_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  source_event_revision_id UUID NOT NULL REFERENCES conversation_event_revisions(conversation_event_revision_id),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  generation_command_id UUID NOT NULL REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL REFERENCES model_run_attempts(model_run_attempt_id),
  status TEXT NOT NULL CHECK (
    status IN (
      'settled', 'stale_source', 'fenced', 'retryable_failed', 'failed'
    )
  ),
  outcome_detail TEXT,
  formed_count INTEGER NOT NULL DEFAULT 0 CHECK (formed_count >= 0),
  closed_count INTEGER NOT NULL DEFAULT 0 CHECK (closed_count >= 0),
  suppressed_count INTEGER NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, source_event_revision_id, policy_version)
);

CREATE INDEX open_loop_run_outcomes_pending_idx
  ON open_loop_run_outcomes(user_id, source_event_revision_id)
  WHERE status IN ('retryable_failed', 'failed');

-- Idempotent expiry ledger: (loop, expiring version, policy) is the identity;
-- terminal_effective_at is the original expires_at, processed_at is the
-- actual commit time. The scanner never creates GenerationCommands.
CREATE TABLE open_loop_expiry_runs (
  open_loop_expiry_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  open_loop_id UUID NOT NULL REFERENCES open_loops(open_loop_id),
  expiring_version_id UUID NOT NULL REFERENCES open_loop_versions(open_loop_version_id),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  terminal_effective_at TIMESTAMPTZ NOT NULL,
  terminal_processed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (open_loop_id, expiring_version_id, policy_version)
);

CREATE INDEX open_loop_expiry_runs_user_idx
  ON open_loop_expiry_runs(user_id, terminal_processed_at);

-- The per-Event formation/closure path and the expiry scanner admit through
-- the shared workflow/outbox seam. The expiry command carries the stable
-- (loop, version, policy) idempotency key.
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
      'candidate_remap', 'predicate_registry_release',
      'reflection_daily', 'reflection_weekly', 'reflection_maintenance',
      'open_loop_expiry'
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
      'predicate_registry_released', 'candidate_remap_requested',
      'reflection_daily_requested', 'reflection_weekly_requested',
      'reflection_maintenance_requested', 'open_loop_expiry_requested'
    )
  );
