import { describe, expect, it, vi } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  assertWorkflowSafe,
  buildModelRoleCommandIdentity,
  createModelRoleCommandService,
  createModelRoleRegistry,
  ModelRoleConfigurationError,
  ONE_A_3B_F2_PURGE_SURFACE_CONTRACTS,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G2_BUNDLE_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
  ONE_A_3B_MODEL_ROLES,
  ONE_A_3B_ROLE_POLICIES,
  planModelRoleRecovery,
  type ModelRoleCommandRepository,
  type ModelRoleConfigurationSnapshot,
  type OneA3bModelRole,
} from "./index";

function g2Configuration(role: OneA3bModelRole): ModelRoleConfigurationSnapshot {
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: `${role}:config:v1`,
    provider: "synthetic-provider",
    model: "synthetic-model",
    modelSnapshot: "synthetic-model@2026-09-15",
    promptVersion: `${role}-prompt:v1`,
    schemaVersion: `${role}-schema:v1`,
    rolePolicyVersion: "1a3b-model-role-policy:v1",
    providerPolicyVersion: `${role}-egress:v1`,
    rolloutPin: `${role}-rollout:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: { temperature: 0 },
  };
}

function g2Service(
  roles: readonly OneA3bModelRole[],
  repository: Pick<
    ModelRoleCommandRepository,
    "verifyActiveG1Release" | "verifyActiveG2Release"
  >,
) {
  return createModelRoleCommandService({
    registry: createModelRoleRegistry(roles.map(g2Configuration)),
    repository: repository as ModelRoleCommandRepository,
    g2Release: {
      manifestFingerprint: `sha256:${"2".repeat(64)}`,
      baseG1ReleaseFingerprint: `sha256:${"1".repeat(64)}`,
    },
  });
}

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");

const baseAdmission = {
  userId,
  role: "reflection.daily" as const,
  intentKey: "daily-baseline:2026-09-08",
  sourceRevision: 12,
  sourceSnapshot: "daily-session:12",
  expectedDataEpoch: 3,
  inputManifest: [
    { key: "evidence:2", revision: 2, fingerprint: "sha256:evidence-2" },
  ],
};

describe("1A.3b model role runtime", () => {
  it("registers exactly the seven roles without enabling an unevaluated config", () => {
    const registry = createModelRoleRegistry([]);
    expect(registry.registeredRoles).toEqual(ONE_A_3B_MODEL_ROLES);
    expect(registry.enabledRoles).toEqual([]);
    expect(() => registry.requireConfiguration("bio.write")).toThrow(
      ModelRoleConfigurationError,
    );
  });

  it("rejects a configuration that changes the role's frozen retry policy", () => {
    expect(() =>
      createModelRoleRegistry([
        {
          role: "proactive.followup",
          configVersion: "config:v1",
          provider: "openai",
          model: "model",
          modelSnapshot: "snapshot",
          promptVersion: "prompt:v1",
          schemaVersion: "schema:v1",
          rolePolicyVersion: "policy:v1",
          providerPolicyVersion: "provider-policy:v1",
          rolloutPin: "pin:v1",
          freshnessPolicy: "exact_head:v1",
          fallbackMode: "disabled",
          maxTechnicalRetries: 1,
          maxSemanticRepairs: 0,
          parameterSnapshot: {},
        },
      ]),
    ).toThrow(ModelRoleConfigurationError);
  });

  it("keeps different source snapshots outside the same generic dedupe key", () => {
    const first = buildModelRoleCommandIdentity(baseAdmission);
    const second = buildModelRoleCommandIdentity({
      ...baseAdmission,
      sourceSnapshot: "daily-session:13",
      sourceRevision: 13,
    });
    const reordered = buildModelRoleCommandIdentity({
      ...baseAdmission,
      inputManifest: [...baseAdmission.inputManifest].reverse(),
    });
    expect(first.intentKey).not.toBe(second.intentKey);
    expect(first.intentKey).toBe(reordered.intentKey);
  });

  it("allows one same-config technical retry and never retries proactive follow-up", () => {
    expect(
      planModelRoleRecovery({
        role: "reflection.daily",
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "timeout",
      }),
    ).toMatchObject({ action: "retry", nextAttemptKind: "technical_retry" });
    expect(
      planModelRoleRecovery({
        role: "reflection.daily",
        attemptNo: 2,
        technicalRetriesUsed: 1,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "timeout",
      }),
    ).toMatchObject({ action: "terminal", commandStatus: "failed" });
    expect(
      planModelRoleRecovery({
        role: "proactive.followup",
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "timeout",
      }),
    ).toMatchObject({ action: "terminal", commandStatus: "failed" });
  });

  it("keeps Bio semantic repair separate from technical retry", () => {
    expect(
      planModelRoleRecovery({
        role: "bio.write",
        attemptNo: 1,
        technicalRetriesUsed: 1,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "semantic_repair_required",
      }),
    ).toMatchObject({ action: "retry", nextAttemptKind: "schema_repair" });
    expect(
      planModelRoleRecovery({
        role: "bio.write",
        attemptNo: 2,
        technicalRetriesUsed: 1,
        semanticRepairsUsed: 1,
        outcome: "failed",
        failureCode: "semantic_repair_required",
      }),
    ).toMatchObject({ action: "terminal" });
    expect(
      planModelRoleRecovery({
        role: "bio.write",
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "semantic_rejection",
      }),
    ).toMatchObject({ action: "terminal" });
  });

  it("declares every F2 Bio table for the F1 purge-registry handoff", () => {
    expect(ONE_A_3B_F2_PURGE_SURFACE_CONTRACTS.map((entry) => entry.surfaceId)).toEqual([
      "bios",
      "bio_versions",
      "bio_statements",
      "bio_atomic_propositions",
      "bio_claim_links",
      "bio_coverage_units",
      "bio_coverage_members",
      "bio_validation_findings",
    ]);
    for (const entry of ONE_A_3B_F2_PURGE_SURFACE_CONTRACTS) {
      expect(entry.ownerResolution).toBe("user_id");
      expect(entry.clearHandler).not.toBe("");
      expect(entry.independentVerifier).not.toBe("");
      expect(entry.restoreReapplyPolicy).not.toBe("");
    }
  });

  it("verifies the complete G2 bundle with both release fingerprints", async () => {
    const verifyActiveG2Release = vi.fn(
      async (_input: {
        configurations: readonly ModelRoleConfigurationSnapshot[];
        manifestFingerprint: string;
        baseG1ReleaseFingerprint: string;
      }) => {},
    );
    const service = g2Service(ONE_A_3B_G2_ENABLED_ROLES, {
      verifyActiveG2Release,
    });

    await service.verifyActiveG2Release?.();
    expect(verifyActiveG2Release).toHaveBeenCalledOnce();
    const input = verifyActiveG2Release.mock.calls[0]?.[0];
    expect(input?.manifestFingerprint).toBe(`sha256:${"2".repeat(64)}`);
    expect(input?.baseG1ReleaseFingerprint).toBe(`sha256:${"1".repeat(64)}`);
    expect(
      [...(input?.configurations ?? [])].map((entry) => entry.role).sort(),
    ).toEqual([...ONE_A_3B_G2_ENABLED_ROLES].sort());
  });

  it("refuses G2 verification unless the registry holds exactly the bundle regime", async () => {
    const verifyActiveG2Release = vi.fn(
      async (_input: {
        configurations: readonly ModelRoleConfigurationSnapshot[];
        manifestFingerprint: string;
        baseG1ReleaseFingerprint: string;
      }) => {},
    );
    const g1Only = g2Service(ONE_A_3B_G1_ENABLED_ROLES, {
      verifyActiveG2Release,
    });
    await expect(g1Only.verifyActiveG2Release?.()).rejects.toThrow(
      "complete G2 bundle",
    );
    expect(verifyActiveG2Release).not.toHaveBeenCalled();

    const bundleOnly = g2Service(ONE_A_3B_G2_BUNDLE_ROLES, {
      verifyActiveG2Release,
    });
    await expect(bundleOnly.verifyActiveG2Release?.()).rejects.toThrow(
      "complete G2 bundle",
    );
    expect(verifyActiveG2Release).not.toHaveBeenCalled();
  });

  it("keeps verifying the carried-over G1 subset under an active G2 registry", async () => {
    const verifyActiveG1Release = vi.fn(
      async (_input: {
        configurations: readonly ModelRoleConfigurationSnapshot[];
      }) => {},
    );
    const service = g2Service(ONE_A_3B_G2_ENABLED_ROLES, {
      verifyActiveG1Release,
    });

    await service.verifyActiveG1Release?.();
    expect(verifyActiveG1Release).toHaveBeenCalledOnce();
    const input = verifyActiveG1Release.mock.calls[0]?.[0];
    expect(
      [...(input?.configurations ?? [])].map((entry) => entry.role).sort(),
    ).toEqual([...ONE_A_3B_G1_ENABLED_ROLES].sort());
  });

  it("allows only content-free model role workflow metadata", () => {
    expect(() =>
      assertWorkflowSafe({
        modelRole: "reflection.daily",
        generationCommandId: "01984477-1f9a-7b25-a5cc-83c3b21fbc68",
        modelRunAttemptId: "01984477-2f9a-7b25-a5cc-83c3b21fbc68",
        attemptNo: 1,
        attemptKind: "initial",
        rolloutPin: "pin:v1",
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkflowSafe({ sourceSnapshot: "private text" }),
    ).toThrow(/non-allowlisted field/);
  });
});
