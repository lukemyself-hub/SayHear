-- 1A.3a / #112: Memory Claim schema and deterministic admission rules
-- (SPEC #107 "Claims and admission", architecture §7.10, ADR-0038/0039/0040/
-- 0041/0045/0046/0051/0052, ADR-0035, ADR-0026). MemoryClaim is stable logical
-- identity; MemoryClaimVersion is append-only epistemic history; MemoryCandidate
-- is the non-authoritative proposal awaiting deterministic admission. The
-- Forget fence state (whole-Claim scope in this slice; Qualifier scope joins
-- with #115/#120) is part of the Claim trust fence.
--
-- Epistemic discipline is a schema invariant: the only recallable combinations
-- are `objective + confirmed` (one direct explicit user statement, ADR-0038)
-- and `impression + inferred` (cross-session floor, ADR-0039); `contested` is
-- reserved for existing Claims meeting unresolved conflicts (ADR-0040). There
-- is no `observed` value in any vocabulary. Statuses never decay by silence:
-- only impressions advance to `dormant` via a new ClaimVersion (ADR-0041).
-- Lifecycle advances exclusively by inserting new immutable versions and
-- CAS-moving memory_claims.current_version_id; rows are frozen like
-- EntityVersions (ADR-0074). Rejected / stale MemoryCandidates are terminal
-- (ADR-0046): the terminal fence trigger blocks any status change and allows
-- content fields only to be NULLed by the 7-day sweep (#114).
--
-- All rows carry user_id (ADR-0088 user scoping); composite foreign keys keep
-- IDs from crossing owner boundaries; IDs are opaque UUIDv7 (ADR-0085);
-- predicate_id / entity_kind semantics use the versioned `sh.*` namespace.

CREATE TABLE memory_claims (
  memory_claim_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  -- structured, language-independent identity: canonicalized subject / object
  -- Entity pair + predicate + business scope (never mention order, observation
  -- direction, or one locale's phrasing).
  canonical_key TEXT NOT NULL CHECK (canonical_key <> ''),
  subject_entity_id UUID NOT NULL,
  object_entity_id UUID,
  predicate_id TEXT NOT NULL CHECK (predicate_id ~ '^sh\.[a-z_]+\.[a-z_]+$'),
  scope_key TEXT NOT NULL DEFAULT '',
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (memory_claim_id, user_id),
  UNIQUE (user_id, canonical_key),
  FOREIGN KEY (subject_entity_id, user_id) REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (object_entity_id, user_id) REFERENCES entities(entity_id, user_id)
);

CREATE INDEX memory_claims_user_predicate_idx
  ON memory_claims(user_id, predicate_id)
  WHERE deleted_at IS NULL AND content_purged_at IS NULL;

-- Owner-boundary reference for ClaimVersion EntityVersion freezes (ADR-0085):
-- the pair uniqueness is already implied by the PK, the index materializes it
-- for the composite foreign keys below.
CREATE UNIQUE INDEX entity_versions_owner_boundary_idx
  ON entity_versions(entity_version_id, user_id);

CREATE TABLE memory_claim_versions (
  memory_claim_version_id UUID PRIMARY KEY,
  memory_claim_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('objective', 'impression')),
  epistemic_status TEXT NOT NULL
    CHECK (epistemic_status IN ('confirmed', 'inferred', 'contested')),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'review_due', 'dormant', 'superseded', 'retracted')),
  subject_entity_version_id UUID NOT NULL,
  object_entity_version_id UUID,
  -- single-cardinality entries store one normalized typed value (JSON string);
  -- multiple-cardinality entries store a sorted JSON array of values.
  typed_value JSONB NOT NULL,
  confidence NUMERIC(5, 4),
  temporal_status TEXT NOT NULL CHECK (temporal_status IN ('current', 'ended', 'unknown')),
  valid_from TIMESTAMPTZ,
  valid_from_precision TEXT NOT NULL
    CHECK (valid_from_precision IN ('exact', 'month', 'year', 'approximate', 'unknown')),
  valid_to TIMESTAMPTZ,
  valid_to_precision TEXT NOT NULL
    CHECK (valid_to_precision IN ('exact', 'month', 'year', 'approximate', 'unknown')),
  last_observed_at TIMESTAMPTZ NOT NULL,
  supersedes_version_id UUID,
  created_by TEXT NOT NULL CHECK (created_by <> ''),
  model_version TEXT,
  prompt_version TEXT,
  predicate_registry_version INTEGER NOT NULL CHECK (predicate_registry_version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (memory_claim_id, revision),
  UNIQUE (memory_claim_version_id, memory_claim_id, user_id),
  FOREIGN KEY (memory_claim_id, user_id)
    REFERENCES memory_claims(memory_claim_id, user_id),
  FOREIGN KEY (subject_entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id),
  FOREIGN KEY (object_entity_version_id, user_id)
    REFERENCES entity_versions(entity_version_id, user_id),
  FOREIGN KEY (supersedes_version_id, memory_claim_id, user_id)
    REFERENCES memory_claim_versions(
      memory_claim_version_id, memory_claim_id, user_id
    ),
  -- The only recallable epistemic combinations (ADR-0038 / ADR-0039);
  -- `contested` is reserved for existing Claims in unresolved conflict
  -- (ADR-0040). There is no `observed` state anywhere. A `retracted` version
  -- is the Forget fence made state: it snapshots the fenced version and is
  -- excluded from Recall by status, not by epistemic rewriting.
  CONSTRAINT memory_claim_versions_epistemic_combination_check CHECK (
    status = 'retracted'
    OR (epistemic_status = 'confirmed' AND kind = 'objective')
    OR (epistemic_status = 'inferred' AND kind = 'impression')
    OR epistemic_status = 'contested'
  )
);

-- Owner-boundary reference for child rows (evidence links, forget / reversal
-- applied versions): the pair uniqueness is implied by the PK, the index
-- materializes it for composite foreign keys.
CREATE UNIQUE INDEX memory_claim_versions_owner_boundary_idx
  ON memory_claim_versions(memory_claim_version_id, user_id);

-- The read pointer to the current version (CAS-updated only; it never
-- replaces Claim identity dedupe on (user_id, canonical_key)).
ALTER TABLE memory_claims
  ADD CONSTRAINT memory_claims_current_version_fk
  FOREIGN KEY (current_version_id, memory_claim_id, user_id)
  REFERENCES memory_claim_versions(
    memory_claim_version_id, memory_claim_id, user_id
  );

CREATE UNIQUE INDEX memory_claims_current_version_idx
  ON memory_claims(current_version_id)
  WHERE current_version_id IS NOT NULL;

CREATE INDEX memory_claim_versions_claim_idx
  ON memory_claim_versions(memory_claim_id, revision);

-- ClaimVersions are immutable history (ADR-0074); only the purge face (#123)
-- may set content_purged_at. State changes create new versions and move
-- memory_claims.current_version_id; they never rewrite a row in place.
CREATE FUNCTION enforce_memory_claim_version_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.memory_claim_id = OLD.memory_claim_id
    AND NEW.user_id = OLD.user_id
    AND NEW.revision = OLD.revision
    AND NEW.kind = OLD.kind
    AND NEW.epistemic_status = OLD.epistemic_status
    AND NEW.status = OLD.status
    AND NEW.subject_entity_version_id = OLD.subject_entity_version_id
    AND NEW.object_entity_version_id IS NOT DISTINCT FROM OLD.object_entity_version_id
    AND NEW.typed_value = OLD.typed_value
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
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Purged MemoryClaimVersion cannot be un-purged'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MemoryClaimVersion is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER memory_claim_versions_immutable
BEFORE UPDATE OR DELETE ON memory_claim_versions
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_claim_version_immutability();

CREATE TABLE claim_evidence_links (
  claim_evidence_link_id UUID PRIMARY KEY,
  memory_claim_version_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  -- evidence_items are structurally user-actor and final / corrected only
  -- (migration 0010 CHECKs), so user life facts can never rest on Assistant
  -- or System Events (SPEC AC 5).
  evidence_item_id UUID NOT NULL,
  link_role TEXT NOT NULL
    CHECK (link_role IN ('support', 'counter', 'subjective_report', 'context')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_claim_version_id, evidence_item_id, link_role),
  FOREIGN KEY (memory_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX claim_evidence_links_version_idx
  ON claim_evidence_links(memory_claim_version_id)
  WHERE status = 'active';

CREATE TABLE memory_candidates (
  memory_candidate_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('objective', 'impression')),
  -- The deterministic admission input for ADR-0038 vs ADR-0039: whether the
  -- proposal rests on a direct, explicit user statement or on model inference.
  basis TEXT NOT NULL CHECK (basis IN ('directly_stated', 'inferred')),
  subject_entity_id UUID,
  subject_entity_mention_id UUID,
  object_entity_id UUID,
  object_entity_mention_id UUID,
  predicate_id TEXT CHECK (predicate_id ~ '^sh\.[a-z_]+\.[a-z_]+$'),
  predicate_registry_version INTEGER CHECK (predicate_registry_version > 0),
  predicate_resolution_status TEXT NOT NULL
    CHECK (predicate_resolution_status IN ('mapped', 'ambiguous', 'unmapped')),
  proposed_concept TEXT,
  mapping_confidence NUMERIC(5, 4),
  proposed_object_value JSONB NOT NULL,
  proposed_scope_key TEXT NOT NULL DEFAULT '',
  proposed_temporal_status TEXT NOT NULL
    CHECK (proposed_temporal_status IN ('current', 'ended', 'unknown')),
  proposed_valid_from TIMESTAMPTZ,
  proposed_valid_from_precision TEXT NOT NULL
    CHECK (proposed_valid_from_precision IN ('exact', 'month', 'year', 'approximate', 'unknown')),
  proposed_valid_to TIMESTAMPTZ,
  proposed_valid_to_precision TEXT NOT NULL
    CHECK (proposed_valid_to_precision IN ('exact', 'month', 'year', 'approximate', 'unknown')),
  -- Reflection lineage is runtime provenance only; it never substitutes for
  -- Evidence (ADR-0087). Reflections themselves are 1A.3b.
  source_reflection_version_id UUID,
  generation_command_id TEXT,
  authoritative_model_attempt_id TEXT,
  model_version TEXT,
  prompt_version TEXT,
  extraction_policy_version TEXT NOT NULL CHECK (extraction_policy_version <> ''),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN (
      'proposed', 'needs_entity_resolution', 'needs_predicate_review',
      'awaiting_registry_release', 'accepted', 'rejected', 'stale', 'deleted'
    )),
  predicate_review_policy_version TEXT,
  review_eligible_at TIMESTAMPTZ,
  review_due_at TIMESTAMPTZ,
  registry_release_wait_started_at TIMESTAMPTZ,
  registry_release_due_at TIMESTAMPTZ,
  disposition_reason_code TEXT,
  disposition_policy_version TEXT,
  decided_at TIMESTAMPTZ,
  terminal_effective_at TIMESTAMPTZ,
  terminal_content_expires_at TIMESTAMPTZ,
  reproposal_policy TEXT
    CHECK (reproposal_policy IN (
      'material_change_allowed', 'explicit_reconsideration_only', 'blocked_while_policy_active'
    )),
  predecessor_candidate_id UUID,
  successor_trigger TEXT
    CHECK (successor_trigger IN ('materially_new_evidence', 'explicit_reconsideration')),
  material_change_reason_codes TEXT[],
  -- keyed exact-match fence over (user, semantic target, sorted evidence
  -- revisions, policy version); never plaintext, never for retrieval or
  -- reconstruction (ADR-0051).
  dedupe_fingerprint TEXT,
  dedupe_fingerprint_key_version TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (memory_candidate_id, user_id),
  FOREIGN KEY (subject_entity_id, user_id) REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (object_entity_id, user_id) REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (subject_entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  FOREIGN KEY (object_entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  FOREIGN KEY (predecessor_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id),
  CHECK (
    (predicate_resolution_status = 'mapped'
      AND predicate_id IS NOT NULL
      AND predicate_registry_version IS NOT NULL)
    OR (predicate_resolution_status <> 'mapped'
      AND predicate_id IS NULL
      AND proposed_concept IS NOT NULL)
  ),
  CHECK (status <> 'needs_predicate_review' OR review_due_at IS NOT NULL),
  CHECK (
    status <> 'awaiting_registry_release' OR registry_release_due_at IS NOT NULL
  ),
  CHECK (
    status NOT IN ('rejected', 'stale')
    OR (
      terminal_effective_at IS NOT NULL
      AND terminal_content_expires_at IS NOT NULL
      AND terminal_content_expires_at > terminal_effective_at
      AND disposition_reason_code IS NOT NULL
      AND disposition_policy_version IS NOT NULL
      AND reproposal_policy IS NOT NULL
      AND dedupe_fingerprint IS NOT NULL
      AND dedupe_fingerprint_key_version IS NOT NULL
      AND decided_at IS NOT NULL
    )
  ),
  CHECK (
    (successor_trigger IS NULL) = (predecessor_candidate_id IS NULL)
  ),
  CHECK (
    predecessor_candidate_id IS NULL
    OR (successor_trigger = 'materially_new_evidence' AND material_change_reason_codes IS NOT NULL)
    OR (successor_trigger = 'explicit_reconsideration')
  )
);

CREATE INDEX memory_candidates_user_status_idx
  ON memory_candidates(user_id, status)
  WHERE content_purged_at IS NULL;

-- Exact-match terminal fence lookups (ADR-0046 / ADR-0052): one keyed
-- fingerprint per owner; never used for retrieval or clustering.
CREATE UNIQUE INDEX memory_candidates_terminal_fingerprint_idx
  ON memory_candidates(user_id, dedupe_fingerprint)
  WHERE dedupe_fingerprint IS NOT NULL;

CREATE INDEX memory_candidates_pending_review_idx
  ON memory_candidates(review_due_at)
  WHERE status = 'needs_predicate_review' AND content_purged_at IS NULL;

CREATE INDEX memory_candidates_registry_release_idx
  ON memory_candidates(registry_release_due_at)
  WHERE status = 'awaiting_registry_release' AND content_purged_at IS NULL;

-- Terminal dispositions are terminal (ADR-0046): status can never leave
-- rejected / stale, and once terminal the semantic content may only be swept
-- to NULL (the 7-day expiry, ADR-0051) — never re-set, never re-semanticized.
CREATE FUNCTION enforce_memory_candidate_terminal_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('rejected', 'stale') THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'Terminal MemoryCandidate disposition cannot change (ADR-0046)'
        USING ERRCODE = '55000';
    END IF;
    IF
      NEW.candidate_kind IS DISTINCT FROM OLD.candidate_kind
      OR NEW.basis IS DISTINCT FROM OLD.basis
      OR NEW.subject_entity_id IS DISTINCT FROM OLD.subject_entity_id
      OR NEW.subject_entity_mention_id IS DISTINCT FROM OLD.subject_entity_mention_id
      OR NEW.object_entity_id IS DISTINCT FROM OLD.object_entity_id
      OR NEW.object_entity_mention_id IS DISTINCT FROM OLD.object_entity_mention_id
      OR NEW.predicate_id IS DISTINCT FROM OLD.predicate_id
      OR NEW.predicate_registry_version IS DISTINCT FROM OLD.predicate_registry_version
      OR NEW.predicate_resolution_status IS DISTINCT FROM OLD.predicate_resolution_status
      OR NEW.proposed_concept IS DISTINCT FROM OLD.proposed_concept
      OR NEW.mapping_confidence IS DISTINCT FROM OLD.mapping_confidence
      OR NEW.proposed_object_value IS DISTINCT FROM OLD.proposed_object_value
      OR NEW.proposed_scope_key IS DISTINCT FROM OLD.proposed_scope_key
      OR NEW.proposed_temporal_status IS DISTINCT FROM OLD.proposed_temporal_status
      OR NEW.proposed_valid_from IS DISTINCT FROM OLD.proposed_valid_from
      OR NEW.proposed_valid_from_precision IS DISTINCT FROM OLD.proposed_valid_from_precision
      OR NEW.proposed_valid_to IS DISTINCT FROM OLD.proposed_valid_to
      OR NEW.proposed_valid_to_precision IS DISTINCT FROM OLD.proposed_valid_to_precision
      OR NEW.extraction_policy_version IS DISTINCT FROM OLD.extraction_policy_version
      OR NEW.disposition_reason_code IS DISTINCT FROM OLD.disposition_reason_code
      OR NEW.disposition_policy_version IS DISTINCT FROM OLD.disposition_policy_version
      OR NEW.terminal_effective_at IS DISTINCT FROM OLD.terminal_effective_at
      OR NEW.terminal_content_expires_at IS DISTINCT FROM OLD.terminal_content_expires_at
      OR NEW.reproposal_policy IS DISTINCT FROM OLD.reproposal_policy
      OR NEW.dedupe_fingerprint IS DISTINCT FROM OLD.dedupe_fingerprint
      OR NEW.dedupe_fingerprint_key_version IS DISTINCT FROM OLD.dedupe_fingerprint_key_version
    THEN
      RAISE EXCEPTION
        'Terminal MemoryCandidate content may only be swept to NULL, never re-set'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_candidates_terminal_fence
BEFORE UPDATE ON memory_candidates
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_candidate_terminal_fence();

CREATE TABLE memory_candidate_evidence_links (
  memory_candidate_evidence_link_id UUID PRIMARY KEY,
  memory_candidate_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_item_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_candidate_id, evidence_item_id),
  FOREIGN KEY (memory_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX memory_candidate_evidence_links_candidate_idx
  ON memory_candidate_evidence_links(memory_candidate_id);

-- User control commands, not counter Evidence (ADR-0035). Qualifier scope
-- columns exist for the #115 / #120 extension; v1 writes whole_claim only.
CREATE TABLE memory_forget_requests (
  memory_forget_request_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  request_event_revision_id UUID NOT NULL,
  target_claim_id UUID,
  target_scope TEXT NOT NULL
    CHECK (target_scope IN ('whole_claim', 'relationship_qualifier')),
  canonical_side TEXT,
  qualifier_key TEXT,
  qualifier_typed_value JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending_scope', 'applied')),
  applied_claim_version_id UUID,
  forget_policy_version TEXT NOT NULL CHECK (forget_policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_forget_request_id, user_id),
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (target_claim_id, user_id)
    REFERENCES memory_claims(memory_claim_id, user_id),
  FOREIGN KEY (applied_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id),
  CHECK (
    (target_scope = 'relationship_qualifier')
    = (canonical_side IS NOT NULL AND qualifier_key IS NOT NULL)
  ),
  CHECK ((status = 'applied') = (applied_claim_version_id IS NOT NULL))
);

CREATE UNIQUE INDEX memory_forget_requests_revision_idx
  ON memory_forget_requests(user_id, request_event_revision_id, target_claim_id)
  WHERE target_claim_id IS NOT NULL;

CREATE INDEX memory_forget_requests_claim_idx
  ON memory_forget_requests(user_id, target_claim_id)
  WHERE status = 'applied';

CREATE TABLE memory_forget_evidence_exclusions (
  memory_forget_evidence_exclusion_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_forget_request_id UUID NOT NULL,
  evidence_item_id UUID NOT NULL,
  exclusion_scope TEXT NOT NULL
    CHECK (exclusion_scope IN ('whole_claim', 'relationship_qualifier')),
  canonical_side TEXT,
  qualifier_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_forget_request_id, evidence_item_id, exclusion_scope, canonical_side, qualifier_key),
  FOREIGN KEY (memory_forget_request_id, user_id)
    REFERENCES memory_forget_requests(memory_forget_request_id, user_id),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

CREATE INDEX memory_forget_evidence_exclusions_claim_idx
  ON memory_forget_evidence_exclusions(user_id, evidence_item_id)
  WHERE status = 'active';

CREATE TABLE memory_forget_reversals (
  memory_forget_reversal_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_forget_request_id UUID NOT NULL,
  request_event_revision_id UUID NOT NULL,
  -- The reversal User Event doubles as new Evidence; old Evidence stays
  -- unusable and old exclusions stay active (ADR-0035).
  reversal_evidence_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  applied_claim_version_id UUID NOT NULL,
  forget_policy_version TEXT NOT NULL CHECK (forget_policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_forget_reversal_id, user_id),
  FOREIGN KEY (memory_forget_request_id, user_id)
    REFERENCES memory_forget_requests(memory_forget_request_id, user_id),
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (reversal_evidence_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id),
  FOREIGN KEY (applied_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id)
);

CREATE UNIQUE INDEX memory_forget_reversals_active_request_idx
  ON memory_forget_reversals(memory_forget_request_id)
  WHERE status = 'active';
