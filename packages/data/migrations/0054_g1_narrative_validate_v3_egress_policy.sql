-- Two release-identity gaps are closed here, both found by reading the live
-- database rather than the repository.
--
-- 1. Production is already live at g1-release:v2 on all four G1 roles, but no
--    migration ever registered the v2 egress policies. They were applied out of
--    band, so the repository cannot reproduce the state production is running
--    and a freshly migrated database has no v2 policy row at all. The v2 rows
--    are backfilled below with ON CONFLICT DO NOTHING, which is a no-op in
--    production where they already exist and a repair everywhere else.
--
-- 2. #252 raises only narrative.validate's output budget, from 4000 to 8000
--    tokens, after the diagnosis showed 7 of 18 cases exhausting the 4000
--    budget (6 of them spending all 4000 on reasoning and emitting nothing).
--    model_role_configurations is immutable on (role, config_version) and
--    bindActiveG1Release compares parameter_snapshot on conflict, so the live v2
--    row cannot be reused and the budget lands as a new v3 configuration.
--
-- provider_policy_version is a foreign key onto this table, and the activation
-- transaction must fail closed when the policy is missing, so the v3 policy has
-- to be registered here before activation can bind the v3 configuration.
--
-- The other three G1 roles keep their existing v2 configurations and policies.
-- Only the rollout pin is new, and pins are bound to a manifest fingerprint
-- rather than to a parameter snapshot, so they are not provisioned here.
--
-- Several policy versions per role stay 'active'; dispatch resolves the one
-- named by the configuration row. That is the pattern the existing v1 and v2
-- rows already follow, and this migration preserves it.

INSERT INTO provider_egress_policy_versions (
  policy_version,
  provider,
  role,
  model_config_version,
  consent_policy_version,
  status
)
VALUES
  (
    'deepseek-episode.build-egress:g1-release:v2',
    'deepseek',
    'episode.build',
    'episode.build:g1-release:v2',
    NULL,
    'active'
  ),
  (
    'deepseek-reflection.daily-egress:g1-release:v2',
    'deepseek',
    'reflection.daily',
    'reflection.daily:g1-release:v2',
    NULL,
    'active'
  ),
  (
    'deepseek-reflection.weekly-egress:g1-release:v2',
    'deepseek',
    'reflection.weekly',
    'reflection.weekly:g1-release:v2',
    NULL,
    'active'
  ),
  (
    'deepseek-narrative.validate-egress:g1-release:v2',
    'deepseek',
    'narrative.validate',
    'narrative.validate:g1-release:v2',
    NULL,
    'active'
  ),
  (
    'deepseek-narrative.validate-egress:g1-release:v3',
    'deepseek',
    'narrative.validate',
    'narrative.validate:g1-release:v3',
    NULL,
    'active'
  )
ON CONFLICT (policy_version) DO NOTHING;
