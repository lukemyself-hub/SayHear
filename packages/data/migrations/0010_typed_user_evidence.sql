-- 1A.2 / issue #19: immutable, owner-scoped Evidence references.
CREATE TABLE evidence_source_snapshots (
  evidence_source_snapshot_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  extraction_policy_version TEXT NOT NULL,
  command_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  champion_config_version TEXT NOT NULL,
  champion_provider TEXT NOT NULL CHECK (champion_provider IN ('openai', 'deepseek')),
  champion_model TEXT NOT NULL,
  champion_snapshot TEXT NOT NULL,
  champion_provider_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, source_revision, extraction_policy_version),
  UNIQUE (evidence_source_snapshot_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id)
);
CREATE TABLE evidence_items (
  evidence_item_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  evidence_source_snapshot_id UUID NOT NULL REFERENCES evidence_source_snapshots(evidence_source_snapshot_id),
  source_event_id UUID NOT NULL,
  source_revision_id UUID NOT NULL,
  source_actor TEXT NOT NULL CHECK (source_actor = 'user'),
  source_status TEXT NOT NULL CHECK (source_status IN ('final', 'corrected')),
  locator_type TEXT NOT NULL CHECK (locator_type IN ('whole_revision', 'segment', 'text_span', 'time_range')),
  locator_key TEXT NOT NULL,
  extraction_policy_version TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('factual_support', 'subjective_report')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, source_revision_id, locator_key, extraction_policy_version),
  UNIQUE (evidence_item_id, user_id, evidence_source_snapshot_id),
  FOREIGN KEY (source_revision_id, source_event_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, conversation_event_id, user_id),
  FOREIGN KEY (evidence_source_snapshot_id, user_id)
    REFERENCES evidence_source_snapshots(evidence_source_snapshot_id, user_id)
);
CREATE TABLE evidence_lineage (
  evidence_item_id UUID PRIMARY KEY REFERENCES evidence_items(evidence_item_id),
  command_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX evidence_items_snapshot_idx ON evidence_items(evidence_source_snapshot_id);
CREATE FUNCTION reject_evidence_item_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EvidenceItem is immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER evidence_items_immutable BEFORE UPDATE OR DELETE ON evidence_items
FOR EACH ROW EXECUTE FUNCTION reject_evidence_item_mutation();
CREATE TRIGGER evidence_source_snapshots_immutable BEFORE UPDATE OR DELETE ON evidence_source_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_evidence_item_mutation();
