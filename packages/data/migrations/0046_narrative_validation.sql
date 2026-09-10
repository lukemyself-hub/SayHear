-- 1A.3b A2 / issue #198.
--
-- Shared narrative validator: a frozen, immutable validation request ledger
-- plus one typed result per request. The `narrative.validate` model role
-- (ADR-0121) consumes the shared generation_commands / model_run_attempts
-- ledger added by 0044; each publishable draft is validated by its own
-- GenerationCommand with at most one same-model technical retry (ADR-0133).
--
-- This migration adds the validator's own command/result surfaces only. It
-- does not seed a provider, model, or active rollout pin, and it does not own
-- a Reflection / Bio publish pointer: producers read the typed result through
-- the application read contract and keep their own commit fences (ADR-0132).
--
-- Retention follows ADR-0130: request draft text, frozen manifests, and the
-- typed findings are validation content for uncommitted drafts; they are
-- refused at read time after the frozen 7-day window and cleared to a
-- content-free envelope. Every table here is registered in the Purge Surface
-- Registry in the same change (ADR-0131).

CREATE TABLE narrative_validator_requests (
  narrative_validator_request_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('bio', 'reflection')),
  draft_ref TEXT NOT NULL CHECK (draft_ref <> '' AND length(draft_ref) <= 512),
  draft_locale TEXT,
  draft_text TEXT,
  generator_manifest JSONB,
  source_manifest JSONB,
  planned_coverage JSONB,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint <> ''),
  validation_policy_version TEXT NOT NULL CHECK (validation_policy_version <> ''),
  prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
  schema_version TEXT NOT NULL CHECK (schema_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (user_id, artifact_kind, draft_ref)
);

CREATE INDEX narrative_validator_requests_owner_idx
  ON narrative_validator_requests (user_id, created_at);

CREATE FUNCTION enforce_narrative_request_immutability() RETURNS trigger
AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged narrative validation request rows are immutable';
  END IF;
  IF NEW.draft_text IS DISTINCT FROM OLD.draft_text
    AND NOT (OLD.draft_text IS NOT NULL AND NEW.draft_text IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation request draft text is immutable until expiry purge';
  END IF;
  IF NEW.generator_manifest IS DISTINCT FROM OLD.generator_manifest
    AND NOT (OLD.generator_manifest IS NOT NULL AND NEW.generator_manifest IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation request generator manifest is immutable until expiry purge';
  END IF;
  IF NEW.source_manifest IS DISTINCT FROM OLD.source_manifest
    AND NOT (OLD.source_manifest IS NOT NULL AND NEW.source_manifest IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation request source manifest is immutable until expiry purge';
  END IF;
  IF NEW.planned_coverage IS DISTINCT FROM OLD.planned_coverage
    AND NOT (OLD.planned_coverage IS NOT NULL AND NEW.planned_coverage IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation request planned coverage is immutable until expiry purge';
  END IF;
  IF (NEW.draft_text IS NULL) <> (NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation request text purge must match content_purged_at';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER narrative_validator_requests_immutability
  BEFORE UPDATE ON narrative_validator_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_narrative_request_immutability();

CREATE TABLE narrative_validator_results (
  narrative_validator_result_id UUID PRIMARY KEY,
  narrative_validator_request_id UUID NOT NULL
    REFERENCES narrative_validator_requests(narrative_validator_request_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  generation_command_id UUID NOT NULL REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL REFERENCES model_run_attempts(model_run_attempt_id),
  verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'blocked')),
  blocking_findings JSONB,
  advisory_findings JSONB,
  coverage JSONB,
  validation_policy_version TEXT NOT NULL CHECK (validation_policy_version <> ''),
  schema_version TEXT NOT NULL CHECK (schema_version <> ''),
  prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (narrative_validator_request_id)
);

CREATE INDEX narrative_validator_results_owner_idx
  ON narrative_validator_results (user_id, created_at);

CREATE FUNCTION enforce_narrative_result_immutability() RETURNS trigger
AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged narrative validation result rows are immutable';
  END IF;
  IF NEW.blocking_findings IS DISTINCT FROM OLD.blocking_findings
    AND NOT (OLD.blocking_findings IS NOT NULL AND NEW.blocking_findings IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation result findings are immutable until expiry purge';
  END IF;
  IF NEW.advisory_findings IS DISTINCT FROM OLD.advisory_findings
    AND NOT (OLD.advisory_findings IS NOT NULL AND NEW.advisory_findings IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation result advisory findings are immutable until expiry purge';
  END IF;
  IF NEW.coverage IS DISTINCT FROM OLD.coverage
    AND NOT (OLD.coverage IS NOT NULL AND NEW.coverage IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation result coverage is immutable until expiry purge';
  END IF;
  IF (NEW.blocking_findings IS NULL) <> (NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'narrative validation result findings purge must match content_purged_at';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER narrative_validator_results_immutability
  BEFORE UPDATE ON narrative_validator_results
  FOR EACH ROW EXECUTE FUNCTION enforce_narrative_result_immutability();
