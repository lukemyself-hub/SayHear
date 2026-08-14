-- Delivery reconciliation can change valid source coverage without changing
-- the Daily Session revision. Keep those derived snapshots idempotent by
-- (revision, coverage) instead of inventing a Conversation freshness bump.
ALTER TABLE dialogue_state_commands
  ADD COLUMN coverage_key BIGINT NOT NULL DEFAULT 0 CHECK (coverage_key >= 0);

ALTER TABLE workflow_commands
  ADD COLUMN coverage_through_sequence_no BIGINT NOT NULL DEFAULT 0
    CHECK (coverage_through_sequence_no >= 0);

ALTER TABLE outbox_events
  ADD COLUMN aggregate_coverage BIGINT NOT NULL DEFAULT 0
    CHECK (aggregate_coverage >= 0);

ALTER TABLE outbox_events
  ADD COLUMN aggregate_data_epoch BIGINT NOT NULL DEFAULT 1
    CHECK (aggregate_data_epoch > 0);

-- Existing rows were written before coverage participated in their idempotency
-- keys. Preserve their actual coverage before replacing those keys.
UPDATE dialogue_state_commands
SET coverage_key = coverage_through_sequence_no;

UPDATE workflow_commands workflow
SET coverage_through_sequence_no = command.coverage_through_sequence_no
FROM dialogue_state_commands command
WHERE workflow.workflow_command_id = command.dialogue_state_command_id
  AND workflow.command_type = 'dialogue_state';

UPDATE outbox_events event
SET aggregate_coverage = workflow.coverage_through_sequence_no,
    aggregate_data_epoch = workflow.expected_data_epoch
FROM workflow_commands workflow
WHERE event.workflow_command_id = workflow.workflow_command_id;

DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT conname::TEXT INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'dialogue_state_commands'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE
      'UNIQUE (daily_session_id, source_revision, dialogue_revision, policy_version)%';
  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE dialogue_state_commands DROP CONSTRAINT %I', old_constraint);
  END IF;

  SELECT conname::TEXT INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'workflow_commands'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE
      'UNIQUE (command_type, subject_type, subject_id, source_revision, policy_version)%';
  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE workflow_commands DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

DROP INDEX IF EXISTS outbox_events_one_per_aggregate_event_idx;

ALTER TABLE dialogue_state_commands
  ADD CONSTRAINT dialogue_state_commands_revision_coverage_key
  UNIQUE (
    daily_session_id, source_revision, dialogue_revision,
    expected_data_epoch, policy_version, coverage_key
  );

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_revision_coverage_key
  UNIQUE (
    command_type, subject_type, subject_id, source_revision,
    expected_data_epoch, policy_version, coverage_through_sequence_no
  );

CREATE UNIQUE INDEX outbox_events_one_per_aggregate_event_idx
  ON outbox_events(
    aggregate_type, aggregate_id, aggregate_revision,
    aggregate_data_epoch, aggregate_coverage, event_type
  );
