-- 1A.3a / #109: Conversation Action Catalog v2 foundation.
--
-- The handle store was pinned to the single enabled kind
-- (action_kind = 'regenerate_journal') while only one Definition existed.
-- Catalog v2 allows multiple coexisting Definitions (ADR-0091 / ADR-0098), so
-- handles carry any published action kind and eligibility stays owned by the
-- versioned Catalog validation, the Gateway fences, and per-definition handler
-- bindings — not by a schema-level literal. No backfill: existing rows keep
-- their kind. The target_kind check is unchanged in this stage; trust actions
-- introducing new target kinds ship with their own migration.

ALTER TABLE conversation_action_handles
  DROP CONSTRAINT conversation_action_handles_action_kind_check;
