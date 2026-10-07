-- Validator v5 retains the10000-token cap and pins low reasoning effort.
-- Provider egress policy identity is bound to the immutable configuration
-- version. Preserve v4 and historical policies; activation still requires
-- a verified release manifest and matching active role pins.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES (
  'deepseek-narrative.validate-egress:g1-release:v5', 'deepseek',
  'narrative.validate', 'narrative.validate:g1-release:v5', NULL, 'active'
)
ON CONFLICT (policy_version) DO NOTHING;
