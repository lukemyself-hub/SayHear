-- 1A.3a / #110: Entity domain foundation (SPEC #107 "Entity resolution (#97)",
-- architecture §7.7). Entity / EntityVersion / EntityMention, bilingual label
-- with verified-alias discipline, and the contentless Account–Self Entity
-- binding. Merge / split / promotion (#121) and the purge face (#123) build on
-- these tables; this migration only lays the identity substrate.
--
-- entity_kind_id is a versioned `sh.*` semantic ID (ADR-0085), so its value
-- set stays code-governed instead of a schema literal; the same applies to
-- resolver_policy_version. All rows carry user_id (ADR-0088 user scoping) and
-- composite foreign keys keep IDs from crossing owner boundaries.

-- Entity-domain foreign keys reference evidence by (evidence_item_id,
-- user_id); the PK already implies this uniqueness, the constraint just
-- materializes it for reference.
CREATE UNIQUE INDEX evidence_items_owner_boundary_idx
  ON evidence_items(evidence_item_id, user_id);

CREATE TABLE entities (
  entity_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  UNIQUE (entity_id, user_id)
);

CREATE TABLE user_self_entities (
  user_id UUID PRIMARY KEY REFERENCES app_users(user_id),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (entity_id),
  FOREIGN KEY (entity_id, user_id) REFERENCES entities(entity_id, user_id)
);

CREATE TABLE entity_versions (
  entity_version_id UUID PRIMARY KEY,
  entity_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  entity_kind_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'merged', 'split', 'unresolved', 'deleted')),
  merged_into_entity_id UUID,
  supersedes_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (entity_id, revision),
  UNIQUE (entity_version_id, entity_id, user_id),
  FOREIGN KEY (entity_id, user_id) REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (merged_into_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (supersedes_version_id, entity_id, user_id)
    REFERENCES entity_versions(entity_version_id, entity_id, user_id)
);

ALTER TABLE entities
  ADD CONSTRAINT entities_current_version_fk
  FOREIGN KEY (current_version_id, entity_id, user_id)
  REFERENCES entity_versions(entity_version_id, entity_id, user_id);

CREATE UNIQUE INDEX entities_current_version_idx
  ON entities(current_version_id)
  WHERE current_version_id IS NOT NULL;

-- Verified-alias discipline: an alias is a binding surface, so it only exists
-- with the User Evidence that verified it. Primary labels name an introduced
-- Entity and may await per-event evidence wiring (#113).
CREATE TABLE entity_labels (
  entity_label_id UUID PRIMARY KEY,
  entity_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  locale TEXT NOT NULL CHECK (locale <> ''),
  label TEXT NOT NULL CHECK (label <> ''),
  normalized_label TEXT NOT NULL CHECK (normalized_label <> ''),
  label_kind TEXT NOT NULL CHECK (label_kind IN ('primary', 'alias')),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  source_evidence_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  FOREIGN KEY (entity_id, user_id) REFERENCES entities(entity_id, user_id),
  FOREIGN KEY (source_evidence_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id),
  CHECK (label_kind = 'primary' OR source_evidence_id IS NOT NULL)
);

CREATE UNIQUE INDEX entity_labels_current_primary_idx
  ON entity_labels(entity_id, locale)
  WHERE label_kind = 'primary' AND is_current AND content_purged_at IS NULL;

CREATE UNIQUE INDEX entity_labels_current_alias_idx
  ON entity_labels(entity_id, locale, normalized_label)
  WHERE label_kind = 'alias' AND is_current AND content_purged_at IS NULL;

CREATE INDEX entity_labels_lookup_idx
  ON entity_labels(user_id, normalized_label)
  WHERE is_current AND content_purged_at IS NULL;

CREATE TABLE entity_mentions (
  entity_mention_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  conversation_event_id UUID NOT NULL,
  event_revision_id UUID NOT NULL,
  evidence_id UUID,
  locator_type TEXT NOT NULL
    CHECK (locator_type IN ('whole_revision', 'text_span')),
  start_offset INTEGER,
  end_offset INTEGER,
  mention_kind TEXT NOT NULL
    CHECK (mention_kind IN ('first_person', 'named', 'pronoun')),
  resolved_entity_id UUID,
  resolution_status TEXT NOT NULL
    CHECK (resolution_status IN ('resolved', 'unresolved', 'ambiguous')),
  confidence NUMERIC(5, 4),
  resolver_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (entity_mention_id, user_id),
  FOREIGN KEY (event_revision_id, conversation_event_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, conversation_event_id, user_id
    ),
  FOREIGN KEY (evidence_id, user_id)
    REFERENCES evidence_items(evidence_item_id, user_id),
  FOREIGN KEY (resolved_entity_id, user_id)
    REFERENCES entities(entity_id, user_id),
  CHECK (
    (
      locator_type = 'whole_revision'
      AND start_offset IS NULL
      AND end_offset IS NULL
    )
    OR (
      locator_type = 'text_span'
      AND start_offset IS NOT NULL
      AND end_offset IS NOT NULL
      AND start_offset >= 0
      AND end_offset >= start_offset
    )
  ),
  CHECK (
    (resolution_status = 'resolved') = (resolved_entity_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX entity_mentions_revision_span_idx
  ON entity_mentions(
    user_id,
    event_revision_id,
    locator_type,
    COALESCE(start_offset, -1),
    COALESCE(end_offset, -1),
    resolver_policy_version
  );

-- Fuzzy-lane diagnostics only: near-form and multi-exact candidates are
-- recorded for manifests and inspection. No status column, no queue (#97).
CREATE TABLE entity_mention_candidates (
  entity_mention_candidate_id UUID PRIMARY KEY,
  entity_mention_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  candidate_entity_id UUID NOT NULL,
  matched_label TEXT NOT NULL CHECK (matched_label <> ''),
  candidate_kind TEXT NOT NULL
    CHECK (candidate_kind IN ('near_form', 'multi_exact')),
  edit_distance INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (entity_mention_id, candidate_entity_id, candidate_kind),
  FOREIGN KEY (entity_mention_id, user_id)
    REFERENCES entity_mentions(entity_mention_id, user_id),
  FOREIGN KEY (candidate_entity_id, user_id)
    REFERENCES entities(entity_id, user_id)
);

-- EntityVersions are immutable history (ADR-0074); only the purge face (#123)
-- may clear content by setting content_purged_at.
CREATE FUNCTION enforce_entity_version_immutability()
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
    AND NEW.merged_into_entity_id = OLD.merged_into_entity_id
    AND NEW.supersedes_version_id = OLD.supersedes_version_id
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'EntityVersion is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER entity_versions_immutable
BEFORE UPDATE OR DELETE ON entity_versions
FOR EACH ROW
EXECUTE FUNCTION enforce_entity_version_immutability();

-- The Self Entity never merges, splits, or independently deletes (ADR-0028):
-- while the Account–Self binding exists, only 'active' versions may exist and
-- the Entity row may not be marked deleted. Identity surgery (#121) targets
-- ordinary Entities only; Full Purge (#123) keeps this envelope contentless.
CREATE FUNCTION enforce_self_entity_version_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_self_entities binding
    WHERE binding.entity_id = NEW.entity_id
  ) AND NEW.status <> 'active' THEN
    RAISE EXCEPTION
      'The Self Entity never merges, splits, or deactivates'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_self_entity_no_independent_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_self_entities binding
    WHERE binding.entity_id = NEW.entity_id
  ) AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'The Self Entity cannot be independently deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER self_entities_version_protected
BEFORE INSERT OR UPDATE ON entity_versions
FOR EACH ROW
EXECUTE FUNCTION enforce_self_entity_version_status();

CREATE TRIGGER self_entities_row_protected
BEFORE UPDATE ON entities
FOR EACH ROW
EXECUTE FUNCTION enforce_self_entity_no_independent_delete();
