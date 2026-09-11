-- 1A.3b G1 / issue #203.
--
-- An active role pin is only usable when it is bound to the exact
-- content-addressed release manifest that opened the stage. Existing revoked
-- or pre-release rows remain nullable so the migration does not invent a
-- release identity for historical data; G1 admission and dispatch reject an
-- active row without this binding.

ALTER TABLE model_role_rollout_pins
  ADD COLUMN release_fingerprint TEXT;

ALTER TABLE model_role_rollout_pins
  ADD CONSTRAINT model_role_rollout_pins_release_fingerprint_check
  CHECK (
    release_fingerprint IS NULL
    OR release_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  );
