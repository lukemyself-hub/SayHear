import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildManifest } from "../eval/continuation-acceptance-1a3b/manifest";
import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS,
  type OneA3bG1Evidence,
} from "@sayhear/application";
import { verifyValidatorPrecisionReportArtifact } from "../scripts/verify-1a3b-g1-evidence";
import {
  ONE_A_3B_G1_EVIDENCE_CONTRACTS,
  verifyOneA3bF3ReleaseArtifacts,
  verifyOneA3bG1EvidenceArtifact,
  verifyOneA3bG1RoleConfigurationsAgainstF3,
} from "@sayhear/application";

function readFixture(path: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    any
  >;
}

describe("1A.3b G1 evidence lineage", () => {
  it("requires every frozen precision case exactly once with zero false blocks", () => {
    const manifestFingerprint = `sha256:${"c".repeat(64)}`;
    const report = {
      version: "1a3b-f3-validator-precision-report:v1",
      manifestFingerprint,
      cases: ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.map((fixtureId) => ({
        fixtureId,
        outcome: "completed",
        verdict: "accepted",
        blockingFindingCodes: [],
      })),
    };
    const bytes = Buffer.from(JSON.stringify(report));
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    expect(
      verifyValidatorPrecisionReportArtifact({
        bytes,
        expectedSha256,
        manifestFingerprint,
      }),
    ).toEqual({ falseBlockingCases: 0, totalCases: 6 });
    expect(() =>
      verifyValidatorPrecisionReportArtifact({
        bytes,
        expectedSha256: "0".repeat(64),
        manifestFingerprint,
      }),
    ).toThrow("bytes do not match");

    const incompleteBytes = Buffer.from(
      JSON.stringify({ ...report, cases: report.cases.slice(1) }),
    );
    expect(() =>
      verifyValidatorPrecisionReportArtifact({
        bytes: incompleteBytes,
        expectedSha256: createHash("sha256")
          .update(incompleteBytes)
          .digest("hex"),
        manifestFingerprint,
      }),
    ).toThrow("every frozen fixture exactly once");

    const falseBlockBytes = Buffer.from(
      JSON.stringify({
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0
            ? { ...entry, verdict: "accepted", blockingFindingCodes: ["unsupported"] }
            : entry,
        ),
      }),
    );
    expect(() =>
      verifyValidatorPrecisionReportArtifact({
        bytes: falseBlockBytes,
        expectedSha256: createHash("sha256")
          .update(falseBlockBytes)
          .digest("hex"),
        manifestFingerprint,
      }),
    ).toThrow("1 false-blocking verdict");
  });

  it("verifies the checked-in F3 synthetic catalog, pins, and validator ledger shape", () => {
    const catalog = readFixture("../eval/continuation-acceptance-1a3b/fixtures.json");
    const pins = readFixture("../eval/continuation-acceptance-1a3b/pins.json");
    const baseline = readFixture(
      "../eval/continuation-acceptance-1a3b/baseline-reference.json",
    );
    const f3Manifest = buildManifest({
      baseline: baseline as any,
      catalog: catalog as any,
      commands: [
        "CI=true pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts",
      ],
      fixtureSeed: 196,
      gitCommit: "b".repeat(40),
      pins: pins as any,
      sampleSeed: 1960,
    });
    const ledger = {
      version: "1a3b-f3-adjudication:v1",
      group: "validator",
      adjudicator: "Luke",
      decidedAt: "2026-09-10T20:00:00.000Z",
      manifestFingerprint: f3Manifest.fingerprint,
      entries: catalog.scenarios
        .filter((scenario: any) => scenario.group === "validator")
        .map((scenario: any) => ({ fixtureId: scenario.id, verdict: "accepted" })),
    };
    const mismatches = verifyOneA3bF3ReleaseArtifacts({
      manifest: f3Manifest,
      catalog,
      ledger,
    });

    expect(mismatches).toEqual([]);
  });

  it("binds AC-D01 deployment evidence to the release identity, not the full manifest", () => {
    const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS["AC-D01"];
    expect(contract.requiredResultKeys).toContain("releaseIdentityFingerprint");
    expect(contract.requiredResultKeys).not.toContain("manifestFingerprint");

    const base = {
      version: "1a3b-g1-evidence:v1",
      criterion: "AC-D01",
      gitCommit: "b".repeat(40),
      f3ManifestFingerprint: "sha256:" + "c".repeat(64),
      fixtureCatalogSha256: "d".repeat(64),
      fixtureIds: ["cont-open-loop-en"],
      command: "pnpm exec vercel api /v13/deployments/dpl_1",
      runId: "dpl_1",
      status: "passed",
    };
    const evidence: OneA3bG1Evidence = {
      criterion: "AC-D01",
      fixtureIds: ["cont-open-loop-en"],
      command: "pnpm exec vercel api /v13/deployments/dpl_1",
      artifactSha256: "a".repeat(64),
      artifactPath: "eval/run/ac-d01.json",
      owner: "Luke",
      source: "hosted",
      status: "verified",
    };
    const validResult = {
      passed: true,
      criterion: "AC-D01",
      evidenceKind: contract.evidenceKind,
      assertionIds: contract.requiredAssertionIds,
      fixtureIds: ["cont-open-loop-en"],
      gitCommit: "b".repeat(40),
      f3ManifestFingerprint: "sha256:" + "c".repeat(64),
      fixtureCatalogSha256: "d".repeat(64),
      runId: "dpl_1",
      command: "pnpm exec vercel api /v13/deployments/dpl_1",
      deploymentId: "dpl_1",
      deploymentCommit: "b".repeat(40),
      schemaFingerprint: "e".repeat(64),
      releaseIdentityFingerprint: `sha256:${"f".repeat(64)}`,
    };
    expect(
      verifyOneA3bG1EvidenceArtifact({
        value: { ...base, result: validResult },
        evidence,
        gitCommit: "b".repeat(40),
        f3ManifestFingerprint: "sha256:" + "c".repeat(64),
        fixtureCatalogSha256: "d".repeat(64),
        knownFixtureIds: new Set(["cont-open-loop-en"]),
      }),
    ).toEqual([]);

    const legacyResult = { ...validResult };
    delete (legacyResult as Record<string, unknown>).releaseIdentityFingerprint;
    (legacyResult as Record<string, unknown>).manifestFingerprint =
      `sha256:${"f".repeat(64)}`;
    expect(
      verifyOneA3bG1EvidenceArtifact({
        value: { ...base, result: legacyResult },
        evidence,
        gitCommit: "b".repeat(40),
        f3ManifestFingerprint: "sha256:" + "c".repeat(64),
        fixtureCatalogSha256: "d".repeat(64),
        knownFixtureIds: new Set(["cont-open-loop-en"]),
      }),
    ).toContain(
      "AC-D01 artifact result releaseIdentityFingerprint has an invalid type or format",
    );
  });

  it("binds AC-L02 evidence to the purge-before-backup restore drill, not repackaged purge assertions", () => {
    const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS["AC-L02"];
    expect(contract.requiredResultKeys).toEqual([
      "purgeSurfaceRegistryVersion",
      "seededCanaryEvidence",
      "snapshotPredatesPurge",
      "restoreDrill",
      "inflightOrders",
      "recoveryGateEvidence",
    ]);

    const base = {
      version: "1a3b-g1-evidence:v1",
      criterion: "AC-L02",
      gitCommit: "b".repeat(40),
      f3ManifestFingerprint: "sha256:" + "c".repeat(64),
      fixtureCatalogSha256: "d".repeat(64),
      fixtureIds: ["cont-open-loop-en"],
      command:
        "CI=true pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts",
      runId: "drill-run-1",
      status: "passed",
    };
    const evidence: OneA3bG1Evidence = {
      criterion: "AC-L02",
      fixtureIds: ["cont-open-loop-en"],
      command:
        "CI=true pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts",
      artifactSha256: "a".repeat(64),
      artifactPath: "eval/run/ac-l02.json",
      owner: "Luke",
      source: "ci",
      status: "verified",
    };
    const validResult = {
      passed: true,
      criterion: "AC-L02",
      evidenceKind: contract.evidenceKind,
      assertionIds: contract.requiredAssertionIds,
      fixtureIds: ["cont-open-loop-en"],
      gitCommit: "b".repeat(40),
      f3ManifestFingerprint: "sha256:" + "c".repeat(64),
      fixtureCatalogSha256: "d".repeat(64),
      runId: "drill-run-1",
      command:
        "CI=true pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts",
      purgeSurfaceRegistryVersion: "purge-surface-registry:v1",
      seededCanaryEvidence: { canaryIds: ["canary-1"], snapshotAt: "2026-09-13T10:00:00.000Z" },
      snapshotPredatesPurge: true,
      restoreDrill: { markerReapplied: true, resurrectedRows: 0 },
      inflightOrders: [{ order: "purge-first" }, { order: "write-first" }],
      recoveryGateEvidence: { markerEpoch: 2 },
    };
    expect(
      verifyOneA3bG1EvidenceArtifact({
        value: { ...base, result: validResult },
        evidence,
        gitCommit: "b".repeat(40),
        f3ManifestFingerprint: "sha256:" + "c".repeat(64),
        fixtureCatalogSha256: "d".repeat(64),
        knownFixtureIds: new Set(["cont-open-loop-en"]),
      }),
    ).toEqual([]);

    const legacyResult = {
      ...validResult,
      beforePurgeEvidence: { passed: true },
      afterPurgeEvidence: { passed: true },
    };
    delete (legacyResult as Record<string, unknown>).seededCanaryEvidence;
    delete (legacyResult as Record<string, unknown>).restoreDrill;
    delete (legacyResult as Record<string, unknown>).inflightOrders;
    expect(
      verifyOneA3bG1EvidenceArtifact({
        value: { ...base, result: legacyResult },
        evidence,
        gitCommit: "b".repeat(40),
        f3ManifestFingerprint: "sha256:" + "c".repeat(64),
        fixtureCatalogSha256: "d".repeat(64),
        knownFixtureIds: new Set(["cont-open-loop-en"]),
      }),
    ).toContain(
      "AC-L02 artifact result seededCanaryEvidence has an invalid type or format",
    );
  });

  it("binds active G1 role transport settings and evidence results to F3", () => {
    const pins = readFixture("../eval/continuation-acceptance-1a3b/pins.json");
    const roleConfigurations = ONE_A_3B_G1_ENABLED_ROLES.map((role) => {
      const pin = pins.roles[role];
      return {
        role,
        configVersion: `g1-${role}:v1`,
        provider: pin.provider,
        model: pin.model,
        modelSnapshot: pin.snapshot,
        promptVersion: pin.promptVersion,
        schemaVersion: pin.schemaVersion,
        rolePolicyVersion: "1a3b-model-role-policy:v1",
        providerPolicyVersion: `egress-${role}:v1`,
        rolloutPin: `rollout-${role}:v1`,
        freshnessPolicy:
          role === "episode.build"
            ? ("source_valid:v1" as const)
            : ("exact_head:v1" as const),
        fallbackMode: "disabled" as const,
        maxTechnicalRetries: pin.maxTechnicalRetries,
        maxSemanticRepairs: 0 as const,
        parameterSnapshot: pin.parameters,
      };
    });

    expect(
      verifyOneA3bG1RoleConfigurationsAgainstF3(
        roleConfigurations,
        { pinnedConfiguration: pins },
      ),
    ).toEqual([]);

    const evidence: OneA3bG1Evidence = {
      criterion: "AC-F01",
      fixtureIds: ["cont-open-loop-en"],
      command: "CI=true pnpm verify:g1 AC-F01",
      artifactSha256: "a".repeat(64),
      artifactPath: "eval/run/ac-f01.json",
      owner: "Luke",
      source: "ci",
      status: "verified",
    };
    const evidenceContract = ONE_A_3B_G1_EVIDENCE_CONTRACTS[evidence.criterion];
    expect(
      verifyOneA3bG1EvidenceArtifact({
        value: {
          version: "1a3b-g1-evidence:v1",
          criterion: evidence.criterion,
          gitCommit: "b".repeat(40),
          f3ManifestFingerprint: "sha256:" + "c".repeat(64),
          fixtureCatalogSha256: "d".repeat(64),
          fixtureIds: evidence.fixtureIds,
          command: evidence.command,
          runId: "run-ac-f01-1",
          status: "passed",
          result: {
            passed: true,
            criterion: evidence.criterion,
            evidenceKind: evidenceContract.evidenceKind,
            assertionIds: evidenceContract.requiredAssertionIds,
            fixtureIds: evidence.fixtureIds,
            gitCommit: "b".repeat(40),
            f3ManifestFingerprint: "sha256:" + "c".repeat(64),
            fixtureCatalogSha256: "d".repeat(64),
            runId: "run-ac-f01-1",
            command: evidence.command,
            workflowReceiptIds: ["wf-1"],
            outboxEventIds: ["outbox-1"],
            attemptIds: ["attempt-1"],
          },
        },
        evidence,
        gitCommit: "b".repeat(40),
        f3ManifestFingerprint: "sha256:" + "c".repeat(64),
        fixtureCatalogSha256: "d".repeat(64),
        knownFixtureIds: new Set(["cont-open-loop-en"]),
      }),
    ).toEqual([]);
  });
});
