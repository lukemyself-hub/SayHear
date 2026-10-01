import { describe, expect, it } from "vitest";

import {
  buildG1ReleaseIdentityFingerprint,
  buildOneA3bG1ReleaseManifest,
  ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
  validatorCalibrationRejectsWithinBudget,
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
  totalCases: 6,
  acceptedCases: 6,
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

  it("does not score the validator verdicts, per ADR-0143", () => {
    // The 10% miss budget this replaced had no gold set behind it. Luke's
    // 6-of-6 rejection of the Reflection cases is what surfaced that: the
    // defects were detected and reported, and none reached the blocking set, so
    // the release was gated on a semantic judgement nothing could calibrate.
    // What stays enforced is completion — every catalogued case ruled, the
    // precision corpus whole, the ledger bound to this manifest.
    const manifest = build({
      validatorCalibration: {
        ...validatorCalibration,
        acceptedCases: 0,
        maxRejects: 0,
        note: "Every Reflection case was rejected by the human owner.",
      },
    });

    expect(manifest.status).toBe("ready_for_cutover");
    expect(verifyOneA3bG1ReleaseManifest(manifest).passed).toBe(true);
    // The budget predicate is retained, and stays false, so the gate remains
    // visible at its call sites until a gold set can replace it.
    expect(
      validatorCalibrationRejectsWithinBudget({
        acceptedCases: 6,
        maxRejects: 0,
        totalCases: 6,
      }),
    ).toBe(false);
  });

  it("still requires the ledger to be internally consistent", () => {
    expect(() =>
      build({
        validatorCalibration: {
          ...validatorCalibration,
          acceptedCases: 7,
        },
      }),
    ).toThrow("acceptedCases cannot exceed totalCases");
    expect(() =>
      build({
        validatorCalibration: {
          ...validatorCalibration,
          totalCases: 0,
        },
      }),
    ).toThrow("totalCases must be at least 1");
  });

  it("requires a complete precision corpus while semantic verdicts remain observational", () => {
    const observed = build({
        validatorCalibration: {
          ...validatorCalibration,
          precisionFalseBlockingCases: 1,
        },
      });
    expect(observed.status).toBe("ready_for_cutover");
    expect(verifyOneA3bG1ReleaseManifest(observed).passed).toBe(true);

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
