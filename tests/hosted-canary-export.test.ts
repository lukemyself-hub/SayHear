import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyHostedCanaryArtifact } from "../scripts/verify-1a3b-g1-evidence";
import { describe, expect, it } from "vitest";
import { assertCanaryExportCorrelation, collectWorkflowPages, fetchWorkflowRun, loadLockedWorkflowTools } from "../scripts/export-hosted-workflow-canary";
import {
  assertHostedWorkflowCanaryEvidence,
  assertPreparedWorkflowPages,
  assertWorkflowHistoryCanaryResolved,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "../scripts/hosted-workflow-canary-gate";

const commandId = "01984477-59a9-7d20-9d97-e588769566a1";
const ownerId = "01984477-59a9-7d20-9d97-e588769566a0";
const values: WorkflowCanaryValues = {
  actionPayload: "private-action-payload",
  contentHmac: "private-content-hmac",
  privateBody: "private-body",
  rawProviderError: "private-provider-error",
  renderedPrompt: "private-rendered-prompt",
  secret: "private-secret",
};
const runId = "wrun_test";
const rawProviderErrorWaiver = {
  approvedBy: "Luke",
  check: "raw_provider_error",
  decision: "ADR-0145",
  scope: "g1-restoration-2026-10-01",
  status: "skipped",
  version: "g1-raw-provider-error-waiver:v1",
} as const;
const waivedValues: WorkflowCanaryValues = {
  ...values,
  rawProviderError: null,
  rawProviderErrorWaiver,
};

type MutableArtifacts = {
  completeness: {
    runs: Record<string, { events: number; eventsComplete: boolean; steps: number; stepsComplete: boolean }>;
    version: string;
    workflowRuns: number;
  };
  workflowHistory: Record<string, unknown>[];
  outboxPayloads: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
  logs: unknown[];
  traces: unknown[];
  errors: unknown[];
};

function completeArtifacts(): MutableArtifacts {
  return {
    completeness: {
      runs: { [runId]: { events: 1, eventsComplete: true, steps: 1, stepsComplete: true } },
      version: "1a3b-hosted-canary-completeness:v1",
      workflowRuns: 1,
    },
    workflowHistory: [{
      deploymentId: "dpl_acceptance",
      input: { workflowCommandId: commandId },
      runId,
      steps: [{ runId }],
      events: [{ runId }],
    }],
    outboxPayloads: [{ payload: { workflowCommandId: commandId }, user_id: ownerId }],
    receipts: [{ action_receipt_id: commandId, user_id: ownerId }],
    logs: [{ runId }],
    traces: [{ commandId }],
    errors: [{ code: "provider_timeout", commandId }],
  };
}

const asArtifacts = (artifacts: MutableArtifacts): WorkflowCanaryArtifacts =>
  artifacts as unknown as WorkflowCanaryArtifacts;

describe("hosted canary platform export", () => {
  it("re-scans hashed raw exports at final verification instead of trusting a passed summary", () => {
    const root = mkdtempSync(join(tmpdir(), "sayhear-canary-verifier-test-"));
    const write = (path: string, value: unknown) => {
      const bytes = JSON.stringify(value);
      writeFileSync(join(root, path), bytes, { mode: 0o600 });
      return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const artifacts = completeArtifacts();
    const result = {
      deploymentId: "dpl_acceptance", expectedRunIds: [runId], passed: true,
      exportArtifact: write("artifacts.json", artifacts),
      canaryValuesArtifact: write("values.json", values),
    };
    expect(() => verifyHostedCanaryArtifact({ result }, root)).not.toThrow();
    artifacts.logs[0] = { commandId, message: values.privateBody };
    result.exportArtifact = write("artifacts.json", artifacts);
    expect(() => verifyHostedCanaryArtifact({ result }, root)).toThrow();
    expect(() => verifyHostedCanaryArtifact({ result: { ...result, expectedRunIds: [runId, "wrun_omitted"] } }, root)).toThrow();
    expect(() => verifyHostedCanaryArtifact({ result: { ...result, canaryValuesArtifact: undefined } }, root)).toThrow("reference");
  });

  it("replays the recorded verifier command with explicit deployment and run-set arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "sayhear-canary-cli-test-"));
    const artifactPath = join(root, "artifacts.json"), valuesPath = join(root, "values.json");
    writeFileSync(artifactPath, JSON.stringify(completeArtifacts()), { mode: 0o600 });
    writeFileSync(valuesPath, JSON.stringify(values), { mode: 0o600 });
    const args = ["--import", "tsx", "scripts/verify-hosted-workflow-canary.ts", "--artifacts", artifactPath, "--values", valuesPath, "--deployment-id", "dpl_acceptance", "--expected-run-ids", runId];
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const mismatch = spawnSync(process.execPath, [...args.slice(0, -1), "wrun_omitted"], { cwd: process.cwd(), encoding: "utf8" });
    expect(mismatch.status).toBe(1);
  });

  it("loads the real locked CLI setup and hydration exports without creating a world", async () => {
    const tools = await loadLockedWorkflowTools(process.cwd());
    expect(tools.cliVersion).toBe("4.3.6");
    expect(typeof tools.setupCliWorld).toBe("function");
    const hydrated = await tools.hydrateResourceIO({ runId, input: "resolved-input" }, null);
    expect(hydrated).toMatchObject({ runId, input: "resolved-input" });
  });

  it("requests and hydrates run data as well as every step/event page", async () => {
    const requests: unknown[] = [];
    const hydrated: unknown[] = [];
    const world = {
      runs: { get: async (_id: string, options?: Record<string, unknown>) => {
        requests.push(options);
        return { runId, deploymentId: "dpl_acceptance", input: "serialized-run-input" };
      } },
      steps: { list: async () => ({ data: [{ runId, stepId: "step1" }], hasMore: false, cursor: null }) },
      events: { list: async () => ({ data: [{ runId, eventId: "event1" }], hasMore: false, cursor: null }) },
    };
    const result = await fetchWorkflowRun(world, async (value) => {
      hydrated.push(value);
      return value;
    }, runId, "dpl_acceptance");
    expect(requests).toEqual([{ resolveData: "all" }]);
    expect(hydrated).toContainEqual(result.run);
    expect(hydrated).toHaveLength(3);
  });

  it("accepts the real SDK's null expiry while rejecting an actual expired timestamp", () => {
    const artifacts = completeArtifacts();
    artifacts.workflowHistory[0]!.expiredAt = null;
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).not.toThrow();
    artifacts.workflowHistory[0]!.expiredAt = "2026-10-01T00:00:00Z";
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).toThrow("expired");
  });

  it("accepts future run retention metadata but still rejects nested expired-data stubs", () => {
    const artifacts = completeArtifacts();
    const future = new Date(Date.now() + 60_000).toISOString();
    artifacts.workflowHistory[0]!.expiredAt = future;
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).not.toThrow();
    artifacts.workflowHistory[0]!.input = [{ expiredAt: future }];
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).toThrow("expired");
  });

  it("rejects invalid retention metadata and scans data despite a future deadline", () => {
    const artifacts = completeArtifacts();
    artifacts.workflowHistory[0]!.expiredAt = "invalid-date";
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).toThrow("expired");
    artifacts.workflowHistory[0]!.expiredAt = new Date(Date.now() + 60_000).toISOString();
    artifacts.workflowHistory[0]!.output = "🔒 Encrypted";
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).toThrow("unresolved");
    artifacts.workflowHistory[0]!.output = values.privateBody;
    expect(() => assertHostedWorkflowCanaryEvidence(asArtifacts(artifacts), values)).toThrow("private_body");
  });

  it("refuses the locked hydration placeholder's exported JSON representation", () => {
    const artifacts = completeArtifacts();
    artifacts.workflowHistory[0]!.input = { toJSON: () => "🔒 Encrypted" };
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(artifacts))).toThrow("unresolved");
  });
  it("requires execution correlation and rejects owner-only or unrelated diagnostics", () => {
    const commandId = "01984477-59a9-7d20-9d97-e588769566a1";
    const userId = "01984477-59a9-7d20-9d97-e588769566a0";
    const artifacts = {
      workflowHistory: [{
        runId: "wrun_test",
        input: {
          workflowCommandId: commandId
        }
      }],
      outboxPayloads: [{
        user_id: userId,
        payload: {
          workflowCommandId: commandId
        }
      }],
      receipts: [{
        action_receipt_id: commandId,
        user_id: userId
      }],
      logs: [{
        runId: "wrun_test"
      }],
      traces: [{
        commandId
      }],
      errors: [{
        commandId,
        code: "provider_timeout"
      }]
    };
    expect(() => assertCanaryExportCorrelation(artifacts, ["wrun_test"])).not.toThrow();
    expect(() => assertCanaryExportCorrelation({
      ...artifacts,
      logs: [{
        userId
      }]
    }, ["wrun_test"])).toThrow("uncorrelated");
    expect(() => assertCanaryExportCorrelation({
      ...artifacts,
      workflowHistory: [{
        runId: "wrun_other",
        input: {
          workflowCommandId: commandId
        }
      }]
    }, ["wrun_test"])).toThrow("correlated");
  });
  it("keeps every native record and follows the continuation cursor", async () => {
    const cursors: (string | undefined)[] = [];
    const first = {
      input: "canary-must-remain-visible",
      runId: "run-1"
    };
    const result = await collectWorkflowPages(async cursor => {
      cursors.push(cursor);
      return cursor ? {
        data: [{
          runId: "run-2"
        }],
        hasMore: false,
        cursor: null
      } : {
        data: [first],
        hasMore: true,
        cursor: "next"
      };
    });
    expect(cursors).toEqual([undefined, "next"]);
    expect(result).toEqual([first, {
      runId: "run-2"
    }]);
  });
  it("rejects truncated exports and repeated cursors", async () => {
    await expect(collectWorkflowPages(async () => ({
      data: [],
      hasMore: true
    }))).rejects.toThrow("Incomplete");
    await expect(collectWorkflowPages(async () => ({
      data: [],
      hasMore: true,
      cursor: "same"
    }))).rejects.toThrow("repeated");
  });
  it("rejects a page that does not declare whether more records exist", async () => {
    await expect(collectWorkflowPages(async () => ({
      data: []
    }))).rejects.toThrow("Invalid");
  });

  it("passes the shared gate only for a complete, correlated, resolved export", () => {
    expect(() =>
      assertHostedWorkflowCanaryEvidence(asArtifacts(completeArtifacts()), values, {
        deploymentId: "dpl_acceptance",
        runIds: [runId],
      }),
    ).not.toThrow();
  });

  it("refuses unresolved encrypted or expired placeholder data", () => {
    const encrypted = completeArtifacts();
    encrypted.workflowHistory[0]!.input = { privateBody: "🔒 Encrypted" };
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(encrypted))).toThrow("unresolved");
    const withExpired = completeArtifacts();
    withExpired.workflowHistory[0]!.output = { value: "<data expired>" };
    expect(() => assertWorkflowHistoryCanaryResolved(asArtifacts(withExpired))).toThrow("unresolved");
  });

  it("refuses an export without the exporter's complete-page provenance", () => {
    const missing = completeArtifacts();
    delete (missing as { completeness?: unknown }).completeness;
    expect(() => assertPreparedWorkflowPages(asArtifacts(missing))).toThrow("complete-page provenance");
    const mismatched = completeArtifacts();
    mismatched.completeness.runs[runId]!.steps = 5;
    expect(() => assertPreparedWorkflowPages(asArtifacts(mismatched))).toThrow("page counts do not match");
    const truncated = completeArtifacts();
    truncated.completeness.runs[runId]!.eventsComplete = false;
    expect(() => assertPreparedWorkflowPages(asArtifacts(truncated))).toThrow("incomplete");
  });

  it("refuses an export from another deployment", () => {
    expect(() =>
      assertHostedWorkflowCanaryEvidence(asArtifacts(completeArtifacts()), values, {
        deploymentId: "dpl_other",
        runIds: [runId],
      }),
    ).toThrow("expected acceptance deployment");
  });

  it("refuses probe leakage through the shared gate", () => {
    const leaked = completeArtifacts();
    leaked.logs = [{ message: values.privateBody }];
    expect(() => assertHostedWorkflowCanaryEvidence(asArtifacts(leaked), values)).toThrow("private data");
  });

  it("accepts only the ADR-0145 raw Provider error waiver while scanning the other five probes", () => {
    expect(() =>
      assertHostedWorkflowCanaryEvidence(asArtifacts(completeArtifacts()), waivedValues, {
        deploymentId: "dpl_acceptance",
        runIds: [runId],
      }),
    ).not.toThrow();
    const leaked = completeArtifacts();
    leaked.logs = [{ runId, message: values.privateBody }];
    expect(() =>
      assertHostedWorkflowCanaryEvidence(asArtifacts(leaked), waivedValues, {
        deploymentId: "dpl_acceptance",
        runIds: [runId],
      }),
    ).toThrow("private data");
  });

  it("refuses a null raw Provider error without the approved ADR-0145 waiver", () => {
    expect(() =>
      assertHostedWorkflowCanaryEvidence(
        asArtifacts(completeArtifacts()),
        { ...values, rawProviderError: null },
        { deploymentId: "dpl_acceptance", runIds: [runId] },
      ),
    ).toThrow("approved ADR-0145 waiver");
  });

  it("does not let the waiver hide a real raw Provider error value", () => {
    const leaked = completeArtifacts();
    leaked.errors = [{ code: "provider_timeout", commandId, message: values.rawProviderError }];
    expect(() =>
      assertHostedWorkflowCanaryEvidence(
        asArtifacts(leaked),
        { ...values, rawProviderErrorWaiver },
        { deploymentId: "dpl_acceptance", runIds: [runId] },
      ),
    ).toThrow("private data");
  });

  it("still refuses empty artifact exports under the waiver", () => {
    const empty = completeArtifacts();
    empty.receipts = [];
    expect(() =>
      assertHostedWorkflowCanaryEvidence(asArtifacts(empty), waivedValues, {
        deploymentId: "dpl_acceptance",
        runIds: [runId],
      }),
    ).toThrow("non-empty receipts artifact export");
  });
});
