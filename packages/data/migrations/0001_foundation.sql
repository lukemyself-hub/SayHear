CREATE TABLE app_users (
  user_id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleting', 'disabled')),
  data_epoch BIGINT NOT NULL DEFAULT 1 CHECK (data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE internal_owner_identities (
  owner_slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK (owner_slot = 1),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id UUID NOT NULL UNIQUE REFERENCES app_users(user_id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);

CREATE TABLE auth_sessions (
  session_token_hash BYTEA PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);

CREATE VIEW active_internal_owner AS
SELECT
  identity.issuer,
  identity.subject,
  u.user_id
FROM internal_owner_identities identity
INNER JOIN app_users u ON u.user_id = identity.user_id
WHERE identity.active = TRUE
  AND u.status = 'active';

CREATE TABLE backup_policy_versions (
  backup_policy_id UUID PRIMARY KEY,
  policy_version TEXT NOT NULL,
  verification_status TEXT NOT NULL
    CHECK (verification_status IN ('unknown', 'verified')),
  verified_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  configuration_fingerprint TEXT,
  database_retention_days INTEGER CHECK (database_retention_days >= 0),
  pitr_retention_days INTEGER CHECK (pitr_retention_days >= 0),
  snapshot_retention_days INTEGER CHECK (snapshot_retention_days >= 0),
  longest_known_window_days INTEGER CHECK (longest_known_window_days >= 0),
  evidence_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    verification_status <> 'verified'
    OR (
      verified_at IS NOT NULL
      AND valid_until IS NOT NULL
      AND configuration_fingerprint IS NOT NULL
      AND database_retention_days IS NOT NULL
      AND pitr_retention_days IS NOT NULL
      AND snapshot_retention_days IS NOT NULL
      AND longest_known_window_days IS NOT NULL
      AND longest_known_window_days = GREATEST(
        database_retention_days,
        pitr_retention_days,
        snapshot_retention_days
      )
      AND evidence_reference IS NOT NULL
      AND evidence_reference <> ''
      AND valid_until > verified_at
    )
  )
);
