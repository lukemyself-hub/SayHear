-- ADR-0147: OpenCode Go (DeepSeek V4.1 Flash) becomes the live Provider for the
-- Conversation Champion, the Journal background roles, and the four G1 roles.
--
-- The four G1 roles move to their new immutable configurations (Episode
-- v5 -> v6, Daily v7 -> v8, Weekly v6 -> v7, narrative.validate v5 -> v6). The
-- activation transaction provisions those configurations from the verified
-- manifest and fails closed on any provider / role / policy mismatch, so the
-- matching egress policies must be registered first. This migration only adds
-- the new rows; every earlier DeepSeek / OpenAI policy row stays in place for
-- rollback history and published migrations 0062/0063/0064 are not modified.
INSERT INTO provider_egress_policy_versions (
  policy_version,
  provider,
  role,
  model_config_version,
  consent_policy_version,
  status
)
VALUES
  (
    'opencode-go-episode.build-egress:g1-release:v6',
    'opencode-go',
    'episode.build',
    'episode.build:g1-release:v6',
    NULL,
    'active'
  ),
  (
    'opencode-go-reflection.daily-egress:g1-release:v8',
    'opencode-go',
    'reflection.daily',
    'reflection.daily:g1-release:v8',
    NULL,
    'active'
  ),
  (
    'opencode-go-reflection.weekly-egress:g1-release:v7',
    'opencode-go',
    'reflection.weekly',
    'reflection.weekly:g1-release:v7',
    NULL,
    'active'
  ),
  (
    'opencode-go-narrative.validate-egress:g1-release:v6',
    'opencode-go',
    'narrative.validate',
    'narrative.validate:g1-release:v6',
    NULL,
    'active'
  )
ON CONFLICT (policy_version) DO NOTHING;

-- Widen the Evidence lineage provider allowlist to admit the new honest
-- Provider identity. Existing OpenAI and DeepSeek rows are preserved; the
-- published table definition in 0010 is immutable, so the contract change is a
-- forward migration.
ALTER TABLE evidence_source_snapshots
  DROP CONSTRAINT evidence_source_snapshots_champion_provider_check;
ALTER TABLE evidence_source_snapshots
  ADD CONSTRAINT evidence_source_snapshots_champion_provider_check
  CHECK (champion_provider IN ('openai', 'deepseek', 'opencode-go'));
