import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildManifest } from "../eval/continuation-acceptance-1a3b/manifest";
import { evidenceArtifactValue } from "../scripts/produce-1a3b-g1-evidence";
import {
  verifyHostedCanaryArtifact,
  verifyValidatorPrecisionReport,
  verifyValidatorPrecisionReportArtifact,
} from "../scripts/verify-1a3b-g1-evidence";
import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS,
  type OneA3bG1Evidence,
} from "@sayhear/application";
import {
  ONE_A_3B_G1_EVIDENCE_CONTRACTS,
  verifyOneA3bF3ReleaseArtifacts,
  verifyF3Catalog,
  verifyOneA3bG1EvidenceArtifact,
  verifyOneA3bG1RoleConfigurationsAgainstF3,
} from "@sayhear/application";

function readFixture(path: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    any
  >;
}

function completeHostedArtifacts(runId: string): Record<string, unknown> {
  const commandId = "01984477-59a9-7d20-9d97-e588769566a1";
  const ownerId = "01984477-59a9-7d20-9d97-e588769566a0";
  return {
    completeness: {
      runs: {
        [runId]: { events: 1, eventsComplete: true, steps: 1, stepsComplete: true },
      },
      version: "1a3b-hosted-canary-completeness:v1",
      workflowRuns: 1,
    },
    workflowHistory: [
      {
        deploymentId: "dpl_acceptance",
        input: { workflowCommandId: commandId },
        runId,
        steps: [{ runId }],
        events: [{ runId }],
      },
    ],
    outboxPayloads: [
      { payload: { workflowCommandId: commandId }, user_id: ownerId },
    ],
    receipts: [{ action_receipt_id: commandId, user_id: ownerId }],
    logs: [{ runId }],
    traces: [{ commandId }],
    errors: [{ code: "provider_timeout", commandId }],
  };
}

describe("1A.3b G1 evidence lineage", () => {
  it("rejects precision captures from dirty or different code and missing execution identities", () => {
    const expectedCapture = { gitCommit: "a".repeat(40), catalogSha256: "catalog", pinsFingerprint: "pins" };
    const report = {
      ...expectedCapture, gitDirty: false,
      version: "1a3b-f3-validator-precision-report:v1", manifestFingerprint: "manifest",
      cases: ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.map(fixtureId => ({
        fixtureId, outcome: "completed", verdict: "blocked", blockingFindingCodes: ["unsupported"],
        generationCommandId: `command-${fixtureId}`, modelRunAttemptId: `attempt-${fixtureId}`,
      })),
    };
    const input = { report, manifestFingerprint: "manifest", expectedCapture };
    expect(verifyValidatorPrecisionReport(input)).toEqual({ totalCases: 6, falseBlockingCases: 6 });
    expect(() => verifyValidatorPrecisionReport({ ...input, report: { ...report, gitDirty: true } })).toThrow("frozen code");
    expect(() => verifyValidatorPrecisionReport({ ...input, report: { ...report, gitCommit: "b".repeat(40) } })).toThrow("frozen code");
    expect(() => verifyValidatorPrecisionReport({ ...input, report: { ...report, cases: report.cases.map(entry => ({ ...entry, modelRunAttemptId: null })) } })).toThrow("command/attempt");
  });
  it("binds holdout precision IDs to the supplied frozen catalog without renaming results", () => {
    const manifestFingerprint = `sha256:${"c".repeat(64)}`;
    const expectedFixtureIds = ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.map((id) => `holdout-${id}`);
    const report = { version: "1a3b-f3-validator-precision-report:v1", manifestFingerprint, cases: expectedFixtureIds.map((fixtureId) => ({fixtureId, outcome: "completed", verdict: "accepted", blockingFindingCodes: []})) };
    const bytes = Buffer.from(JSON.stringify(report));
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(verifyValidatorPrecisionReportArtifact({bytes, expectedSha256, manifestFingerprint, expectedFixtureIds})).toEqual({falseBlockingCases: 0, totalCases: 6});
    expect(() => verifyValidatorPrecisionReportArtifact({bytes, expectedSha256, manifestFingerprint})).toThrow("unknown or duplicate");
    expect(() => verifyValidatorPrecisionReportArtifact({bytes, expectedSha256, manifestFingerprint: `sha256:${"d".repeat(64)}`, expectedFixtureIds})).toThrow("does not belong");
    expect(() => verifyValidatorPrecisionReportArtifact({bytes, expectedSha256, manifestFingerprint, expectedFixtureIds: Array(6).fill(expectedFixtureIds[0])})).toThrow("six unique");
  });

  it("requires every frozen precision case exactly once and records semantic findings without blocking", () => {
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
    expect(
      verifyValidatorPrecisionReportArtifact({
        bytes: falseBlockBytes,
        expectedSha256: createHash("sha256")
          .update(falseBlockBytes)
          .digest("hex"),
        manifestFingerprint,
      }),
    ).toEqual({ falseBlockingCases: 1, totalCases: 6 });
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
      required: ["AC-X01", "AC-X02", "AC-X03", "AC-X04", "AC-M01"],
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

  it("verifies a G1-only F3 manifest that does not ship Bio", () => {
    const holdout = readFixture("../eval/continuation-acceptance-1a3b/holdout/fixtures.json");
    const pins = readFixture("../eval/continuation-acceptance-1a3b/pins.json");
    const baseline = readFixture(
      "../eval/continuation-acceptance-1a3b/baseline-reference.json",
    );
    const f3Manifest = buildManifest({
      baseline: baseline as any,
      catalog: holdout as any,
      commands: ["CI=true pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts"],
      fixtureSeed: 196,
      gitCommit: "b".repeat(40),
      pins: pins as any,
      // The G1-only release ships four roles, none of them bio.write.
      required: ["AC-X01", "AC-X03", "AC-X04", "AC-M01"],
      sampleSeed: 1960,
    });
    const ledger = {
      version: "1a3b-f3-adjudication:v1",
      group: "validator",
      adjudicator: "Luke",
      decidedAt: "2026-09-10T20:00:00.000Z",
      manifestFingerprint: f3Manifest.fingerprint,
      entries: holdout.scenarios
        .filter((scenario: any) => scenario.group === "validator")
        .map((scenario: any) => ({ fixtureId: scenario.id, verdict: "accepted" })),
    };

    // No Bio gate, and therefore no Bio sample demanded of it.
    expect(verifyOneA3bF3ReleaseArtifacts({
      manifest: f3Manifest,
      catalog: holdout,
      ledger,
    })).toEqual([]);

    // A manifest that requires AC-X04 cannot be accepted without it, so the
    // deterministic gates cannot be quietly skipped by editing the criteria.
    const withoutHardGates = { ...f3Manifest, acceptance: { ...f3Manifest.acceptance, required: ["AC-X01", "AC-X03", "AC-M01"] } };
    expect(
      verifyOneA3bF3ReleaseArtifacts({
        manifest: withoutHardGates,
        catalog: holdout,
        ledger: { ...ledger, manifestFingerprint: "sha256:placeholder" },
      }).join(" "),
    ).toMatch(/AC-X04/);

    // A manifest carrying a Bio sample it never required would let a Bio
    // comparison be built from a release that never gated on it.
    const withUnsolicitedBio = {
      ...f3Manifest,
      bio: { sampleIds: [], sampleQuotas: { code_switch: 5, en: 5, zh: 5 }, total: 15 },
    };
    expect(
      verifyOneA3bF3ReleaseArtifacts({
        manifest: withUnsolicitedBio,
        catalog: holdout,
        ledger: { ...ledger, manifestFingerprint: "sha256:placeholder" },
      }).join(" "),
    ).toMatch(/AC-X02/);
  });

  it("accepts the #252 holdout catalog as a distinct frozen F3 catalog version", () => {
    const holdout = readFixture("../eval/continuation-acceptance-1a3b/holdout/fixtures.json");
    const spent = readFixture("../eval/continuation-acceptance-1a3b/fixtures.json");

    // The holdout is a separately authored catalog, so it carries its own
    // version string. Without accepting it here, the sealed acceptance run
    // could be captured but never certified into the release.
    const holdoutMismatches: string[] = [];
    verifyF3Catalog(holdout, holdoutMismatches);
    expect(holdoutMismatches).not.toContain("unsupported F3 catalog version");

    // The incumbent must keep verifying; accepting a second version must not
    // relax the first.
    const spentMismatches: string[] = [];
    verifyF3Catalog(spent, spentMismatches);
    expect(spentMismatches).not.toContain("unsupported F3 catalog version");

    // An unrecognised version is still refused, so the allowlist is not a
    // blanket pass. Which catalog a manifest actually used is settled by the
    // catalog sha256 the manifest freezes, not by the version string.
    const unknownMismatches: string[] = [];
    verifyF3Catalog({ ...holdout, version: "1a3b-f3-fixtures:v9" }, unknownMismatches);
    expect(unknownMismatches).toContain("unsupported F3 catalog version");
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

  it("retains AC-W01 hosted canary references through assembly so the final verifier can rescan", () => {
    const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS["AC-W01"];
    expect(contract.requiredResultKeys).toEqual(
      expect.arrayContaining(["expectedRunIds", "canaryValuesArtifact"]),
    );

    const root = mkdtempSync(join(tmpdir(), "sayhear-ac-w01-assembly-"));
    const write = (name: string, value: unknown) => {
      const bytes = JSON.stringify(value);
      writeFileSync(join(root, name), bytes, { mode: 0o600 });
      return {
        path: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const runId = "wrun_acceptance";
    const values = {
      actionPayload: "private-action-payload",
      contentHmac: "private-content-hmac",
      privateBody: "private-body",
      rawProviderError: "private-provider-error",
      renderedPrompt: "private-rendered-prompt",
      secret: "private-secret",
    };
    const exportArtifact = write("artifacts.json", completeHostedArtifacts(runId));
    const canaryValuesArtifact = write("values.json", values);

    const evidence: OneA3bG1Evidence = {
      criterion: "AC-W01",
      fixtureIds: ["cont-open-loop-en"],
      command: "node --import tsx scripts/verify-hosted-workflow-canary.ts",
      artifactSha256: "a".repeat(64),
      artifactPath: "eval/run/ac-w01.json",
      owner: "Luke",
      source: "hosted",
      status: "verified",
    };
    const source = {
      artifactPath: "eval/run/ac-w01-source.json",
      artifactSha256: "b".repeat(64),
      command: evidence.command,
      criterion: "AC-W01" as const,
      fixtureIds: evidence.fixtureIds,
      owner: "Luke",
      result: {
        hosted: true,
        canaryRunId: runId,
        deploymentId: "dpl_acceptance",
        exportArtifact,
        canaryValuesArtifact,
        expectedRunIds: [runId],
      },
      runId,
      source: "hosted" as const,
      verificationCommand: evidence.command,
    };
    const assembled = evidenceArtifactValue({
      evidence,
      f3ManifestFingerprint: `sha256:${"c".repeat(64)}`,
      fixtureCatalogSha256: "d".repeat(64),
      source,
      gitCommit: "e".repeat(40),
      releaseIdentityFingerprint: null,
    });
    const assembledResult = assembled.result as Record<string, unknown>;

    // The producer copies the contract keys, so the assembled artifact must
    // still carry both references rather than only a passed summary.
    expect(assembledResult.expectedRunIds).toEqual([runId]);
    expect(assembledResult.canaryValuesArtifact).toEqual(canaryValuesArtifact);
    expect(() => verifyHostedCanaryArtifact(assembled, root)).not.toThrow();

    // Dropping the references is exactly the failure this regression covers:
    // the final verifier has nothing to re-scan and must refuse the artifact.
    expect(() =>
      verifyHostedCanaryArtifact(
        {
          result: {
            ...assembledResult,
            expectedRunIds: undefined,
          },
        },
        root,
      ),
    ).toThrow("Hosted canary lacks deployment and complete run-set pins");
    expect(() =>
      verifyHostedCanaryArtifact(
        {
          result: {
            ...assembledResult,
            canaryValuesArtifact: undefined,
          },
        },
        root,
      ),
    ).toThrow("Hosted values reference is missing");
  });

  it("does not execute the producer CLI when imported as a module", () => {
    // Importing the producer must stay inert. Without the CLI-entry guard, the
    // bare import ran main() with no arguments, failed option parsing, and
    // exited 1 through process.exitCode.
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./scripts/produce-1a3b-g1-evidence.ts')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
