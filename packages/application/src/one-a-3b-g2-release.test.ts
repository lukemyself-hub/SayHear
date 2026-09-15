import { describe, expect, it } from "vitest";

import {
  buildG2ReleaseIdentityFingerprint,
  buildOneA3bG2ReleaseManifest,
  ONE_A_3B_G2_BUNDLE_ROLES,
  ONE_A_3B_G2_DEFERRED_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
  ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA,
  verifyOneA3bG2ReleaseManifest,
  type OneA3bG2Evidence,
} from "./one-a-3b-g2-release";
import {
  ONE_A_3B_ROLE_POLICIES,
  type ModelRoleConfigurationSnapshot,
} from "./model-role-runtime";

const gitCommit = "a".repeat(40);
const baseG1ReleaseFingerprint = `sha256:${"f".repeat(64)}`;
const migrations = [
  { name: "0049_open_loop_domain.sql", sha256: "b".repeat(64) },
  { name: "0050_proactive_followup.sql", sha256: "c".repeat(64) },
] as const;
const purgeMarkerMigrations = [
  { name: "0001_purge_marker.sql", sha256: "d".repeat(64) },
  { name: "0002_latest_marker_high_water.sql", sha256: "e".repeat(64) },
] as const;

const roleConfigurations: readonly ModelRoleConfigurationSnapshot[] =
  ONE_A_3B_G2_ENABLED_ROLES.map((role, index) => ({
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
    freshnessPolicy: ONE_A_3B_ROLE_POLICIES[role].freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: ONE_A_3B_ROLE_POLICIES[role].maxTechnicalRetries,
    maxSemanticRepairs: ONE_A_3B_ROLE_POLICIES[role].maxSemanticRepairs,
    parameterSnapshot: { fixture: "synthetic" },
  }));

function evidence(
  overrides: Partial<OneA3bG2Evidence> = {},
): readonly OneA3bG2Evidence[] {
  return ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA.map((criterion, index) => ({
    criterion,
    fixtureIds: [`synthetic-${criterion.toLowerCase()}`],
    command: `pnpm verify:g2 ${criterion}`,
    artifactSha256: (index + 1).toString(16).repeat(64),
    artifactPath: `eval/continuation-acceptance-1a3b/run/${criterion.toLowerCase()}.json`,
    owner: "Luke",
    source:
      criterion === "AC-X01"
        ? "human"
        : criterion === "AC-M01"
          ? "provider"
          : criterion === "AC-W01"
            ? "hosted"
            : criterion === "AC-X04"
              ? "local"
              : "ci",
    status: "verified",
    ...(overrides.criterion === criterion ? overrides : {}),
  }));
}

const continuationCalibration = {
  ledgerPath: "eval/continuation-acceptance-1a3b/run/continuation-ledger.json",
  ledgerSha256: "e".repeat(64),
  ledgerVersion: "1a3b-g2-continuation-ledger:v1" as const,
  f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
  totalCases: 15 as const,
  englishCases: 8 as const,
  chineseCases: 5 as const,
  codeSwitchCases: 2 as const,
  netPreference: 3,
  localeRegressions: 0,
  protectedCategoryRegressions: 0,
  humanOwner: "Luke" as const,
  status: "verified" as const,
};

function build(
  overrides: Partial<
    Parameters<typeof buildOneA3bG2ReleaseManifest>[0]
  > = {},
) {
  return buildOneA3bG2ReleaseManifest({
    gitCommit,
    baseG1ReleaseFingerprint,
    migrations,
    purgeMarkerMigrations,
    roleConfigurations,
    fixture: {
      f3ManifestPath: "eval/continuation-acceptance-1a3b/run/manifest.json",
      f3ManifestSha256: "d".repeat(64),
      f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
      fixtureSeed: 207,
      sampleSeed: 2070,
    },
    continuationCalibration,
    commands: ["CI=true pnpm validate"],
    evidence: evidence(),
    cutoverState: "disabled",
    createdAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  });
}

describe("1A.3b G2 release manifest", () => {
  it("stays blocked when human evidence is not verified", () => {
    const manifest = build({
      roleConfigurations: [],
      evidence: evidence({
        criterion: "AC-X01",
        status: "pending",
        artifactSha256: null,
        artifactPath: null,
        owner: "Luke",
        note: "Continuation blind review has not run.",
      }),
    });

    expect(manifest.status).toBe("blocked");
    expect(verifyOneA3bG2ReleaseManifest(manifest)).toEqual({
      mismatches: [],
      passed: true,
    });
  });

  it("freezes the six G2 roles as one bundle and defers only Bio", () => {
    const manifest = build();

    expect(manifest.status).toBe("ready_for_cutover");
    expect(manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.stage).toBe("g2");
    expect(manifest.roles.enabledRoles).toEqual(ONE_A_3B_G2_ENABLED_ROLES);
    expect(manifest.roles.bundleRoles).toEqual(ONE_A_3B_G2_BUNDLE_ROLES);
    expect(manifest.roles.deferredRoles).toEqual(ONE_A_3B_G2_DEFERRED_ROLES);
    expect(ONE_A_3B_G2_ENABLED_ROLES).toHaveLength(6);
    expect(ONE_A_3B_G2_BUNDLE_ROLES).toEqual([
      "open_loop.extract",
      "proactive.followup",
    ]);
    expect(ONE_A_3B_G2_DEFERRED_ROLES).toEqual(["bio.write"]);
    expect(manifest.baseG1ReleaseFingerprint).toBe(baseG1ReleaseFingerprint);
  });

  it("rejects a Bio configuration in the G2 stage", () => {
    expect(() =>
      build({
        roleConfigurations: [
          ...roleConfigurations,
          {
            ...roleConfigurations[0]!,
            role: "bio.write",
            configVersion: "synthetic-bio.write:v1",
          },
        ],
      }),
    ).toThrow("deferred model role bio.write");
  });

  it("rejects a split bundle with only one of the two G2 roles", () => {
    expect(() =>
      build({
        roleConfigurations: roleConfigurations.filter(
          (configuration) => configuration.role !== "proactive.followup",
        ),
      }),
    ).toThrow("single bundle");
  });

  it("requires the switched G1 release fingerprint", () => {
    expect(() =>
      build({ baseG1ReleaseFingerprint: "not-a-fingerprint" }),
    ).toThrow("baseG1ReleaseFingerprint");
  });

  it("requires a strictly positive Continuation preference with no regressions", () => {
    expect(() =>
      build({
        continuationCalibration: {
          ...continuationCalibration,
          netPreference: 0,
        },
      }),
    ).toThrow("strictly positive");
    expect(() =>
      build({
        continuationCalibration: {
          ...continuationCalibration,
          localeRegressions: 1,
        },
      }),
    ).toThrow("locale");
    expect(() =>
      build({
        continuationCalibration: {
          ...continuationCalibration,
          protectedCategoryRegressions: 1,
        },
      }),
    ).toThrow("protected");
  });

  it("requires the 8/5/2 Continuation quotas", () => {
    expect(() =>
      build({
        continuationCalibration: {
          ...continuationCalibration,
          englishCases: 7 as never,
        },
      }),
    ).toThrow("englishCases");
  });

  it("keeps incomplete Continuation calibration pending with a note", () => {
    const manifest = build({
      continuationCalibration: {
        ...continuationCalibration,
        status: "pending",
        netPreference: 0,
        note: "Luke has not adjudicated the 15 Continuation pairs.",
      },
    });

    expect(manifest.status).toBe("blocked");
  });

  it("requires pending Continuation calibration to name its blocker", () => {
    expect(() =>
      build({
        continuationCalibration: {
          ...continuationCalibration,
          status: "pending",
          netPreference: 0,
        },
      }),
    ).toThrow("continuationCalibration.note");
  });

  it("binds human, provider, hosted, and local sources to their criteria", () => {
    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-X01",
          source: "ci",
        }),
      }),
    ).toThrow("AC-X01 evidence must come from the human evidence source");
    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-M01",
          source: "local",
        }),
      }),
    ).toThrow("AC-M01 evidence must come from the provider evidence source");
    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-W01",
          source: "ci",
        }),
      }),
    ).toThrow("AC-W01 evidence must come from the hosted evidence source");
    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-X04",
          source: "human",
        }),
      }),
    ).toThrow("AC-X04 evidence must come from local or ci automated evidence");
  });

  it("attributes verified Continuation adjudication to Luke", () => {
    expect(() =>
      build({
        evidence: evidence({
          criterion: "AC-X01",
          owner: "someone-else",
        }),
      }),
    ).toThrow("AC-X01 verifies Luke adjudication and must be owned by Luke");
  });

  it("flags a manifest whose verified AC-X01 is not owned by Luke", () => {
    const manifest = build();
    const tampered = {
      ...manifest,
      evidence: manifest.evidence.map((entry) =>
        entry.criterion === "AC-X01" ? { ...entry, owner: "someone-else" } : entry,
      ),
    };

    expect(
      verifyOneA3bG2ReleaseManifest(tampered).mismatches.join("; "),
    ).toContain("AC-X01 verifies Luke adjudication and must be owned by Luke");
  });

  it("refuses active cutover until every gate is verified", () => {
    expect(() =>
      build({
        cutoverState: "active",
        evidence: evidence({
          criterion: "AC-W01",
          status: "pending",
          artifactSha256: null,
          artifactPath: null,
          owner: "unassigned",
          note: "Hosted synthetic canary has not run.",
        }),
      }),
    ).toThrow("cannot become active");
  });

  it("becomes active once every gate is verified", () => {
    const manifest = build({ cutoverState: "active" });

    expect(manifest.status).toBe("active");
    expect(verifyOneA3bG2ReleaseManifest(manifest).passed).toBe(true);
  });

  it("records rollback only with the complete frozen evidence set", () => {
    const manifest = build({ cutoverState: "rolled_back" });

    expect(manifest.status).toBe("rolled_back");
    expect(() =>
      build({
        cutoverState: "rolled_back",
        evidence: evidence({
          criterion: "AC-D01",
          status: "blocked",
          artifactSha256: null,
          artifactPath: null,
          owner: "Luke",
          note: "Rollback drill has not run.",
        }),
      }),
    ).toThrow("rollback records require the complete frozen evidence set");
  });

  it("rejects a manifest with the wrong stage", () => {
    const manifest = build();

    expect(
      verifyOneA3bG2ReleaseManifest({ ...manifest, stage: "g1" }).passed,
    ).toBe(false);
  });

  it("keeps the release identity stable across evidence updates", () => {
    const first = buildG2ReleaseIdentityFingerprint({
      gitCommit,
      baseG1ReleaseFingerprint,
      migrations,
      purgeMarkerMigrations,
      roleConfigurations,
      fixture: {
        f3ManifestSha256: "d".repeat(64),
        f3ManifestFingerprint: `sha256:${"f".repeat(64)}`,
        fixtureSeed: 207,
        sampleSeed: 2070,
      },
    });
    const manifest = build({
      evidence: evidence({
        criterion: "AC-X01",
        status: "pending",
        artifactSha256: null,
        artifactPath: null,
        owner: "Luke",
        note: "Continuation blind review has not run.",
      }),
    });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.releaseIdentityFingerprint).toBe(first);
  });
});
