-- 2026-10-04 G1 output-budget release: raise the four permanent output caps.
--
-- Authorization: Luke 2026-10-04 directed setting each cap high enough to stop
-- truncating real tasks, adding token-budget monitoring, running one full task,
-- and only then analysing waste and optimising the budgets
-- (docs/tasks/g1-output-budget-20261004.md). Two full Go profiling runs with a
-- temporary 100000 cap and synthetic data showed the previous budgets
-- truncating real work: Episode 11612 vs 10000, narrative.validate 20713 vs
-- 10000, Weekly 19805 vs 20000, and Daily 13566 vs 20000.
--
-- The caps rise to E32000/D32000/W48000/V48000, each at least 2.3x the worst
-- observed output. Only the cap moves: model (deepseek-v4.1-flash), prompt,
-- schema, temperature, reasoning.effort low, retries and fallback:none all stay
-- frozen, and Bio, Open Loop and Proactive stay disabled.
--
-- A configuration row is immutable on (role, config_version) and the provider
-- egress policy identity is bound to that version, so each raised budget lands
-- as a new v7/v9/v8/v7 configuration that requires its new policy row. Every
-- earlier row stays in place for rollback history, and published migrations
-- 0062-0065 are not modified.
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
    'opencode-go-episode.build-egress:g1-release:v7',
    'opencode-go',
    'episode.build',
    'episode.build:g1-release:v7',
    NULL,
    'active'
  ),
  (
    'opencode-go-reflection.daily-egress:g1-release:v9',
    'opencode-go',
    'reflection.daily',
    'reflection.daily:g1-release:v9',
    NULL,
    'active'
  ),
  (
    'opencode-go-reflection.weekly-egress:g1-release:v8',
    'opencode-go',
    'reflection.weekly',
    'reflection.weekly:g1-release:v8',
    NULL,
    'active'
  ),
  (
    'opencode-go-narrative.validate-egress:g1-release:v7',
    'opencode-go',
    'narrative.validate',
    'narrative.validate:g1-release:v7',
    NULL,
    'active'
  )
ON CONFLICT (policy_version) DO NOTHING;
