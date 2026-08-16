-- Issue #28: the marker store is a single immutable high-water record per
-- owner. It is outside the business database backup domain, so restoring the
-- business database cannot restore an older marker over a newer one.

DELETE FROM purge_markers older
USING purge_markers newer
WHERE older.user_id = newer.user_id
  AND older.data_epoch < newer.data_epoch;

DROP INDEX IF EXISTS purge_markers_latest_idx;
ALTER TABLE purge_markers DROP CONSTRAINT purge_markers_pkey;
ALTER TABLE purge_markers ADD PRIMARY KEY (user_id);

CREATE INDEX purge_markers_epoch_idx
  ON purge_markers(data_epoch DESC);
