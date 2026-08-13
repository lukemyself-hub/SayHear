-- Issue #24: Freeze the Conversation Agent Harness policy and the immutable
-- Conversation Action Catalog version on every Conversation Decision Command
-- (ADR-0093, ADR-0094). A normal final response still uses one logical model
-- stage; the Harness admits zero state-changing Actions while the Catalog is
-- empty (#25 publishes the first Definition).
--
-- These version identities are content-addressed application constants, not
-- database lookup tables: there is intentionally no foreign key to a
-- `conversation_action_catalog_versions` table, because the Catalog is an
-- immutable in-memory seam that must never expose internal Journal, Workflow,
-- Claim, Profile, deletion, or CRUD operations (issue #24 AC5).

ALTER TABLE generation_commands
  ADD COLUMN harness_policy_version TEXT NOT NULL
    DEFAULT 'conversation-harness:v1',
  ADD COLUMN conversation_action_catalog_version TEXT NOT NULL
    DEFAULT 'conversation-action-catalog:empty:v1';

-- The default only backfills historical rows; new Decision Commands must always
-- freeze the policy and Catalog version in force at creation time rather than
-- silently inheriting a column default.
ALTER TABLE generation_commands
  ALTER COLUMN harness_policy_version DROP DEFAULT,
  ALTER COLUMN conversation_action_catalog_version DROP DEFAULT;
