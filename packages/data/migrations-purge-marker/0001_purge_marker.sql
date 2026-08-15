-- 1A.2 / issue #27: minimal Internal Owner purge marker store.
--
-- This schema lives in a SEPARATE database on the same PostgreSQL instance
-- (PURGE_MARKER_DATABASE_URL), outside the business database's PITR/dump
-- backup domain: a same-database schema would be restored together with old
-- business backups and defeat the anti-resurrection purpose (architecture
-- 20.6). It records only the deletion epoch, time, and content-free receipts
-- with retention horizons — never conversation, Journal, Evidence, or any
-- other user content.

CREATE TABLE purge_markers (
  user_id UUID NOT NULL,
  data_epoch BIGINT NOT NULL CHECK (data_epoch > 0),
  status TEXT NOT NULL
    CHECK (status IN ('active_system_deleted', 'retention_pending')),
  purged_at TIMESTAMPTZ NOT NULL,
  -- NULL when the longest confirmed backup window was unknown at purge time;
  -- the lifecycle then stays at retention_pending (architecture 20.6).
  backup_retention_until TIMESTAMPTZ,
  receipts JSONB NOT NULL CHECK (jsonb_typeof(receipts) = 'array'),
  written_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, data_epoch)
);

CREATE INDEX purge_markers_latest_idx
  ON purge_markers(user_id, data_epoch DESC);
