-- G1 release activation provisions model configurations from the verified
-- manifest. Register the four evaluated DeepSeek egress policies first so the
-- activation transaction can fail closed on any provider or role mismatch.

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
    'deepseek-episode.build-egress:g1-release:v1',
    'deepseek',
    'episode.build',
    'episode.build:g1-release:v1',
    NULL,
    'active'
  ),
  (
    'deepseek-reflection.daily-egress:g1-release:v1',
    'deepseek',
    'reflection.daily',
    'reflection.daily:g1-release:v1',
    NULL,
    'active'
  ),
  (
    'deepseek-reflection.weekly-egress:g1-release:v1',
    'deepseek',
    'reflection.weekly',
    'reflection.weekly:g1-release:v1',
    NULL,
    'active'
  ),
  (
    'deepseek-narrative.validate-egress:g1-release:v1',
    'deepseek',
    'narrative.validate',
    'narrative.validate:g1-release:v1',
    NULL,
    'active'
  );
