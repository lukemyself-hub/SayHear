-- Issue #73 / ADR-0111 / ADR-0094: the persona becomes a three-block versioned
-- artifact (Persona Contract Invariant, Canonical Persona, behavior anchors)
-- and the task instruction becomes versioned per GenerationCommand stage.
--
-- Historical GenerationCommands keep their original persona_version tags and
-- are never batch-rewritten: the new block columns stay NULL on pre-existing
-- rows, and new commands stop writing the legacy single persona_version
-- column (its NOT NULL constraint is dropped for that reason). An old
-- in-flight command therefore fails the compile closed after this migration
-- rather than shipping a defaulted identity layer.

ALTER TABLE generation_commands
  ADD COLUMN persona_contract_invariant_version TEXT;

ALTER TABLE generation_commands
  ADD COLUMN canonical_persona_version TEXT;

ALTER TABLE generation_commands
  ADD COLUMN persona_behavior_anchors_version TEXT;

ALTER TABLE generation_commands
  ALTER COLUMN persona_version DROP NOT NULL;
