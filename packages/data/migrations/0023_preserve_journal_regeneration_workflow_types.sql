-- Issue #29: repair schemas where the previously released owner-purge
-- migration rebuilt these shared type constraints without the already-admitted
-- Journal regeneration values. The corrected original migration covers fresh
-- and partially upgraded schemas; this forward migration repairs schemas that
-- have already recorded the older migration as applied.

ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check,
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN (
      'journal_eligibility',
      'rolling_summary',
      'dialogue_state',
      'journal_regeneration',
      'owner_full_purge'
    ));

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check,
  ADD CONSTRAINT outbox_events_event_type_check
    CHECK (event_type IN (
      'journal_eligibility_requested',
      'rolling_summary_requested',
      'dialogue_state_requested',
      'journal_regeneration_requested',
      'owner_full_purge_requested'
    ));
