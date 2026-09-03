-- The verified backup window is fractional in practice: Neon Free PITR is a
-- 6-hour history window (0.25 days). The INTEGER retention columns silently
-- truncated that to 0, which also collapsed the deletion fence in the owner
-- purge propagation (longest_known_window_days = 0 read as "no known window").
-- ADR-0080 / ADR-0104.
ALTER TABLE backup_policy_versions
  ALTER COLUMN database_retention_days TYPE NUMERIC(6, 2),
  ALTER COLUMN pitr_retention_days TYPE NUMERIC(6, 2),
  ALTER COLUMN snapshot_retention_days TYPE NUMERIC(6, 2),
  ALTER COLUMN longest_known_window_days TYPE NUMERIC(6, 2);
