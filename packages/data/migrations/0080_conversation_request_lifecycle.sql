-- Issue #319 (ADR-0151, ADR-0083, ADR-0094): the conversation request lifecycle.
--
-- request_deadline_at     The absolute end-to-end deadline frozen when the
--                         request was accepted. No step starts, and no result is
--                         accepted, after it. NULL for commands created before
--                         this column existed (they keep their old behavior).
-- latest_input_fence_version
--                         Names the freshness rule 'latest_user_input:v1' that
--                         this command was frozen with: an answer may be kept
--                         only while its input is the newest user message of
--                         its Daily Session. NULL = not frozen with the rule.
--
-- Both are nullable additive columns; freshness_policy stays source_valid:v1.
ALTER TABLE generation_commands ADD COLUMN request_deadline_at TIMESTAMPTZ;
ALTER TABLE generation_commands ADD COLUMN latest_input_fence_version TEXT;
