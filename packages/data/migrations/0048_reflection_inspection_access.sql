-- 1A.3b A4 / issue #202: Reflection Inspector read capability and the
-- content-free audit envelope for exact Evidence expansion. Reflection
-- metadata remains a read-only diagnostic surface; only Evidence expansion
-- may write, and that write is an audit row before any source bytes are read.

ALTER TABLE internal_diagnostic_access_grants
  DROP CONSTRAINT IF EXISTS internal_diagnostic_access_grants_capability_check;

ALTER TABLE internal_diagnostic_access_grants
  ADD CONSTRAINT internal_diagnostic_access_grants_capability_check
  CHECK (
    capability IN (
      'conversation_content:read',
      'candidate_review',
      'reflection_inspection:read'
    )
  );

ALTER TABLE sensitive_access_audits
  DROP CONSTRAINT IF EXISTS sensitive_access_audits_target_type_check,
  DROP CONSTRAINT IF EXISTS sensitive_access_audits_target_shape_check,
  DROP CONSTRAINT IF EXISTS sensitive_access_audits_reason_check;

ALTER TABLE sensitive_access_audits
  ADD CONSTRAINT sensitive_access_audits_target_type_check
  CHECK (target_type IN ('generation_command', 'evidence_item', 'purged_owner')),
  ADD CONSTRAINT sensitive_access_audits_target_shape_check
  CHECK (
    (target_type IN ('generation_command', 'evidence_item') AND target_id IS NOT NULL)
    OR (target_type = 'purged_owner' AND target_id IS NULL)
  ),
  ADD CONSTRAINT sensitive_access_audits_reason_check
  CHECK (
    reason IN (
      'authorized',
      'elevated_capability_required',
      'recent_step_up_required',
      'target_not_found',
      'source_invalidated',
      'content_purged'
    )
  );
