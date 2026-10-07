-- Daily generation v6 raises the output budget from 10000 to 20000.
--
-- Luke authorized this bounded Daily-only increase on 2026-10-04.
-- Weekly already runs at 20000; Episode and narrative.validate stay at 10000,
-- and Bio, Open Loop and Proactive remain off. Only the output budget changes:
-- the Daily prompt version (reflection-daily:eval:v5), model, snapshot,
-- temperature, low reasoning effort, retry policy and disabled fallback all
-- stay frozen.
--
-- The synthetic diagnostic is not release evidence. A wholly synthetic Daily
-- request with 24 Evidence items failed at 10000 with
-- output_budget_exhausted / max_output_tokens (outputTokens 10000,
-- reasoningTokens 6844, outputLength 9201); the companion 22-item baseline
-- completed (outputTokens 2854). An independent candidate call at 20000
-- completed typed output (outputTokens 3507, reasoningTokens 883), but it is a
-- stochastic single call, not a deterministic replay guarantee or acceptance.
--
-- A configuration row is immutable on (role, config_version), and the provider
-- egress policy identity is bound to that version, so the raised budget lands
-- as a new v6 configuration that requires this new policy row. v5 and every
-- earlier row stay in place for rollback history, and activation still
-- requires a verified release manifest.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-reflection.daily-egress:g1-release:v6', 'deepseek',
   'reflection.daily', 'reflection.daily:g1-release:v6', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
