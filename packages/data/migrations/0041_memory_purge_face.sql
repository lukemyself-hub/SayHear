-- 1A.3a / issue #123: complete the owner Full Purge data face. ClaimVersion
-- and Relationship Qualifier rows retain only content-free history envelopes;
-- retrieval run/candidate rows are rebuildable Inspector observations and may
-- be removed by the existing transaction-local purge pass.

-- Claim and qualifier typed values are content, not audit identity. The purge
-- face clears them to NULL while retaining the immutable identity, revision,
-- status, and purge timestamp needed to fence old work and prove deletion.
ALTER TABLE memory_claim_versions
  ALTER COLUMN typed_value DROP NOT NULL;
ALTER TABLE memory_claim_version_qualifiers
  ALTER COLUMN typed_value DROP NOT NULL;

-- Temporarily remove the pre-1A.3a triggers so an interrupted rollout can
-- normalize already-marked rows before the replacement immutability rules are
-- installed. The triggers are recreated below in the same migration.
DROP TRIGGER IF EXISTS memory_claim_versions_immutable ON memory_claim_versions;
DROP TRIGGER IF EXISTS memory_claim_version_qualifiers_immutable
  ON memory_claim_version_qualifiers;

-- The original EntityVersion purge exception compared nullable lineage fields
-- with `=`. PostgreSQL's NULL semantics made the exception unusable for the
-- normal version shape (where merge/supersedes are NULL), so preserve the
-- immutability contract while allowing the one documented content purge.
CREATE OR REPLACE FUNCTION enforce_entity_version_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND NEW.entity_version_id = OLD.entity_version_id
    AND NEW.entity_id = OLD.entity_id
    AND NEW.user_id = OLD.user_id
    AND NEW.revision = OLD.revision
    AND NEW.entity_kind_id = OLD.entity_kind_id
    AND NEW.status = OLD.status
    AND NEW.merged_into_entity_id IS NOT DISTINCT FROM OLD.merged_into_entity_id
    AND NEW.supersedes_version_id IS NOT DISTINCT FROM OLD.supersedes_version_id
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'EntityVersion is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION enforce_memory_claim_version_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND OLD.typed_value IS NOT NULL
    AND NEW.typed_value IS NULL
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.memory_claim_id = OLD.memory_claim_id
    AND NEW.user_id = OLD.user_id
    AND NEW.revision = OLD.revision
    AND NEW.kind = OLD.kind
    AND NEW.epistemic_status = OLD.epistemic_status
    AND NEW.status = OLD.status
    AND NEW.subject_entity_version_id = OLD.subject_entity_version_id
    AND NEW.object_entity_version_id IS NOT DISTINCT FROM OLD.object_entity_version_id
    AND NEW.confidence IS NOT DISTINCT FROM OLD.confidence
    AND NEW.temporal_status = OLD.temporal_status
    AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
    AND NEW.valid_from_precision = OLD.valid_from_precision
    AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to
    AND NEW.valid_to_precision = OLD.valid_to_precision
    AND NEW.last_observed_at = OLD.last_observed_at
    AND NEW.supersedes_version_id IS NOT DISTINCT FROM OLD.supersedes_version_id
    AND NEW.created_by = OLD.created_by
    AND NEW.model_version IS NOT DISTINCT FROM OLD.model_version
    AND NEW.prompt_version IS NOT DISTINCT FROM OLD.prompt_version
    AND NEW.predicate_registry_version = OLD.predicate_registry_version
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purged MemoryClaimVersion cannot be un-purged'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MemoryClaimVersion is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION enforce_memory_claim_version_qualifier_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND OLD.typed_value IS NOT NULL
    AND NEW.typed_value IS NULL
    AND NEW.memory_claim_version_qualifier_id = OLD.memory_claim_version_qualifier_id
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.user_id = OLD.user_id
    AND NEW.axis_id = OLD.axis_id
    AND NEW.role_side = OLD.role_side
    AND NEW.created_by = OLD.created_by
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purged MemoryClaimVersionQualifier cannot be un-purged'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MemoryClaimVersionQualifier is immutable'
    USING ERRCODE = '55000';
END;
$$;

-- A partially deployed purge face may already have written the marker while
-- the old trigger still retained the typed value. Normalize those rows before
-- adding the shape checks so this migration is safe on an existing database.
UPDATE memory_claim_versions
SET typed_value = NULL
WHERE content_purged_at IS NOT NULL AND typed_value IS NOT NULL;
UPDATE memory_claim_version_qualifiers
SET typed_value = NULL
WHERE content_purged_at IS NOT NULL AND typed_value IS NOT NULL;

-- A non-purged history row must retain its typed value; a purged row must not
-- retain it. This also prevents a future write path from creating an active
-- contentless ClaimVersion or reintroducing content into a purged envelope.
ALTER TABLE memory_claim_versions
  ADD CONSTRAINT memory_claim_versions_content_shape_check CHECK (
    (content_purged_at IS NULL AND typed_value IS NOT NULL)
    OR (content_purged_at IS NOT NULL AND typed_value IS NULL)
  );
ALTER TABLE memory_claim_version_qualifiers
  ADD CONSTRAINT memory_claim_version_qualifiers_content_shape_check CHECK (
    (content_purged_at IS NULL AND typed_value IS NOT NULL)
    OR (content_purged_at IS NOT NULL AND typed_value IS NULL)
  );

CREATE TRIGGER memory_claim_versions_immutable
BEFORE UPDATE OR DELETE ON memory_claim_versions
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_claim_version_immutability();

CREATE TRIGGER memory_claim_version_qualifiers_immutable
BEFORE UPDATE OR DELETE ON memory_claim_version_qualifiers
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_claim_version_qualifier_immutability();

CREATE OR REPLACE FUNCTION enforce_retrieval_run_outcome_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;

  IF
    TG_OP = 'UPDATE'
    AND NEW.retrieval_run_id = OLD.retrieval_run_id
    AND NEW.user_id = OLD.user_id
    AND NEW.daily_session_id = OLD.daily_session_id
    AND NEW.source_event_revision_id = OLD.source_event_revision_id
    AND NEW.retrieval_policy_version = OLD.retrieval_policy_version
    AND NEW.query_construction_policy_version = OLD.query_construction_policy_version
    AND NEW.projection_policy_version = OLD.projection_policy_version
    AND NEW.query_source_refs = OLD.query_source_refs
    AND NEW.normalized_query_terms = OLD.normalized_query_terms
    AND NEW.lane_plan = OLD.lane_plan
    AND NEW.deadline_ms = OLD.deadline_ms
    AND NEW.started_at = OLD.started_at
    AND (
      (
        OLD.status = 'running'
        AND NEW.status IN ('completed', 'degraded', 'failed')
      )
      OR (
        NEW.status = OLD.status
        AND OLD.compiled_context_id IS NULL
        AND NEW.compiled_context_id IS NOT NULL
      )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Retrieval run rows are immutable after the outcome update'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION enforce_retrieval_run_candidate_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Retrieval run candidate rows are immutable'
    USING ERRCODE = '55000';
END;
$$;
