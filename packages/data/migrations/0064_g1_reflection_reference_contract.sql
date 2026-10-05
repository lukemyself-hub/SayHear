-- Reflection reference-contract v7 (Daily) / v6 (Weekly).
--
-- The frozen Reflection instruction now states the deterministic reference
-- protocol the Tier-1 gate already enforces: baselineClaimIds must copy only
-- supplied baseline[].claimId values, every proposition cites at least one
-- supplied Evidence ID, change_observation lists a baseline subset, and
-- cross_day_theme / change_observation draw from at least two distinct Daily
-- Sessions. The instruction also no longer receives the internal
-- claimVersionId lineage field. A changed prompt is a new immutable
-- configuration version, so Daily moves v6 -> v7 (prompt
-- reflection-daily:eval:v6) and Weekly v5 -> v6 (prompt
-- reflection-weekly:eval:v5). Episode and narrative.validate are unchanged.
--
-- Only the prompt contract changes. The output budgets stay frozen at Daily
-- 20000, Weekly 20000, Episode 10000 and narrative.validate 10000, with low
-- reasoning effort, the same model, snapshot, temperature, retry policy and
-- disabled fallback. No model, routing, gate or semantic-policy change.
--
-- A configuration row is immutable on (role, config_version), and the
-- provider egress policy identity is bound to that version, so each changed
-- prompt lands as a new configuration that requires this new policy row. Every
-- earlier row stays in place for rollback history, and activation still
-- requires a verified release manifest.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-reflection.daily-egress:g1-release:v7', 'deepseek',
   'reflection.daily', 'reflection.daily:g1-release:v7', NULL, 'active'),
  ('deepseek-reflection.weekly-egress:g1-release:v6', 'deepseek',
   'reflection.weekly', 'reflection.weekly:g1-release:v6', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
