-- 1A.3a / #120: whole-Claim and Relationship-Qualifier Forget/Reversal.
--
-- A qualifier is a typed target, not a predicate selector. The target kind is
-- carried by the compiler-minted handle and by the admission-time resolved
-- reference; scope is never a model-facing enum. Old evidence exclusions stay
-- active after Reversal, so only the new reversal event can support the new
-- ClaimVersion.

-- ---------------------------------------------------------------------------
-- 1. Persist the exact qualifier selected by a Forget request.
-- ---------------------------------------------------------------------------

ALTER TABLE memory_forget_requests
  ADD COLUMN target_qualifier_id UUID;

ALTER TABLE memory_forget_requests
  ADD CONSTRAINT memory_forget_requests_qualifier_fk
    FOREIGN KEY (target_qualifier_id, user_id)
    REFERENCES memory_claim_version_qualifiers(
      memory_claim_version_qualifier_id, user_id
    );

ALTER TABLE memory_forget_requests
  ADD CONSTRAINT memory_forget_requests_qualifier_target_check CHECK (
    (target_scope = 'relationship_qualifier') =
      (target_qualifier_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. Allow compiler-minted Claim and Qualifier handles.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_action_handles
  ALTER COLUMN target_id DROP NOT NULL,
  ALTER COLUMN target_version_id DROP NOT NULL;

ALTER TABLE conversation_action_handles
  DROP CONSTRAINT IF EXISTS conversation_action_handles_target_id_fkey,
  DROP CONSTRAINT IF EXISTS conversation_action_handles_target_version_id_fkey;

ALTER TABLE conversation_action_handles
  ADD COLUMN target_claim_id UUID,
  ADD COLUMN target_claim_version_id UUID,
  ADD COLUMN target_qualifier_id UUID;

ALTER TABLE conversation_action_handles
  ADD CONSTRAINT conversation_action_handles_target_id_fkey
    FOREIGN KEY (target_id) REFERENCES journals(journal_id),
  ADD CONSTRAINT conversation_action_handles_target_version_id_fkey
    FOREIGN KEY (target_version_id) REFERENCES journal_versions(journal_version_id),
  ADD CONSTRAINT conversation_action_handles_target_claim_id_fkey
    FOREIGN KEY (target_claim_id, user_id)
    REFERENCES memory_claims(memory_claim_id, user_id),
  ADD CONSTRAINT conversation_action_handles_target_claim_version_id_fkey
    FOREIGN KEY (target_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id),
  ADD CONSTRAINT conversation_action_handles_target_qualifier_id_fkey
    FOREIGN KEY (target_qualifier_id, user_id)
    REFERENCES memory_claim_version_qualifiers(
      memory_claim_version_qualifier_id, user_id
    );

ALTER TABLE conversation_action_handles
  DROP CONSTRAINT conversation_action_handles_target_kind_check;
ALTER TABLE conversation_action_handles
  ADD CONSTRAINT conversation_action_handles_target_kind_check
    CHECK (
      target_kind IN ('journal', 'memory_claim', 'relationship_qualifier')
    );

ALTER TABLE conversation_action_handles
  ADD CONSTRAINT conversation_action_handles_target_shape_check CHECK (
    (
      target_kind = 'journal'
      AND target_id IS NOT NULL
      AND target_version_id IS NOT NULL
      AND target_claim_id IS NULL
      AND target_claim_version_id IS NULL
      AND target_qualifier_id IS NULL
    )
    OR (
      target_kind = 'memory_claim'
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_claim_id IS NOT NULL
      AND target_claim_version_id IS NOT NULL
      AND target_qualifier_id IS NULL
    )
    OR (
      target_kind = 'relationship_qualifier'
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_claim_id IS NOT NULL
      AND target_claim_version_id IS NOT NULL
      AND target_qualifier_id IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Record a typed qualifier target on Trust Action executions/receipts.
-- ---------------------------------------------------------------------------

ALTER TABLE conversation_action_executions
  ADD COLUMN resolved_qualifier_id UUID;

ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_resolved_qualifier_fkey
    FOREIGN KEY (resolved_qualifier_id, user_id)
    REFERENCES memory_claim_version_qualifiers(
      memory_claim_version_qualifier_id, user_id
    );

ALTER TABLE conversation_action_executions
  DROP CONSTRAINT conversation_action_executions_target_kind_check,
  DROP CONSTRAINT conversation_action_executions_target_shape_check;

ALTER TABLE conversation_action_executions
  ADD CONSTRAINT conversation_action_executions_target_kind_check
    CHECK (
      target_kind IS NULL
      OR target_kind IN ('journal', 'memory_claim', 'relationship_qualifier')
    ),
  ADD CONSTRAINT conversation_action_executions_target_shape_check CHECK (
    (
      target_kind = 'memory_claim'
      AND resolved_claim_id IS NOT NULL
      AND resolved_claim_version_id IS NOT NULL
      AND resolved_qualifier_id IS NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_handle IS NULL
    )
    OR (
      target_kind = 'relationship_qualifier'
      AND resolved_claim_id IS NOT NULL
      AND resolved_claim_version_id IS NOT NULL
      AND resolved_qualifier_id IS NOT NULL
      AND target_id IS NULL
      AND target_version_id IS NULL
      AND target_handle IS NULL
    )
    OR (
      target_kind IS NULL
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
      AND resolved_qualifier_id IS NULL
    )
    OR (
      target_kind = 'journal'
      AND resolved_claim_id IS NULL
      AND resolved_claim_version_id IS NULL
      AND resolved_qualifier_id IS NULL
    )
  );

ALTER TABLE conversation_action_receipts
  ADD COLUMN resolved_qualifier_id UUID
    REFERENCES memory_claim_version_qualifiers(memory_claim_version_qualifier_id);
