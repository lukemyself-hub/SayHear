import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildManifest } from "../eval/continuation-acceptance-1a3b/manifest";
import {
  ONE_A_3B_G1_ENABLED_ROLES,
  type OneA3bG1Evidence,
} from "@sayhear/application";
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
