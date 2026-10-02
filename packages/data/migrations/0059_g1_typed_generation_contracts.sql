-- G1 generation v5 tells Episode and Daily Reflection the typed contracts
-- admission already enforces: Episode kindFields allowlist / boundary date
-- formats / non-empty cited Evidence / resolvable entity anchors, and Daily's
-- day_observation-only statement scope. A prompt change needs a new immutable
-- configuration version, and provider egress policy identity is bound to that
-- version. Weekly keeps its unchanged v4 configuration and policy; Validator
-- stays at v5. Preserve every previous policy row for rollback history.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-episode.build-egress:g1-release:v5', 'deepseek',
   'episode.build', 'episode.build:g1-release:v5', NULL, 'active'),
  ('deepseek-reflection.daily-egress:g1-release:v5', 'deepseek',
   'reflection.daily', 'reflection.daily:g1-release:v5', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
