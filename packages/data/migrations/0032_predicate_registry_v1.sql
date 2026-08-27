-- 1A.3a / #111: Predicate Registry v1 (SPEC #107 "Predicate Registry v1
-- (#93)", architecture §7.10.1, grilling #93). The Registry itself is
-- versioned TypeScript in the codebase (packages/application/.../
-- predicate-registry); release is driven by code + mapping tests + this
-- migration family. These tables hold the published material the deterministic
-- mapping lane and later retrieval lanes read:
--   predicate_registry_entries             machine identity per entry/version
--   predicate_localizations                bilingual natural-language seeds
--   relationship_projection_localizations  forward/inverse/symmetric templates
--   predicate_relations                    confusable_with / broader / … graph
--
-- Reference data, not private user data: no user_id anywhere, so nothing here
-- participates in purge or deletion propagation (#99 clusters exclude it).
-- Every child row carries registry_version so past releases stay queryable for
-- replay identity while each new release converges its own slice.

CREATE TABLE predicate_registry_entries (
  predicate_id TEXT NOT NULL
    CHECK (predicate_id ~ '^sh\.[a-z_]+\.[a-z_]+$'),
  registry_version INTEGER NOT NULL CHECK (registry_version >= 1),
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'deprecated', 'retired')),
  allowed_claim_kinds JSONB NOT NULL,
  sensitivity_class TEXT NOT NULL
    CHECK (sensitivity_class IN ('standard', 'sensitive')),
  allowed_subject_kind_ids JSONB NOT NULL,
  object_value_schema JSONB NOT NULL,
  scope_schema JSONB NOT NULL,
  value_cardinality TEXT NOT NULL CHECK (value_cardinality IN ('single', 'multiple')),
  temporal_semantics JSONB NOT NULL,
  relationship_semantics JSONB,
  evidence_policy_id TEXT NOT NULL,
  review_policy_id TEXT,
  replaced_by_predicate_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  deprecated_at TIMESTAMPTZ,
  PRIMARY KEY (predicate_id, registry_version)
);

CREATE INDEX predicate_registry_entries_version_idx
  ON predicate_registry_entries (registry_version);

CREATE TABLE predicate_localizations (
  predicate_id TEXT NOT NULL,
  registry_version INTEGER NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
  label TEXT NOT NULL CHECK (label <> ''),
  definition TEXT NOT NULL CHECK (definition <> ''),
  positive_examples JSONB NOT NULL,
  negative_examples JSONB NOT NULL,
  lexical_surfaces JSONB NOT NULL,
  localization_version INTEGER NOT NULL CHECK (localization_version >= 1),
  PRIMARY KEY (predicate_id, locale, registry_version),
  FOREIGN KEY (predicate_id, registry_version)
    REFERENCES predicate_registry_entries (predicate_id, registry_version)
);

CREATE TABLE relationship_projection_localizations (
  predicate_id TEXT NOT NULL,
  registry_version INTEGER NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
  view_direction TEXT NOT NULL
    CHECK (view_direction IN ('forward', 'inverse', 'symmetric')),
  role_projection_schema JSONB NOT NULL,
  localization_version INTEGER NOT NULL CHECK (localization_version >= 1),
  PRIMARY KEY (predicate_id, locale, view_direction, registry_version),
  FOREIGN KEY (predicate_id, registry_version)
    REFERENCES predicate_registry_entries (predicate_id, registry_version)
);

CREATE TABLE predicate_relations (
  predicate_id TEXT NOT NULL,
  related_predicate_id TEXT NOT NULL,
  registry_version INTEGER NOT NULL,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN
      ('confusable_with', 'broader', 'narrower', 'replaced_by')),
  PRIMARY KEY (predicate_id, related_predicate_id, relation_type, registry_version),
  FOREIGN KEY (predicate_id, registry_version)
    REFERENCES predicate_registry_entries (predicate_id, registry_version),
  FOREIGN KEY (related_predicate_id, registry_version)
    REFERENCES predicate_registry_entries (predicate_id, registry_version)
);
