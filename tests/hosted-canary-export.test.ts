import { describe, expect, it } from "vitest";
import { assertCanaryExportCorrelation, collectWorkflowPages } from "../scripts/export-hosted-workflow-canary";
describe("hosted canary platform export", () => {
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
});
