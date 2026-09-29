-- #252 follow-up: raise narrative.validate's output budget from 8000 to 10000.
--
-- The sealed #252 holdout run is the evidence for this. Of 18 cases, 17 landed
-- at or below 65.8% of the 8000 cap, so the budget was not the binding
-- constraint for them. One case, holdout-validator-reflection-ambiguity-mix,
-- spent all 8000 tokens on reasoning and emitted an empty body
-- (outputLength 0, providerReason max_output_tokens). A ceiling that a single
-- case can exhaust while thinking, having written nothing at all, is the
-- clearest form this failure takes: the model never got to speak.
--
-- A configuration row is immutable on (role, config_version), so the budget
-- lands as a new v4 configuration. v3 is left in place rather than edited,
-- which is what makes the rollback target still exist and still be v2.
--
-- Only narrative.validate changes. The other three G1 roles keep their v2
-- configurations and v2 egress policies untouched.
--
-- The v4 egress policy has to be registered here before activation can bind
-- the v4 configuration: the configuration row carries a foreign key onto
-- provider_egress_policy_versions, and the activation transaction must fail
-- closed when the policy is missing. Several policy versions per role stay
-- 'active'; dispatch resolves the one named by the configuration row, which is
-- the pattern the v1, v2 and v3 rows already follow.

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
    'deepseek-narrative.validate-egress:g1-release:v4',
    'deepseek',
    'narrative.validate',
    'narrative.validate:g1-release:v4',
    NULL,
    'active'
  )
ON CONFLICT (policy_version) DO NOTHING;
