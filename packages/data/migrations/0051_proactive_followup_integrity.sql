-- 1A.3b C2 / issue #205 follow-up migration.
--
-- Keep migration 0050 immutable. This forward migration repairs the two
-- deliberate persistence cycles for Full Purge and replaces the original
-- exchange-wide reservation key with the live-row invariant required for
-- retry after an abandoned or released reservation.

ALTER TABLE proactive_followup_states
  ALTER CONSTRAINT proactive_followup_states_current_version_fk
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE proactive_followup_reservations
  DROP CONSTRAINT proactive_followup_reservatio_daily_session_id_user_id_cont_key;

CREATE UNIQUE INDEX proactive_followup_reservations_live_exchange_idx
  ON proactive_followup_reservations(daily_session_id, user_id, continuous_exchange_no)
  WHERE status IN ('active', 'committed');

ALTER TABLE proactive_followup_reservations
  ALTER CONSTRAINT proactive_followup_reservations_committed_use_fk
  DEFERRABLE INITIALLY DEFERRED;
