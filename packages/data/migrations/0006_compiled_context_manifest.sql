ALTER TABLE generation_commands
  ADD COLUMN output_format_version TEXT;

ALTER TABLE generation_commands
  ADD COLUMN persona_version TEXT;

UPDATE generation_commands
SET
  output_format_version = 'conversation-output:v1',
  persona_version = 'sayhear-persona:v1';

ALTER TABLE generation_commands
  ALTER COLUMN output_format_version SET NOT NULL,
  ALTER COLUMN persona_version SET NOT NULL;

ALTER TABLE compiled_contexts
  ADD COLUMN policy_versions JSONB;

ALTER TABLE compiled_contexts
  ADD COLUMN sections JSONB;

ALTER TABLE compiled_contexts
  ADD COLUMN integrity_algorithm TEXT;

ALTER TABLE compiled_contexts
  ADD COLUMN integrity_key_version TEXT;

UPDATE compiled_contexts context
SET
  policy_versions = jsonb_build_object(
    'localePolicyVersion', command.locale_policy_version,
    'outputFormatVersion', command.output_format_version,
    'personaVersion', command.persona_version,
    'productPolicyVersion', command.product_policy_version,
    'relationshipPolicyVersion', command.relationship_policy_version,
    'safetyPolicyVersion', command.safety_policy_version,
    'taskInstructionVersion', command.prompt_version
  ),
  sections = jsonb_build_array(
    jsonb_build_object(
      'budgetTokens', context.section_budgets -> 'committedRawEvents',
      'contentHmac', context.content_hmac,
      'key', 'committed_raw_events',
      'ordinal', 0,
      'reference', 'legacy-compiled-context',
      'selectedTokens', context.total_tokens,
      'truncatable', TRUE
    )
  ),
  integrity_algorithm = 'hmac-sha256',
  integrity_key_version = 'context-integrity:legacy'
FROM generation_commands command
WHERE command.generation_command_id = context.generation_command_id;

ALTER TABLE compiled_contexts
  ALTER COLUMN policy_versions SET NOT NULL,
  ALTER COLUMN sections SET NOT NULL,
  ALTER COLUMN integrity_algorithm SET NOT NULL,
  ALTER COLUMN integrity_key_version SET NOT NULL;

ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_policy_versions_object_check
  CHECK (jsonb_typeof(policy_versions) = 'object');

ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_sections_array_check
  CHECK (jsonb_typeof(sections) = 'array');

ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_integrity_algorithm_check
  CHECK (integrity_algorithm = 'hmac-sha256');

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN sequence_no BIGINT;

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN section TEXT;

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN selection_order INTEGER;

UPDATE compiled_context_revision_refs ref
SET
  sequence_no = event.sequence_no,
  section = CASE
    WHEN ref.conversation_event_revision_id = command.input_revision_id
      THEN 'current_user_input'
    ELSE 'committed_raw_events'
  END
FROM conversation_event_revisions revision
INNER JOIN conversation_events event
  ON event.conversation_event_id = revision.conversation_event_id
INNER JOIN compiled_contexts context
  ON context.user_id = event.user_id
INNER JOIN generation_commands command
  ON command.compiled_context_id = context.compiled_context_id
WHERE revision.conversation_event_revision_id =
    ref.conversation_event_revision_id
  AND revision.user_id = ref.user_id
  AND context.compiled_context_id = ref.compiled_context_id;

WITH history_order AS (
  SELECT
    compiled_context_id,
    ordinal,
    ROW_NUMBER() OVER (
      PARTITION BY compiled_context_id
      ORDER BY sequence_no DESC
    ) - 1 AS selection_order
  FROM compiled_context_revision_refs
  WHERE section = 'committed_raw_events'
)
UPDATE compiled_context_revision_refs ref
SET selection_order = history_order.selection_order
FROM history_order
WHERE history_order.compiled_context_id = ref.compiled_context_id
  AND history_order.ordinal = ref.ordinal;

ALTER TABLE compiled_context_revision_refs
  ALTER COLUMN sequence_no SET NOT NULL,
  ALTER COLUMN section SET NOT NULL;

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_sequence_check
  CHECK (sequence_no > 0);

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_section_check
  CHECK (section IN ('committed_raw_events', 'current_user_input'));

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_selection_order_check
  CHECK (
    (
      section = 'committed_raw_events'
      AND selection_order IS NOT NULL
      AND selection_order >= 0
    )
    OR (
      section = 'current_user_input'
      AND selection_order IS NULL
    )
  );
