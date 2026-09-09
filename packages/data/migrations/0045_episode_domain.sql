-- 1A.3b A1 / issue #197.
--
-- Episode domain: episodes, immutable episode_versions, episode_candidates
-- with the orthogonal (resolution_status x status) contract, typed evidence /
-- entity anchor links, the daily build run ledger, and impact review state.
--
-- The episode.build model role consumes the shared generation_commands /
-- model_run_attempts ledger added by 0044. This migration adds the domain
-- surfaces only; it does not seed a provider, model, or active rollout pin,
-- so episode admission stays closed until a release manifest publishes an
-- evaluated config (ADR-0136 / ADR-0134).
--
-- Retention follows ADR-0130: successful EpisodeVersion typed content and
-- lineage stay until Internal Owner Full Purge; terminal Candidate content
-- is cleared 7 days after the terminal effective date. Every table here is
-- registered in the Purge Surface Registry in the same change (ADR-0131).

CREATE TABLE episode_policies (
  policy_version TEXT PRIMARY KEY CHECK (policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO episode_policies (policy_version, created_at)
VALUES ('episode-admission:v1', CURRENT_TIMESTAMP);

CREATE FUNCTION reject_episode_policy_mutation() RETURNS trigger
AS $$
BEGIN
  RAISE EXCEPTION 'episode_policies rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER episode_policies_immutable
  BEFORE UPDATE OR DELETE ON episode_policies
  FOR EACH ROW EXECUTE FUNCTION reject_episode_policy_mutation();

CREATE TABLE episodes (
  episode_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  episode_kind_id TEXT NOT NULL CHECK (
    episode_kind_id IN (
      'sh.episode.trip', 'sh.episode.relocation',
      'sh.episode.project_phase', 'sh.episode.occurrence',
      'sh.episode.other'
    )
  ),
  current_version_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  UNIQUE (episode_id, user_id)
);

CREATE TABLE episode_versions (
  episode_version_id UUID PRIMARY KEY,
  episode_id UUID NOT NULL REFERENCES episodes(episode_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  episode_kind_id TEXT NOT NULL CHECK (
    episode_kind_id IN (
      'sh.episode.trip', 'sh.episode.relocation',
      'sh.episode.project_phase', 'sh.episode.occurrence',
      'sh.episode.other'
    )
  ),
  status TEXT NOT NULL DEFAULT 'current' CHECK (
    status IN ('current', 'superseded')
  ),
  label TEXT,
  content JSONB CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL
    REFERENCES model_run_attempts(model_run_attempt_id),
  supersedes_version_id UUID REFERENCES episode_versions(episode_version_id),
  enrichment_paused_at TIMESTAMPTZ,
  enrichment_pause_reason TEXT CHECK (
    enrichment_pause_reason IN ('evidence_correction', 'entity_identity_change')
  ),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (episode_version_id, user_id),
  UNIQUE (episode_id, revision),
  CHECK (
    (supersedes_version_id IS NULL) = (revision = 1)
  ),
  CHECK (
    (enrichment_pause_reason IS NULL) = (enrichment_paused_at IS NULL)
  )
);

ALTER TABLE episodes
  ADD CONSTRAINT episodes_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES episode_versions(episode_version_id);

CREATE UNIQUE INDEX episode_versions_supersedes_once_idx
  ON episode_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

CREATE INDEX episode_versions_episode_idx
  ON episode_versions(episode_id);

CREATE INDEX episode_versions_owner_status_idx
  ON episode_versions(user_id, status)
  WHERE content_purged_at IS NULL;

CREATE INDEX episode_versions_enrichment_pause_idx
  ON episode_versions(user_id)
  WHERE enrichment_paused_at IS NOT NULL AND content_purged_at IS NULL;

-- Immutable domain history (ADR-0074 / ADR-0130): label and typed content can
-- only transition to NULL together with content_purged_at during Full Purge;
-- enrichment pause and current-to-superseded transitions are the only other
-- permitted writes. A superseded version can never become current again
-- (the current pointer never regresses).
CREATE FUNCTION enforce_episode_version_immutability() RETURNS trigger
AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged episode version rows are immutable';
  END IF;
  IF NEW.label IS DISTINCT FROM OLD.label
    AND NOT (OLD.label IS NOT NULL AND NEW.label IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'episode version label is immutable until Full Purge';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
    AND NOT (OLD.content IS NOT NULL AND NEW.content IS NULL
      AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'episode version content is immutable until Full Purge';
  END IF;
  IF (NEW.label IS NULL) <> (NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'episode version label purge must match content_purged_at';
  END IF;
  IF NEW.status = 'current' AND OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'a superseded episode version cannot become current again';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER episode_versions_immutability
  BEFORE UPDATE ON episode_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_episode_version_immutability();

CREATE TABLE episode_candidates (
  episode_candidate_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  proposed_episode_kind_id TEXT NOT NULL CHECK (
    proposed_episode_kind_id IN (
      'sh.episode.trip', 'sh.episode.relocation',
      'sh.episode.project_phase', 'sh.episode.occurrence',
      'sh.episode.other'
    )
  ),
  proposed_existing_episode_id UUID REFERENCES episodes(episode_id),
  proposed_label TEXT,
  proposed_temporal_anchor JSONB
    CHECK (proposed_temporal_anchor IS NULL
      OR jsonb_typeof(proposed_temporal_anchor) = 'object'),
  proposed_phase TEXT CHECK (
    proposed_phase IN ('planned', 'ongoing', 'completed', 'unknown')
  ),
  explicit_continuity_span TEXT,
  resolution_status TEXT NOT NULL CHECK (
    resolution_status IN ('new', 'matched', 'unresolved')
  ),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'accepted', 'rejected', 'stale')
  ),
  admission_reason_code TEXT,
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL
    REFERENCES model_run_attempts(model_run_attempt_id),
  predecessor_candidate_id UUID
    REFERENCES episode_candidates(episode_candidate_id),
  successor_trigger TEXT CHECK (
    successor_trigger IN ('materially_new_evidence')
  ),
  material_change_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  dedupe_fingerprint TEXT,
  dedupe_fingerprint_key_version TEXT,
  reproposal_policy TEXT CHECK (
    reproposal_policy IN ('material_change_allowed')
  ),
  disposition_reason_code TEXT,
  disposition_policy_version TEXT,
  decided_at TIMESTAMPTZ,
  terminal_effective_at TIMESTAMPTZ,
  terminal_content_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (episode_candidate_id, user_id),
  CHECK (
    (proposed_existing_episode_id IS NULL)
      = (resolution_status IN ('new', 'unresolved'))
    OR (proposed_existing_episode_id IS NOT NULL
      AND resolution_status = 'matched')
  ),
  CHECK (
    (successor_trigger IS NULL) = (predecessor_candidate_id IS NULL)
  ),
  CHECK (
    successor_trigger IS NULL
    OR successor_trigger = 'materially_new_evidence'
      AND array_length(material_change_reason_codes, 1) > 0
  ),
  CHECK (
    status NOT IN ('rejected', 'stale') OR (
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
    content_purged_at IS NULL OR status IN ('rejected', 'stale')
  )
);

CREATE UNIQUE INDEX episode_candidates_terminal_fingerprint_idx
  ON episode_candidates(user_id, dedupe_fingerprint)
  WHERE dedupe_fingerprint IS NOT NULL;

CREATE INDEX episode_candidates_pending_idx
  ON episode_candidates(user_id)
  WHERE status = 'proposed' AND content_purged_at IS NULL;

CREATE INDEX episode_candidates_terminal_expiry_idx
  ON episode_candidates(terminal_content_expires_at)
  WHERE status IN ('rejected', 'stale') AND content_purged_at IS NULL;

-- Terminal candidate envelope columns are immutable; semantic content columns
-- may only transition to NULL together with content_purged_at.
CREATE FUNCTION enforce_episode_candidate_terminal_fence() RETURNS trigger
AS $$
BEGIN
  IF OLD.status IN ('rejected', 'stale') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.terminal_effective_at IS DISTINCT FROM OLD.terminal_effective_at
      OR NEW.terminal_content_expires_at IS DISTINCT FROM
        OLD.terminal_content_expires_at
      OR NEW.disposition_reason_code IS DISTINCT FROM
        OLD.disposition_reason_code
      OR NEW.disposition_policy_version IS DISTINCT FROM
        OLD.disposition_policy_version
      OR NEW.reproposal_policy IS DISTINCT FROM OLD.reproposal_policy
      OR NEW.dedupe_fingerprint IS DISTINCT FROM OLD.dedupe_fingerprint
      OR NEW.dedupe_fingerprint_key_version IS DISTINCT FROM
        OLD.dedupe_fingerprint_key_version
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'terminal episode candidate envelope is immutable';
    END IF;
  END IF;
  IF NEW.content_purged_at IS NOT NULL
    AND OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'a purged episode candidate cannot be re-purged';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER episode_candidates_terminal_fence
  BEFORE UPDATE ON episode_candidates
  FOR EACH ROW EXECUTE FUNCTION enforce_episode_candidate_terminal_fence();

CREATE TABLE episode_candidate_evidence_links (
  episode_candidate_evidence_link_id UUID PRIMARY KEY,
  episode_candidate_id UUID NOT NULL
    REFERENCES episode_candidates(episode_candidate_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_item_id UUID NOT NULL REFERENCES evidence_items(evidence_item_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (episode_candidate_id, evidence_item_id)
);

CREATE INDEX episode_candidate_evidence_links_candidate_idx
  ON episode_candidate_evidence_links(episode_candidate_id);

CREATE TABLE episode_candidate_entity_links (
  episode_candidate_entity_link_id UUID PRIMARY KEY,
  episode_candidate_id UUID NOT NULL
    REFERENCES episode_candidates(episode_candidate_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (episode_candidate_id, entity_id),
  FOREIGN KEY (entity_id, user_id) REFERENCES entities(entity_id, user_id)
);

CREATE INDEX episode_candidate_entity_links_candidate_idx
  ON episode_candidate_entity_links(episode_candidate_id);

CREATE INDEX episode_candidate_entity_links_entity_idx
  ON episode_candidate_entity_links(entity_id, user_id);

CREATE TABLE episode_evidence_links (
  episode_evidence_link_id UUID PRIMARY KEY,
  episode_version_id UUID NOT NULL
    REFERENCES episode_versions(episode_version_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_item_id UUID NOT NULL REFERENCES evidence_items(evidence_item_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (episode_version_id, evidence_item_id)
);

CREATE INDEX episode_evidence_links_version_idx
  ON episode_evidence_links(episode_version_id);

CREATE INDEX episode_evidence_links_evidence_idx
  ON episode_evidence_links(evidence_item_id, user_id);

CREATE TABLE episode_version_entity_links (
  episode_version_entity_link_id UUID PRIMARY KEY,
  episode_version_id UUID NOT NULL
    REFERENCES episode_versions(episode_version_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (episode_version_id, entity_id),
  FOREIGN KEY (entity_id, user_id) REFERENCES entities(entity_id, user_id)
);

CREATE INDEX episode_version_entity_links_version_idx
  ON episode_version_entity_links(episode_version_id);

CREATE INDEX episode_version_entity_links_entity_idx
  ON episode_version_entity_links(entity_id, user_id);

CREATE TABLE episode_build_runs (
  episode_build_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  model_run_attempt_id UUID NOT NULL
    REFERENCES model_run_attempts(model_run_attempt_id),
  status TEXT NOT NULL CHECK (
    status IN ('built', 'stale_source', 'fenced', 'retryable_failed', 'failed')
  ),
  outcome_detail TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  unresolved_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, daily_session_id, source_revision, policy_version)
);

CREATE INDEX episode_build_runs_pending_upgrade_idx
  ON episode_build_runs(user_id, daily_session_id, source_revision)
  WHERE status IN ('retryable_failed', 'failed');

CREATE TABLE episode_impact_reviews (
  episode_impact_review_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  episode_version_id UUID NOT NULL
    REFERENCES episode_versions(episode_version_id),
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('evidence_correction', 'entity_identity_change')
  ),
  trigger_ref_id UUID,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (
    outcome IN ('pending', 'revalidated', 'superseded')
  ),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  UNIQUE (episode_version_id, trigger_type, trigger_ref_id, policy_version)
);

CREATE INDEX episode_impact_reviews_pending_idx
  ON episode_impact_reviews(user_id)
  WHERE outcome = 'pending';

-- The daily build admits through the shared model_role command ledger. The
-- episode-specific command carries the Journal-style unique key so duplicate
-- eligibility evaluation and duplicate dispatch collapse onto one run, and
-- the maintenance command carries the sweep and impact-review passes.
ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (
    command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'journal_regeneration', 'owner_full_purge', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup', 'entity_identity_revalidation',
      'model_role', 'episode_build', 'episode_maintenance'
    )
  );

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (
    event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'journal_regeneration_requested',
      'owner_full_purge_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested', 'memory_correction_followup_requested',
      'entity_identity_revalidation_requested', 'model_role_requested',
      'episode_build_requested', 'episode_maintenance_requested'
    )
  );
