/**
 * Runtime-free model-role vocabulary shared by Workflow envelopes and the
 * Node-side model-role executor. Keep this module free of crypto, database,
 * provider, and recovery imports so the Workflow transform can safely use the
 * role allowlist and policy version.
 */
export const ONE_A_3B_MODEL_ROLES = [
  "episode.build",
  "open_loop.extract",
  "reflection.daily",
  "reflection.weekly",
  "bio.write",
  "narrative.validate",
  "proactive.followup",
] as const;

export type OneA3bModelRole = (typeof ONE_A_3B_MODEL_ROLES)[number];

export type ModelRoleFreshnessPolicy = "source_valid:v1" | "exact_head:v1";

export const ONE_A_3B_ROLE_POLICY_VERSION = "1a3b-model-role-policy:v1";

export type ModelRoleAttemptKind =
  | "initial"
  | "technical_retry"
  | "schema_repair";

export function isModelRoleAttemptKind(
  value: string,
): value is ModelRoleAttemptKind {
  return (
    value === "initial" ||
    value === "technical_retry" ||
    value === "schema_repair"
  );
}

export const ONE_A_3B_G1_ENABLED_ROLES = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
] as const satisfies readonly OneA3bModelRole[];

export const ONE_A_3B_G1_DEFERRED_ROLES = [
  "open_loop.extract",
  "bio.write",
  "proactive.followup",
] as const satisfies readonly OneA3bModelRole[];
