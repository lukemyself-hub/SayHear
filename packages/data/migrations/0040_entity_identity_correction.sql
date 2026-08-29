-- 1A.3a / #121: user-corrected Entity merge, split, and promotion.
--
-- Identity surgery is the only path that may advance an Entity identity. The
-- admission transaction records typed Entity / EntityVersion references,
-- suspends dependent Claims, and creates a targeted Journal identity fence.
-- The reverse-lineage revalidation is an idempotent workflow command; this
-- migration stores its durable identity without storing user prose.

-- ---------------------------------------------------------------------------
-- 1. Typed identity targets on Action executions and Receipts.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_action_executions
  ADD COLUMN resolved_entity_id UUID,
  ADD COLUMN resolved_entity_version_id UUID,
  ADD COLUMN resolved_related_entity_id UUID,
  ADD COLUMN resolved_related_entity_version_id UUID,
  ADD COLUMN entity_identity_operation TEXT;

ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_resolved_entity_fkey
    FOREIGN KEY (resolved_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  ADD CONSTRAINT conversation_action_executions_resolved_entity_version_fkey
    FOREIGN KEY (resolved_entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id),
  ADD CONSTRAINT conversation_action_executions_resolved_related_entity_fkey
    FOREIGN KEY (resolved_related_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  ADD CONSTRAINT conversation_action_executions_resolved_related_entity_version_fkey
    FOREIGN KEY (resolved_related_entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id);

ALTER TABLE conversation_action_executions
  DROP CONSTRAINT conversation_action_executions_target_kind_check,
  DROP CONSTRAINT conversation_action_executions_target_shape_check;

ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_target_kind_check
    CHECK (
      target_kind IS NULL
      OR target_kind IN (
        'journal', 'memory_claim', 'relationship_qualifier',
        'entity_identity_correction'
      )
    ),
  ADD CONSTRAINT conversation_action_executions_target_shape_check CHECK (
    (
      target_kind = 'entity_identity_correction'
      AND target_handle IS NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND daily_session_id IS NULL
      AND source_revision IS NULL
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
      AND resolved_qualifier_id IS NULL
      AND resolved_entity_id IS NOT NULL
      AND resolved_entity_version_id IS NOT NULL
      AND entity_identity_operation IN ('merge', 'split', 'promote')
      AND (
        (
          entity_identity_operation = 'merge'
          AND resolved_related_entity_id IS NOT NULL
          AND resolved_related_entity_version_id IS NOT NULL
        )
        OR (
          entity_identity_operation IN ('split', 'promote')
          AND resolved_related_entity_id IS NULL
          AND resolved_related_entity_version_id IS NULL
        )
      )
    )
    OR (
      target_kind = 'memory_claim'
      AND resolved_claim_id IS NOT NULL
      AND resolved_claim_version_id IS NOT NULL
      AND resolved_qualifier_id IS NULL
      AND resolved_entity_id IS NULL
      AND resolved_entity_version_id IS NULL
      AND resolved_related_entity_id IS NULL
      AND resolved_related_entity_version_id IS NULL
      AND entity_identity_operation IS NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_handle IS NULL
    )
    OR (
      target_kind = 'relationship_qualifier'
      AND resolved_claim_id IS NOT NULL
      AND resolved_claim_version_id IS NOT NULL
      AND resolved_qualifier_id IS NOT NULL
      AND resolved_entity_id IS NULL
      AND resolved_entity_version_id IS NULL
      AND resolved_related_entity_id IS NULL
      AND resolved_related_entity_version_id IS NULL
      AND entity_identity_operation IS NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_handle IS NULL
    )
    OR (
      target_kind IS NULL
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
      AND resolved_qualifier_id IS NULL
      AND resolved_entity_id IS NULL
      AND resolved_entity_version_id IS NULL
      AND resolved_related_entity_id IS NULL
      AND resolved_related_entity_version_id IS NULL
      AND entity_identity_operation IS NULL
    )
    OR (
      target_kind = 'journal'
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
      AND resolved_qualifier_id IS NULL
      AND resolved_entity_id IS NULL
      AND resolved_entity_version_id IS NULL
      AND resolved_related_entity_id IS NULL
      AND resolved_related_entity_version_id IS NULL
      AND entity_identity_operation IS NULL
    )
  );

ALTER TABLE conversation_action_receipts
  ADD COLUMN resolved_entity_id UUID,
  ADD COLUMN resolved_entity_version_id UUID,
  ADD COLUMN resolved_related_entity_id UUID,
  ADD COLUMN resolved_related_entity_version_id UUID,
  ADD COLUMN entity_identity_operation TEXT,
  ADD CONSTRAINT conversation_action_receipts_resolved_entity_fkey
    FOREIGN KEY (resolved_entity_id) REFERENCES entities(entity_id),
  ADD CONSTRAINT conversation_action_receipts_resolved_entity_version_fkey
    FOREIGN KEY (resolved_entity_version_id) REFERENCES entity_versions(entity_version_id),
  ADD CONSTRAINT conversation_action_receipts_resolved_related_entity_fkey
    FOREIGN KEY (resolved_related_entity_id) REFERENCES entities(entity_id),
  ADD CONSTRAINT conversation_action_receipts_resolved_related_entity_version_fkey
    FOREIGN KEY (resolved_related_entity_version_id)
    REFERENCES entity_versions(entity_version_id),
  ADD CONSTRAINT conversation_action_receipts_identity_target_shape_check CHECK (
    (
      entity_identity_operation IS NULL
      AND resolved_entity_id IS NULL
      AND resolved_entity_version_id IS NULL
      AND resolved_related_entity_id IS NULL
      AND resolved_related_entity_version_id IS NULL
    )
    OR (
      entity_identity_operation IN ('merge', 'split', 'promote')
      AND resolved_entity_id IS NOT NULL
      AND resolved_entity_version_id IS NOT NULL
      AND (
        (
          entity_identity_operation = 'merge'
          AND resolved_related_entity_id IS NOT NULL
          AND resolved_related_entity_version_id IS NOT NULL
        )
        OR (
          entity_identity_operation IN ('split', 'promote')
          AND resolved_related_entity_id IS NULL
          AND resolved_related_entity_version_id IS NULL
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Identity correction audit and targeted reverse-lineage fences.
-- ---------------------------------------------------------------------------

CREATE TABLE entity_identity_corrections (
  entity_identity_correction_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  action_execution_id UUID NOT NULL UNIQUE
    REFERENCES conversation_action_executions(action_execution_id),
  request_event_revision_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('merge', 'split', 'promote')),
  source_entity_id UUID NOT NULL,
  source_entity_version_id UUID NOT NULL,
  related_entity_id UUID,
  related_entity_version_id UUID,
  created_entity_id UUID,
  created_entity_version_id UUID,
  promotion_explicit_statement BOOLEAN NOT NULL DEFAULT FALSE,
  promotion_independent_revision_count INTEGER NOT NULL DEFAULT 0
    CHECK (promotion_independent_revision_count >= 0),
  correction_policy_version TEXT NOT NULL CHECK (correction_policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (source_entity_version_id, source_entity_id, user_id)
    REFERENCES entity_versions(entity_version_id, entity_id, user_id),
  FOREIGN KEY (related_entity_version_id, related_entity_id, user_id)
    REFERENCES entity_versions(entity_version_id, entity_id, user_id),
  FOREIGN KEY (created_entity_version_id, created_entity_id, user_id)
    REFERENCES entity_versions(entity_version_id, entity_id, user_id),
  FOREIGN KEY (source_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (related_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (created_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  CHECK (
    (
      operation = 'merge'
      AND related_entity_id IS NOT NULL
      AND related_entity_version_id IS NOT NULL
      AND created_entity_id IS NULL
      AND created_entity_version_id IS NULL
    )
    OR (
      operation = 'split'
      AND related_entity_id IS NULL
      AND related_entity_version_id IS NULL
      AND created_entity_id IS NOT NULL
      AND created_entity_version_id IS NOT NULL
    )
    OR (
      operation = 'promote'
      AND related_entity_id IS NULL
      AND related_entity_version_id IS NULL
      AND created_entity_id IS NULL
      AND created_entity_version_id IS NULL
    )
  )
);

CREATE INDEX entity_identity_corrections_source_idx
  ON entity_identity_corrections(user_id, source_entity_id, created_at);

-- The missing direct Journal EntityVersion link is materialized as part of
-- identity surgery from the existing Evidence lineage. It is typed and
-- owner-scoped, so later diagnostics do not need a full text scan.
CREATE UNIQUE INDEX journal_statements_owner_boundary_idx
  ON journal_statements(journal_statement_id, user_id);

CREATE TABLE journal_statement_entity_links (
  journal_statement_entity_link_id UUID PRIMARY KEY,
  journal_statement_id UUID NOT NULL,
  entity_version_id UUID NOT NULL,
  evidence_item_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  link_role TEXT NOT NULL CHECK (link_role IN ('subject', 'object', 'mention')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (journal_statement_id, entity_version_id, evidence_item_id, link_role),
  FOREIGN KEY (journal_statement_id, user_id)
    REFERENCES journal_statements(journal_statement_id, user_id),
  FOREIGN KEY (entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX journal_statement_entity_links_lookup_idx
  ON journal_statement_entity_links(user_id, entity_version_id);

CREATE TABLE journal_identity_review_fences (
  journal_identity_review_fence_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  action_execution_id UUID NOT NULL
    REFERENCES conversation_action_executions(action_execution_id),
  journal_statement_id UUID NOT NULL REFERENCES journal_statements(journal_statement_id),
  entity_version_id UUID NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  status TEXT NOT NULL
    CHECK (status IN (
      'identity_review_pending', 'no_change', 'correction_required',
      'still_ambiguous', 'corrected'
    )),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (action_execution_id, journal_statement_id, entity_version_id),
  FOREIGN KEY (entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id),
  FOREIGN KEY (journal_statement_id, user_id)
    REFERENCES journal_statements(journal_statement_id, user_id)
);

CREATE INDEX journal_identity_review_fences_pending_idx
  ON journal_identity_review_fences(user_id, status)
  WHERE status = 'identity_review_pending';

CREATE TABLE entity_identity_revalidation_runs (
  entity_identity_revalidation_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  workflow_command_id UUID NOT NULL UNIQUE
    REFERENCES workflow_commands(workflow_command_id),
  action_execution_id UUID NOT NULL UNIQUE
    REFERENCES conversation_action_executions(action_execution_id),
  source_entity_id UUID NOT NULL,
  source_entity_version_id UUID NOT NULL,
  affected_claim_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_claim_count >= 0),
  affected_journal_statement_count INTEGER NOT NULL DEFAULT 0
    CHECK (affected_journal_statement_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (source_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (source_entity_version_id, source_entity_id, user_id)
    REFERENCES entity_versions(entity_version_id, entity_id, user_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- 3. Async workflow vocabulary.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_command_type_check,
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'owner_full_purge', 'journal_regeneration', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup', 'entity_identity_revalidation'
    )),
  DROP CONSTRAINT workflow_commands_subject_type_check,
  ADD CONSTRAINT workflow_commands_subject_type_check
    CHECK (subject_type IN (
      'daily_session', 'app_user', 'conversation_event_revision',
      'memory_claim', 'entity'
    ));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_event_type_check,
  ADD CONSTRAINT outbox_events_event_type_check
    CHECK (event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'owner_full_purge_requested',
      'journal_regeneration_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested', 'memory_correction_followup_requested',
      'entity_identity_revalidation_requested'
    )),
  DROP CONSTRAINT outbox_events_aggregate_type_check,
  ADD CONSTRAINT outbox_events_aggregate_type_check
    CHECK (aggregate_type IN (
      'daily_session', 'app_user', 'conversation_event_revision',
      'memory_claim', 'entity'
    ));
