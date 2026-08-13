-- 1A.2 / issue #21: a current Journal may advance only by publishing an
-- immutable successor. The previous Version remains readable through lineage.
ALTER TABLE journal_versions
  ADD COLUMN supersedes_version_id UUID
    REFERENCES journal_versions(journal_version_id);

CREATE UNIQUE INDEX journal_versions_one_successor_per_predecessor_idx
  ON journal_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;
