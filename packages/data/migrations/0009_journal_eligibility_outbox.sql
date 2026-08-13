-- 1A.2 / issue #18: Journal Eligibility durability foundation.
-- Introduces the versioned eligibility policy, the WorkflowCommand + transactional
-- outbox that carry eligibility (IDs/revisions/policy only — never conversation
-- text), and the daily date-outcome projection. Follows the immutable-trigger and
-- versioned-policy pattern established by 0005_continuous_exchange_end.sql.

CREATE TABLE journal_eligibility_policies (
  policy_version TEXT PRIMARY KEY,
  minimum_substantive_expression_length INTEGER NOT NULL
    CHECK (minimum_substantive_expression_length > 0),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO journal_eligibility_policies (
  policy_version,
  minimum_substantive_expression_length,
  created_at
)
VALUES (
  'journal-eligibility:v1',
  20,
  CURRENT_TIMESTAMP
);

CREATE FUNCTION reject_journal_eligibility_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Journal eligibility policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER journal_eligibility_policies_immutable
BEFORE UPDATE OR DELETE ON journal_eligibility_policies
FOR EACH ROW
EXECUTE FUNCTION reject_journal_eligibility_policy_mutation();

-- WorkflowCommand: the stable idempotency key absorbs duplicate explicit-end +
-- due-scan dispatch for the same Daily Session source revision and policy
-- version (architecture 13.2, issue AC #1 and #7).
CREATE TABLE workflow_commands (
  workflow_command_id UUID PRIMARY KEY,
  command_type TEXT NOT NULL
    CHECK (command_type IN ('journal_eligibility')),
  subject_type TEXT NOT NULL
    CHECK (subject_type IN ('daily_session')),
  subject_id UUID NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  policy_version TEXT NOT NULL,
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'dispatched', 'completed', 'dead_lettered')),
  created_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  UNIQUE (
    command_type,
    subject_type,
    subject_id,
    source_revision,
    policy_version
  ),
  FOREIGN KEY (subject_id)
    REFERENCES daily_sessions(daily_session_id)
);

-- Outbox event: leased with FOR UPDATE SKIP LOCKED, started outside the claiming
-- transaction, receipt-recorded, expired leases reclaimable (architecture 13.3).
-- payload is JSONB but may only ever hold IDs/revisions/policy/event-kind/status
-- and allowlisted error codes — enforced by the safeWorkflowStep wrapper and the
-- canary system test, never conversation text or rendered Prompt content.
CREATE TABLE outbox_events (
  outbox_event_id UUID PRIMARY KEY,
  workflow_command_id UUID NOT NULL
    REFERENCES workflow_commands(workflow_command_id),
  aggregate_type TEXT NOT NULL
    CHECK (aggregate_type IN ('daily_session')),
  aggregate_id UUID NOT NULL,
  aggregate_revision BIGINT NOT NULL CHECK (aggregate_revision >= 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('journal_eligibility_requested')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'dispatched', 'dead_lettered')),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  workflow_receipt_id TEXT,
  last_error_code TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status = 'pending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('leased', 'dispatched')
        AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL)
    OR status = 'dead_lettered'
  )
);

CREATE INDEX outbox_events_pending_due_idx
  ON outbox_events(next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX outbox_events_leased_expires_idx
  ON outbox_events(lease_expires_at)
  WHERE status = 'leased';

CREATE UNIQUE INDEX outbox_events_one_per_aggregate_event_idx
  ON outbox_events(aggregate_type, aggregate_id, aggregate_revision, event_type);

-- Daily date outcome: one row per Daily Session. The UNIQUE on daily_session_id
-- absorbs duplicate Workflow runs so the eligibility entrypoint converges to a
-- single business outcome (issue AC #7, architecture 13.3).
CREATE TABLE daily_session_date_outcomes (
  daily_session_id UUID PRIMARY KEY
    REFERENCES daily_sessions(daily_session_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  logical_date DATE NOT NULL,
  outcome TEXT NOT NULL
    CHECK (
      outcome IN ('no_activity', 'insufficient_expression', 'eligible_queued')
    ),
  eligibility_policy_version TEXT NOT NULL
    REFERENCES journal_eligibility_policies(policy_version),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  workflow_receipt_id TEXT,
  computed_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id)
);
