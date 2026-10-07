-- ADR-0129 + ADR-0005: the Phase 1 Internal Owner reads Reflection prose with
-- the owner-scoped `reflection_inspection:read` capability and no repeated
-- step-up. `createSession` now provisions that capability for every new Owner
-- login; this forward migration backfills only the currently usable Owner
-- sessions that predate that provisioning so an existing real Owner session
-- keeps working without manual operator SQL or a fake token.
--
-- Scope is deliberately narrow:
--   * only sessions that are not yet expired,
--   * only sessions whose user is a currently active Internal Owner
--     (active_internal_owner already joins an active app_user),
--   * only the `reflection_inspection:read` capability.
-- ON CONFLICT DO NOTHING means an explicitly revoked grant stays revoked and a
-- capability that is already present is left untouched. No expired, non-owner,
-- deleted, source-content, or candidate-review grant is created.
INSERT INTO internal_diagnostic_access_grants (
  session_token_hash,
  capability,
  status,
  step_up_authenticated_at,
  updated_at
)
SELECT
  session.session_token_hash,
  'reflection_inspection:read',
  'active',
  NULL,
  CURRENT_TIMESTAMP
FROM auth_sessions session
INNER JOIN active_internal_owner owner
  ON owner.user_id = session.user_id
WHERE session.expires_at > CURRENT_TIMESTAMP
ON CONFLICT (session_token_hash, capability) DO NOTHING;
