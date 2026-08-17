import { describe, expect, it } from "vitest";

import {
  assertWorkflowHistoryCanaryClean,
  type WorkflowCanaryArtifacts,
} from "./workflow-history-canary";

const canary = {
  actionPayload: "CANARY-ACTION-PAYLOAD",
  contentHmac: "CANARY-CONTENT-HMAC",
  privateBody: "CANARY-PRIVATE-BODY",
  rawProviderError: "CANARY-RAW-PROVIDER-ERROR",
  renderedPrompt: "CANARY-RENDERED-PROMPT",
  secret: "CANARY-SECRET",
};

describe("hosted Workflow history canary", () => {
  it("reports the artifact source and category without echoing a private canary value", () => {
    let error: unknown;
    try {
      assertWorkflowHistoryCanaryClean({
        errors: [{ code: "provider_timeout" }],
        logs: [{ message: canary.renderedPrompt }],
        outboxPayloads: [{ workflowCommandId: "command-1" }],
        receipts: [{ payload: canary.actionPayload }],
        traces: [{ workflowReceiptId: "run-1" }],
        workflowHistory: [{ input: { workflowCommandId: "command-1" } }],
      }, canary);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      "message",
      "Hosted Workflow canary found private data in logs:rendered_prompt, receipts:action_payload.",
    );
    expect((error as Error).message).not.toContain(canary.renderedPrompt);
    expect((error as Error).message).not.toContain(canary.actionPayload);
  });

  it("accepts ID-only Workflow and operational artifacts", () => {
    expect(() =>
      assertWorkflowHistoryCanaryClean({
        errors: [{ code: "provider_timeout" }],
        logs: [{ workflowCommandId: "command-1", status: "started" }],
        outboxPayloads: [{ sourceRevision: 2, workflowCommandId: "command-1" }],
        receipts: [{ disposition: "published", status: "succeeded" }],
        traces: [{ workflowReceiptId: "run-1" }],
        workflowHistory: [{ output: { outcome: "published" } }],
      }, canary),
    ).not.toThrow();
  });

  it("fails closed when a required hosted artifact source was not exported", () => {
    expect(() =>
      assertWorkflowHistoryCanaryClean({
        errors: [{ code: "provider_timeout" }],
        logs: [{ workflowCommandId: "command-1" }],
        outboxPayloads: [{ workflowCommandId: "command-1" }],
        receipts: [{ status: "succeeded" }],
        traces: [{ workflowReceiptId: "run-1" }],
      } as unknown as WorkflowCanaryArtifacts, canary),
    ).toThrow("requires a non-empty workflowHistory artifact export");
  });
});
