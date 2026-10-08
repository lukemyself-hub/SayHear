-- #295: independent, versioned operator governance for the recent-context path.
--
-- The recent conversation background must be separately disable-able without
-- touching the G1 role pins, the existing conversation / G1 Provider Egress
-- policies, or the user's Correction / Forget / Evidence records. This table
-- is the immutable governance identity the compile freezes and the dispatch /
-- result / commit fence re-checks under a row lock.
--
-- Content-free by construction: it stores only version identities, budget
-- parameters and the operator audit actor. It contains no user content and
-- carries no `user_id`, so it is not an owner-scoped private data surface and
-- is deliberately outside the owner Full Purge Surface Registry (ADR-0131),
-- exactly like the existing global `provider_egress_policy_versions` and
-- `model_role_*` governance tables. Deleting a row is never a product
-- operation: disabling revokes, re-enabling inserts a brand-new version, and a
-- revoked version can never be resurrected.

CREATE TABLE recent_context_policies (
  policy_version TEXT PRIMARY KEY CHECK (policy_version <> ''),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  -- The compiler / selector / selection-read identities the path was enabled
  -- under. A real change produces a new immutable version instead of editing
  -- an existing one.
  compiler_version TEXT NOT NULL CHECK (compiler_version <> ''),
  selector_policy_version TEXT NOT NULL CHECK (selector_policy_version <> ''),
  selection_policy_version TEXT NOT NULL CHECK (selection_policy_version <> ''),
  -- The versioned read / selection parameters actually enabled.
  budget_tokens INTEGER NOT NULL CHECK (budget_tokens > 0),
  max_candidate_rows INTEGER NOT NULL CHECK (max_candidate_rows > 0),
  max_candidate_bytes INTEGER NOT NULL CHECK (max_candidate_bytes > 0),
  max_single_event_tokens INTEGER NOT NULL CHECK (max_single_event_tokens > 0),
  read_timeout_ms INTEGER NOT NULL CHECK (read_timeout_ms > 0),
  -- `changed_by` is the enable actor, write-once. Revocation records its own
  -- actor in `revoked_by` and never overwrites who enabled the version.
  changed_by TEXT NOT NULL CHECK (changed_by <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
    OR (
      status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_by IS NOT NULL
      AND revoked_by <> ''
    )
  )
);

-- At most one active governance identity. Revoked versions stay as immutable
-- history; flipping the single active row off and inserting a new one is the
-- only supported transition, so an old in-flight selection can never regain
-- authorization through a resurrected version.
CREATE UNIQUE INDEX recent_context_policies_one_active_idx
  ON recent_context_policies(status)
  WHERE status = 'active';
