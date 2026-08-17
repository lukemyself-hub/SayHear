-- 1A.2 / issue #27: operator-only Internal Owner Full Purge.
--
-- Introduces the purge order state machine (the 1A.2 subset of architecture
-- 20.2: requested -> access_revoked -> propagating -> verifying ->
-- active_system_deleted -> retention_pending, plus needs_attention), one
-- content-free receipt row per destination, and the "purge pass" upgrade of
-- the 0010/0011/0005 immutability triggers.
--
-- The purge pass keeps normal-path immutability absolute: a trigger only
-- accepts DELETE when the current transaction set sayhear.purge_pass (via
-- set_config(..., true)) to the id of a purge order that exists in this
-- database and is still in progress. There is no DISABLE TRIGGER and no
-- privileged bypass.

CREATE TABLE owner_purge_orders (
  owner_purge_order_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  -- Idempotency key: the epoch the owner was purged FROM. A duplicate start
  -- while this order is in flight converges to it; a new purge after owner
  -- revival starts from the advanced epoch and creates a distinct order.
  from_data_epoch BIGINT NOT NULL CHECK (from_data_epoch > 0),
  -- The deletion epoch written to app_users.data_epoch by the opening
  -- transaction. In-flight work frozen at any lower epoch fails closed.
  data_epoch BIGINT NOT NULL CHECK (data_epoch > from_data_epoch),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (
      status IN (
        'requested',
        'access_revoked',
        'propagating',
        'verifying',
        'active_system_deleted',
        'retention_pending',
        'needs_attention'
      )
    ),
  confirmation TEXT NOT NULL CHECK (confirmation = 'PURGE'),
  policy_version TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  access_revoked_at TIMESTAMPTZ,
  propagating_at TIMESTAMPTZ,
  verifying_at TIMESTAMPTZ,
  active_system_deleted_at TIMESTAMPTZ,
  retention_pending_at TIMESTAMPTZ,
  needs_attention_at TIMESTAMPTZ,
  needs_attention_reason TEXT,
  backup_retention_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  UNIQUE (user_id, from_data_epoch)
);

CREATE INDEX owner_purge_orders_pending_scan_idx
  ON owner_purge_orders(last_attempt_at)
  WHERE status <> 'retention_pending';

-- One content-free receipt per destination (architecture 20.3). Receipt rows
-- never carry user content, row counts, or provider request bodies — only the
-- destination identity, disposition and retention horizons.
CREATE TABLE owner_purge_receipts (
  owner_purge_receipt_id UUID PRIMARY KEY,
  owner_purge_order_id UUID NOT NULL
    REFERENCES owner_purge_orders(owner_purge_order_id),
  destination TEXT NOT NULL
    CHECK (
      destination = 'business_database'
      OR destination = 'purge_marker_store'
      OR destination LIKE 'provider:%'
    ),
  destination_disposition TEXT NOT NULL
    CHECK (
      destination_disposition IN (
        'verified_deleted',
        'retention_pending',
        'not_applicable',
        'unknown'
      )
    ),
  provider_disposition TEXT
    CHECK (
      provider_disposition IS NULL
      OR provider_disposition IN ('retention_pending', 'unknown')
    ),
  provider_retention_until TIMESTAMPTZ,
  backup_retention_until TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_purge_order_id, destination)
);

-- Purge-pass helper: TRUE only inside a transaction that flagged an in-progress
-- purge order existing in this same database. Terminal orders (retention_
-- pending) and the pre-fence 'requested' state never authorize destructive
-- passes; the opening transaction itself must not clear content.
CREATE FUNCTION sayhear_purge_pass_active()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  flag TEXT;
  order_id UUID;
BEGIN
  flag := current_setting('sayhear.purge_pass', true);
  IF flag IS NULL OR flag = '' THEN
    RETURN FALSE;
  END IF;
  BEGIN
    order_id := flag::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN FALSE;
  END;
  RETURN EXISTS (
    SELECT 1
    FROM owner_purge_orders
    WHERE owner_purge_order_id = order_id
      AND status IN ('access_revoked', 'propagating', 'verifying', 'needs_attention')
  );
END;
$$;

-- 0010 evidence immutability, upgraded with the purge pass: normal-path
-- UPDATE/DELETE stays absolute; DELETE is allowed only under a verified pass.
CREATE OR REPLACE FUNCTION reject_evidence_item_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'EvidenceItem is immutable' USING ERRCODE = '55000';
END;
$$;

-- 0011 journal artifact immutability, upgraded with the same purge pass.
CREATE OR REPLACE FUNCTION reject_journal_artifact_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Published Journal artifacts are immutable' USING ERRCODE = '55000';
END;
$$;

-- 0005 inactivity evaluation snapshots, upgraded with the same purge pass.
CREATE OR REPLACE FUNCTION enforce_inactivity_evaluation_snapshot_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;
  IF
    NEW.inactivity_evaluation_id IS DISTINCT FROM OLD.inactivity_evaluation_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.daily_session_id IS DISTINCT FROM OLD.daily_session_id
    OR NEW.continuous_exchange_no IS DISTINCT FROM OLD.continuous_exchange_no
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.expected_dialogue_revision IS DISTINCT
      FROM OLD.expected_dialogue_revision
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Inactivity evaluation snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

-- The purge command travels through the existing workflow_commands/outbox
-- surface. The subject of a purge is the Internal Owner (app_user), so the
-- daily_sessions foreign key on workflow_commands.subject_id must go: the
-- column is polymorphic on subject_type and Phase 1 application code plus
-- reconciliation own consistency for the single-owner purge path.
ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_subject_id_fkey;

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (command_type IN (
    'journal_eligibility', 'rolling_summary', 'dialogue_state',
    'journal_regeneration', 'owner_full_purge'
  ));

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_subject_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_subject_type_check
  CHECK (subject_type IN ('daily_session', 'app_user'));

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_status_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_status_check
  CHECK (status IN ('created', 'dispatched', 'completed', 'dead_lettered', 'cancelled'));

ALTER TABLE workflow_commands
  ADD COLUMN cancelled_reason TEXT
  CHECK (cancelled_reason IS NULL OR cancelled_reason IN ('owner_purged'));

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_cancelled_shape_check
  CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL);

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'journal_eligibility_requested', 'rolling_summary_requested',
    'dialogue_state_requested', 'journal_regeneration_requested',
    'owner_full_purge_requested'
  ));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('daily_session', 'app_user'));

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_status_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_check
  CHECK (status IN ('pending', 'leased', 'dispatched', 'dead_lettered', 'cancelled'));

ALTER TABLE outbox_events
  ADD COLUMN cancelled_reason TEXT
  CHECK (cancelled_reason IS NULL OR cancelled_reason IN ('owner_purged'));

-- Replace the unnamed status/lease consistency CHECK (auto-named
-- outbox_events_check) so a cancelled row is lease-free and reasoned.
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT conname::TEXT INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'outbox_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%dead_lettered%'
    AND conname LIKE 'outbox_events_check%';
  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outbox_events DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_shape_check
  CHECK (
    (status = 'pending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('leased', 'dispatched')
        AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL)
    OR status = 'dead_lettered'
    OR (status = 'cancelled'
        AND cancelled_reason IS NOT NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL)
  );

-- conversation_events are hard-deleted by the purge while their revisions stay
-- behind as content-free tombstoned envelopes (content_purged_at, empty text).
-- That outliving is intentional (architecture 20.4/20.5: the tombstone proves
-- the purge and blocks old-task resurrection), so the revisions->events
-- foreign key must not enforce event survival. Normal operation never deletes
-- conversation_events, so nothing else regresses.
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT conname::TEXT INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'conversation_event_revisions'::regclass
    AND contype = 'f'
    AND pg_get_constraintdef(oid) LIKE '%REFERENCES conversation_events%';
  IF old_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE conversation_event_revisions DROP CONSTRAINT %I',
      old_constraint
    );
  END IF;
END $$;
