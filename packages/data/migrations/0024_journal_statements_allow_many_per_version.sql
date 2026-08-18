-- A Journal version contains many statements, and every statement in a version
-- shares the same (user_id, source_revision, evidence_source_snapshot_id). The
-- UNIQUE on that tuple in journal_statements collapsed the intended 1:many
-- statements-per-version into 1:1, so the second statement of any real
-- multi-statement draft hit "duplicate key value violates unique constraint
-- journal_statements_journal_version_id_user_id_source_revisi_key" and the
-- whole version rolled back (production replay 2026-08-18).
--
-- journal_versions keeps its own UNIQUE over the same tuple: it is the FK
-- target for journal_statements and correctly models one version -> one
-- snapshot. statement uniqueness within a version is already enforced by
-- UNIQUE (journal_version_id, statement_index) and
-- UNIQUE (journal_version_id, statement_key).
ALTER TABLE journal_statements
  DROP CONSTRAINT IF EXISTS journal_statements_journal_version_id_user_id_source_revisi_key;
