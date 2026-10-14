-- #320: independent, versioned operator governance for the history-recall
-- path (controlled read-only history review and its History Answer stage).
--
-- It follows the recent-context governance pattern (0070, #295): an immutable,
-- content-free identity that the Decision checks before offering the function,
-- that admission freezes on the result, and that the dispatch / first-token /
-- result / commit fences re-check under a row lock. Disabling revokes the one
-- active row; re-enabling inserts a brand-new version, so a revoked version
-- can never be resurrected and a result frozen under it stays unusable.
--
-- Content-free by construction and carries no `user_id`: it is global operator
-- configuration, not an owner-scoped private data surface, so it is outside
-- the owner Full Purge Surface Registry (ADR-0131), exactly like
-- `recent_context_policies`.

CREATE TABLE history_recall_policies (
  policy_version TEXT PRIMARY KEY CHECK (policy_version <> ''),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  -- The budget / reading identity the path was enabled under
  -- (`HISTORY_RECALL_DEFAULT_POLICY.version`). A real change produces a new
  -- immutable version instead of editing an existing one.
  history_policy_version TEXT NOT NULL CHECK (history_policy_version <> ''),
  harness_policy_version TEXT NOT NULL CHECK (harness_policy_version <> ''),
  compiler_version TEXT NOT NULL CHECK (compiler_version <> ''),
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

CREATE UNIQUE INDEX history_recall_policies_one_active_idx
  ON history_recall_policies(status)
  WHERE status = 'active';

-- The governance identity a result was admitted under. NULL only for results
-- written before this governance existed (replay stays as it was).
ALTER TABLE history_recall_results
  ADD COLUMN governance_policy_version TEXT
    CHECK (governance_policy_version IS NULL OR governance_policy_version <> '');
