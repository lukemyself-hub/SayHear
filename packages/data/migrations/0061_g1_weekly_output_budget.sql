-- Weekly generation v5 raises the output budget from 10000 to 20000 tokens.
--
-- The same synthetic 3-day W38 Weekly request failed at 10000: the Provider
-- returned response.incomplete / max_output_tokens with usage input 8636 /
-- output 10000 / reasoning 10000 and no visible body. The authorized
-- controlled replay of that exact request at 20000 completed
-- typed_schema_accepted with input 8636 / output 13285 / reasoning 8571. The
-- replay is diagnostic evidence for this budget only; it is not frozen release
-- or hosted acceptance evidence.
--
-- Only the output budget changes. The Weekly prompt version
-- (reflection-weekly:eval:v4), model, snapshot, temperature, low reasoning
-- effort, retry policy and disabled fallback all stay frozen.
--
-- A configuration row is immutable on (role, config_version), and the
-- provider egress policy identity is bound to that version, so the raised
-- budget lands as a new v5 configuration that requires this new policy row.
-- v4 and every earlier row stay in place for rollback history, and activation
-- still requires a verified release manifest.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-reflection.weekly-egress:g1-release:v5', 'deepseek',
   'reflection.weekly', 'reflection.weekly:g1-release:v5', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
