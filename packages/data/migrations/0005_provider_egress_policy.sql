CREATE TABLE provider_egress_policy_versions (
  policy_version TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'conversation.text'),
  model_config_version TEXT NOT NULL,
  consent_policy_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO provider_egress_policy_versions (
  policy_version,
  provider,
  role,
  model_config_version,
  consent_policy_version,
  status
)
VALUES (
  'openai-conversation-text:v1',
  'openai',
  'conversation.text',
  'conversation-text-champion:v1',
  NULL,
  'active'
);

CREATE TABLE provider_egress_consents (
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  provider TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'conversation.text'),
  consent_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider, role, consent_policy_version),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

ALTER TABLE generation_commands
  ADD COLUMN provider_policy_version TEXT NOT NULL
    DEFAULT 'openai-conversation-text:v1';

ALTER TABLE generation_commands
  ADD COLUMN consent_policy_version TEXT;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_provider_policy_fk
  FOREIGN KEY (provider_policy_version)
  REFERENCES provider_egress_policy_versions(policy_version);

ALTER TABLE generation_commands
  ALTER COLUMN provider_policy_version DROP DEFAULT;

UPDATE provider_egress_dispositions
SET provider_policy_version = 'openai-conversation-text:v1'
WHERE provider_policy_version = 'conversation-text-champion:v1';

ALTER TABLE provider_egress_dispositions
  ADD CONSTRAINT provider_egress_dispositions_provider_policy_fk
  FOREIGN KEY (provider_policy_version)
  REFERENCES provider_egress_policy_versions(policy_version);

CREATE TABLE internal_diagnostic_access_grants (
  session_token_hash BYTEA NOT NULL
    REFERENCES auth_sessions(session_token_hash) ON DELETE CASCADE,
  capability TEXT NOT NULL
    CHECK (capability = 'conversation_content:read'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  step_up_authenticated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_token_hash, capability)
);

CREATE TABLE sensitive_access_audits (
  sensitive_access_audit_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  capability TEXT NOT NULL
    CHECK (capability = 'conversation_content:read'),
  target_type TEXT NOT NULL CHECK (target_type = 'generation_command'),
  target_id UUID NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('allowed', 'denied')),
  reason TEXT NOT NULL
    CHECK (
      reason IN (
        'authorized',
        'elevated_capability_required',
        'recent_step_up_required',
        'target_not_found'
      )
    ),
  policy_version TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sensitive_access_audits_user_time_idx
  ON sensitive_access_audits(user_id, accessed_at);
