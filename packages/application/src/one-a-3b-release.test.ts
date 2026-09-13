import { describe, expect, it } from "vitest";

import {
  buildG1ReleaseIdentityFingerprint,
  buildOneA3bG1ReleaseManifest,
  ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
  verifyOneA3bG1ReleaseManifest,
  type OneA3bG1Evidence,
} from "./one-a-3b-release";
import type { ModelRoleConfigurationSnapshot } from "./model-role-runtime";

const gitCommit = "a".repeat(40);
const migrations = [
  { name: "0044_1a3b_model_roles_and_bio_read_schema.sql", sha256: "b".repeat(64) },
  { name: "0048_reflection_inspection_access.sql", sha256: "c".repeat(64) },
] as const;
const purgeMarkerMigrations = [
  { name: "0001_purge_marker.sql", sha256: "d".repeat(64) },
  { name: "0002_latest_marker_high_water.sql", sha256: "e".repeat(64) },
] as const;

const roleConfigurations: readonly ModelRoleConfigurationSnapshot[] =
  ONE_A_3B_G1_ENABLED_ROLES.map((role, index) => ({
    role,
    configVersion: `synthetic-${role}:v1`,
    provider: "synthetic-provider",
    model: "synthetic-model",
    modelSnapshot: `synthetic-model@${index + 1}`,
    promptVersion: `synthetic-prompt:${role}:v1`,
    schemaVersion: `synthetic-schema:${role}:v1`,
    rolePolicyVersion: "1a3b-model-role-policy:v1",
    providerPolicyVersion: `synthetic-egress:${role}:v1`,
    rolloutPin: `synthetic-rollout:${role}:v1`,
    freshnessPolicy:
      role === "episode.build" ? "source_valid:v1" : "exact_head:v1",
    fallbackMode: "disabled",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
    parameterSnapshot: { fixture: "synthetic" },
  }));

function evidence(
  overrides: Partial<OneA3bG1Evidence> = {},
): readonly OneA3bG1Evidence[] {
  return ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA.map((criterion, index) => ({
    criterion,
    fixtureIds: [`synthetic-${criterion.toLowerCase()}`],
    command: `pnpm verify:g1 ${criterion}`,
    artifactSha256: (index + 1).toString(16).repeat(64),
    artifactPath: `eval/continuation-acceptance-1a3b/run/${criterion.toLowerCase()}.json`,
    owner: "Luke",
    source:
      criterion === "AC-M01"
        ? "provider"
        : criterion === "AC-W01"
          ? "hosted"
          : "ci",
    status: "verified",
    ...(overrides.criterion === criterion ? overrides : {}),
  }));
}

const validatorCalibration = {
  ledgerPath:
    "eval/continuation-acceptance-1a3b/run/validator-ledger.json",
  ledgerSha256: "e".repeat(64),
  ledgerVersion: ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION,
  precisionReportPath:
    "eval/continuation-acceptance-1a3b/run/validator-precision-report.json",
  precisionReportSha256: "a".repeat(64),
  precisionReportVersion: "1a3b-f3-validator-precision-report:v1" as const,
  precisionTotalCases: 6 as const,
  precisionFalseBlockingCases: 0,
  f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
  totalCases: 18 as const,
  acceptedCases: 18,
  maxRejects: 0,
  humanOwner: "Luke" as const,
  status: "verified" as const,
};

function build(overrides: Partial<Parameters<typeof buildOneA3bG1ReleaseManifest>[0]> = {}) {
  return buildOneA3bG1ReleaseManifest({
    gitCommit,
    migrations,
    purgeMarkerMigrations,
    roleConfigurations,
    fixture: {
      f3ManifestPath: "eval/continuation-acceptance-1a3b/run/manifest.json",
      f3ManifestSha256: "d".repeat(64),
      f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
      fixtureSeed: 196,
      sampleSeed: 1960,
    },
    validatorCalibration,
    commands: ["CI=true pnpm validate"],
    evidence: evidence(),
    cutoverState: "disabled",
    createdAt: "2026-09-10T20:00:00.000Z",
    ...overrides,
  });
}

describe("1A.3b G1 release manifest", () => {
  it("stays blocked when hosted evidence is not verified", () => {
    const manifest = build({
      roleConfigurations: [],
      evidence: evidence({
        criterion: "AC-W01",
        status: "pending",
        artifactSha256: null,
        owner: "unassigned",
        note: "Hosted synthetic canary has not run.",
      }),
    });

    expect(manifest.status).toBe("blocked");
    expect(verifyOneA3bG1ReleaseManifest(manifest)).toEqual({
      mismatches: [],
      passed: true,
    });
  });

  it("freezes the four G1 role configurations and can become ready for cutover", () => {
    const manifest = build();

    expect(manifest.status).toBe("ready_for_cutover");
    expect(manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.roles.enabledRoles).toEqual(ONE_A_3B_G1_ENABLED_ROLES);
    expect(verifyOneA3bG1ReleaseManifest(manifest).passed).toBe(true);

    const rebuilt = build({ createdAt: "2026-09-11T20:00:00.000Z" });
    expect(rebuilt.fingerprint).toBe(manifest.fingerprint);
  });

  it("rejects a deferred role, and requires hosted and Provider evidence provenance", () => {
    expect(() =>
      build({
        roleConfigurations: [
          ...roleConfigurations,
          {
            ...roleConfigurations[0]!,
            role: "bio.write",
          },
        ],
      }),
    ).toThrow("deferred");

    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-W01",
          source: "local",
        }),
      }),
    ).toThrow("hosted");

    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-M01",
          source: "local",
        }),
      }),
    ).toThrow("provider");

    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-X04",
          source: "human",
        }),
      }),
    ).toThrow("automated");
  });

  it("cannot mark an incomplete manifest active", () => {
    expect(() =>
      build({
        roleConfigurations: [],
        cutoverState: "active",
      }),
    ).toThrow("active");
  });

  it("accepts the 10% validator miss budget and blocks beyond it", () => {
    const manifest = build({
      validatorCalibration: {
        ...validatorCalibration,
        acceptedCases: 17,
        maxRejects: 1,
      },
    });

    expect(manifest.status).toBe("ready_for_cutover");
    expect(manifest.validatorCalibration.acceptedCases).toBe(17);
    expect(verifyOneA3bG1ReleaseManifest(manifest).passed).toBe(true);
  });

  it("keeps G1 blocked while the rejected case exceeds the human-accepted budget", () => {
    const manifest = build({
      validatorCalibration: {
        ...validatorCalibration,
        acceptedCases: 17,
        maxRejects: 0,
        status: "pending",
        note: "One case awaits Luke's adjudication.",
      },
    });

    expect(manifest.status).toBe("blocked");
    expect(verifyOneA3bG1ReleaseManifest(manifest).passed).toBe(true);
    expect(() =>
      build({
        validatorCalibration: {
          ...validatorCalibration,
          acceptedCases: 17,
          maxRejects: 0,
        },
      }),
    ).toThrow("10% error budget");
    expect(() =>
      build({
        validatorCalibration: {
          ...validatorCalibration,
          acceptedCases: 16,
          maxRejects: 2,
        },
      }),
    ).toThrow("10% error budget");
  });

  it("requires a complete precision corpus with zero false blocks", () => {
    expect(() =>
      build({
        validatorCalibration: {
          ...validatorCalibration,
          precisionFalseBlockingCases: 1,
        },
      }),
    ).toThrow("cannot be verified");

    const falseBlocked = build({
      validatorCalibration: {
        ...validatorCalibration,
        precisionFalseBlockingCases: 1,
        status: "blocked",
        note: "One clean precision case was falsely blocked.",
      },
    });
    expect(falseBlocked.status).toBe("blocked");
    expect(verifyOneA3bG1ReleaseManifest(falseBlocked).passed).toBe(true);

    const manifest = build();
    const incomplete = {
      ...manifest,
      validatorCalibration: {
        ...manifest.validatorCalibration,
        precisionTotalCases: 5,
      },
    };
    expect(verifyOneA3bG1ReleaseManifest(incomplete).mismatches).toContain(
      "validator precision corpus must contain exactly 6 cases",
    );
  });

  it("freezes a release identity that excludes evidence and timestamps", () => {
    const manifest = build();
    expect(manifest.releaseIdentityFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const rebuilt = build({ createdAt: "2026-09-11T20:00:00.000Z" });
    expect(rebuilt.releaseIdentityFingerprint).toBe(
      manifest.releaseIdentityFingerprint,
    );

    const expected = buildG1ReleaseIdentityFingerprint({
      gitCommit,
      migrations: [...migrations],
      purgeMarkerMigrations: [...purgeMarkerMigrations],
      roleConfigurations,
      fixture: {
        f3ManifestSha256: "d".repeat(64),
        f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
        fixtureSeed: 196,
        sampleSeed: 1960,
      },
    });
    expect(manifest.releaseIdentityFingerprint).toBe(expected);

    const tampered = {
      ...manifest,
      releaseIdentityFingerprint: `sha256:${"0".repeat(64)}`,
    };
    expect(verifyOneA3bG1ReleaseManifest(tampered).mismatches).toContain(
      "release identity fingerprint does not match its immutable inputs",
    );
  });

  it("detects drift after a frozen schema hash changes", () => {
    const manifest = build();
    const drifted = {
      ...manifest,
      schema: {
        ...manifest.schema,
        migrations: [
          { ...manifest.schema.migrations[0]!, sha256: "e".repeat(64) },
          ...manifest.schema.migrations.slice(1),
        ],
      },
    };

    expect(verifyOneA3bG1ReleaseManifest(drifted).mismatches).toContain(
      "schema fingerprint does not match its migration hashes",
    );
  });

  it("returns mismatches for malformed untrusted JSON", () => {
    expect(verifyOneA3bG1ReleaseManifest({ roles: {} }).passed).toBe(false);
  });

  it("does not silently accept malformed migration or evidence entries", () => {
    const manifest = build();
    const malformed = {
      ...manifest,
      schema: {
        ...manifest.schema,
        migrations: [...manifest.schema.migrations, null],
      },
      evidence: manifest.evidence.map((entry) =>
        entry.criterion === "AC-F01"
          ? { ...entry, source: "untrusted" }
          : entry,
      ),
    };

    const verification = verifyOneA3bG1ReleaseManifest(malformed);
    expect(verification.passed).toBe(false);
    expect(verification.mismatches).toContain(
      "schema migrations contain a non-object entry",
    );
    expect(verification.mismatches).toContain(
      "AC-F01 has an invalid evidence source",
    );
  });
});
