-- A new immutable workflow policy may legitimately reprocess the same
-- aggregate revision and coverage. Keep same-policy requests idempotent while
-- allowing a replacement policy to publish its own outbox event. Legacy event
-- payloads without policyVersion retain the old one-event-per-aggregate key.
DROP INDEX IF EXISTS outbox_events_one_per_aggregate_event_idx;

CREATE UNIQUE INDEX outbox_events_one_per_aggregate_event_idx
  ON outbox_events(
    aggregate_type,
    aggregate_id,
    aggregate_revision,
    aggregate_data_epoch,
    aggregate_coverage,
    event_type,
    COALESCE(payload->>'policyVersion', '')
  );
