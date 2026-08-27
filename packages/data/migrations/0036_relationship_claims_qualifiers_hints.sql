-- 1A.3a / #115: Relationship Memory Claims — Qualifiers + Resolver Hints.
-- (SPEC #107 "Relationships" AC 12–16, ADR-0027 / 0029 / 0030 / 0031 / 0033 /
-- 0034 / 0036.)
--
-- Relationship Qualifiers are version-scoped, evidence-backed role assertions
-- (ADR-0033): each qualifier refines one party's role on ONE immutable
-- ClaimVersion, carries its own direct User Evidence, and never enters
-- Predicate IDs, Claim identity (canonical_key), or Entity labels. Refinement
-- follows the Claim substrate: a refinement appends a new ClaimVersion with
-- the merged qualifier set — rows here are frozen like the versions they
-- decorate. There is no `observed` state: qualifiers exist only where a user
-- statement supports them.
--
-- Relationship Resolver Hints (ADR-0027) are a rebuildable, non-authoritative
-- projection of ONE claim's CURRENT version: per party and locale they name
-- the role term the current version supports (qualifier value, axis neutral
-- fallback, or the registry label) and the rendered template phrase. Rows are
-- deleted + reinserted on every version advance (write-through) and by the
-- rebuild path; `temporal_form = 'ended'` projects former templates and the
-- `unknown` temporal state projects no rows at all (ADR-0030). Hints never
-- become identity or Evidence. Qualifier provenance columns
-- (role_axis_id / role_side) let a Qualifier-scoped Forget (#120) invalidate
-- every direction / locale projection of one role in a single rebuild.
--
-- memory_candidates.proposed_qualifiers carries the pre-admission qualifier
-- proposals; it is cleared by the 7-day terminal-content sweep like the other
-- proposal content fields (ADR-0051).
--
-- All rows carry user_id (ADR-0088) with owner-bound composite foreign keys;
-- IDs are opaque UUIDv7 (ADR-0085).

CREATE TABLE memory_claim_version_qualifiers (
  memory_claim_version_qualifier_id UUID PRIMARY KEY,
  memory_claim_version_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  -- published qualifier axis from the Predicate Registry entry (e.g.
  -- kinship_term, relation_origin, stated_closeness).
  axis_id TEXT NOT NULL CHECK (axis_id <> ''),
  -- canonical Claim side the qualifier refines; candidate-relative sides are
  -- resolved deterministically at admission (sorted pair for symmetric
  -- predicates, registry direction for directed ones).
  role_side TEXT NOT NULL CHECK (role_side IN ('canonical_subject', 'counterpart')),
  -- single-cardinality axes store one normalized value (JSON string);
  -- multiple-cardinality axes store a sorted JSON array.
  typed_value JSONB NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (memory_claim_version_id, axis_id, role_side),
  UNIQUE (memory_claim_version_qualifier_id, user_id),
  FOREIGN KEY (memory_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id)
);

CREATE INDEX memory_claim_version_qualifiers_version_idx
  ON memory_claim_version_qualifiers(memory_claim_version_id);

-- ClaimVersion immutability extends to its qualifier assertions: rows are
-- frozen; only the purge face (#123) may set content_purged_at.
CREATE FUNCTION enforce_memory_claim_version_qualifier_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND NEW.memory_claim_version_qualifier_id = OLD.memory_claim_version_qualifier_id
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.user_id = OLD.user_id
    AND NEW.axis_id = OLD.axis_id
    AND NEW.role_side = OLD.role_side
    AND NEW.typed_value = OLD.typed_value
    AND NEW.created_by = OLD.created_by
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Purged MemoryClaimVersionQualifier cannot be un-purged'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MemoryClaimVersionQualifier is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER memory_claim_version_qualifiers_immutable
BEFORE UPDATE OR DELETE ON memory_claim_version_qualifiers
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_claim_version_qualifier_immutability();

-- Qualifier-specific Evidence (AC 14): each qualifier cites its own direct
-- User Evidence items, always a subset of the admission evidence.
CREATE TABLE memory_claim_version_qualifier_evidence (
  memory_claim_version_qualifier_evidence_id UUID PRIMARY KEY,
  memory_claim_version_qualifier_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_item_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_claim_version_qualifier_id, evidence_item_id),
  FOREIGN KEY (memory_claim_version_qualifier_id, user_id)
    REFERENCES memory_claim_version_qualifiers(
      memory_claim_version_qualifier_id, user_id
    ),
  FOREIGN KEY (evidence_item_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id)
);

-- Owner-boundary reference for the evidence FK above is the pair UNIQUE on
-- the parent table; no extra index needed.

CREATE INDEX memory_claim_version_qualifier_evidence_qualifier_idx
  ON memory_claim_version_qualifier_evidence(memory_claim_version_qualifier_id);

-- Rebuildable Resolver Hint projection of the CURRENT claim version
-- (ADR-0027). One row per (claim, resolved party, view direction, locale,
-- role axis): relationship claims project two locales; directed entries
-- project the forward view for the canonical subject and the inverse view for
-- the counterpart; symmetric entries project the symmetric view for both.
CREATE TABLE relationship_resolver_hints (
  relationship_resolver_hint_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_id UUID NOT NULL,
  -- the current version this projection derives from — exactly one
  -- ClaimVersion per ADR-0031; rows are rebuilt on every version advance.
  memory_claim_version_id UUID NOT NULL,
  resolved_entity_id UUID NOT NULL,
  context_entity_id UUID NOT NULL,
  view_direction TEXT NOT NULL
    CHECK (view_direction IN ('forward', 'inverse', 'symmetric')),
  locale TEXT NOT NULL CHECK (locale IN ('en', 'zh')),
  temporal_form TEXT NOT NULL CHECK (temporal_form IN ('current', 'former')),
  role_side TEXT NOT NULL
    CHECK (role_side IN ('canonical_subject', 'counterpart')),
  -- provenance of role_term: the qualifier axis when derived from a
  -- qualifier, null for the registry-label fallback. A Qualifier-scoped
  -- Forget (#120) rebuilds every row of its (axis, side) at once.
  role_axis_id TEXT,
  role_term TEXT NOT NULL CHECK (role_term <> ''),
  role_source TEXT NOT NULL
    CHECK (role_source IN ('qualifier', 'neutral_fallback', 'predicate_label')),
  -- rendered registry template with current labels; null when a current
  -- label is missing for this locale.
  phrase TEXT,
  rebuilt_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_claim_id, resolved_entity_id, view_direction, locale, role_axis_id),
  FOREIGN KEY (memory_claim_id, user_id)
    REFERENCES memory_claims(memory_claim_id, user_id),
  FOREIGN KEY (resolved_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (context_entity_id, user_id)
    REFERENCES entities(entity_id, user_id)
);

CREATE INDEX relationship_resolver_hints_resolution_idx
  ON relationship_resolver_hints(user_id, resolved_entity_id, locale);

-- Pre-admission qualifier proposals (ADR-0051 terminal-content sweep clears
-- this alongside the other proposal content fields after 7 days).
ALTER TABLE memory_candidates
  ADD COLUMN proposed_qualifiers JSONB;
