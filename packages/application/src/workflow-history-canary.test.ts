import { describe, expect, it } from "vitest";

import {
  assertWorkflowHistoryCanaryClean,
  isRawProviderErrorWaiver,
  RAW_PROVIDER_ERROR_WAIVER,
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

const waiver = {
  approvedBy: "Luke",
  check: "raw_provider_error",
  decision: "ADR-0145",
  scope: "g1-restoration-2026-10-01",
  status: "skipped",
  version: "g1-raw-provider-error-waiver:v1",
} as const;

/** The five clean probes plus the ADR-0145 raw Provider error waiver. */
const waivedCanary = {
  ...canary,
  rawProviderError: null,
  rawProviderErrorWaiver: waiver,
};

function cleanArtifacts(): WorkflowCanaryArtifacts {
  return {
    errors: [{ code: "provider_timeout" }],
    logs: [{ workflowCommandId: "command-1", status: "started" }],
    outboxPayloads: [{ sourceRevision: 2, workflowCommandId: "command-1" }],
    receipts: [{ disposition: "published", status: "succeeded" }],
    traces: [{ workflowReceiptId: "run-1" }],
    workflowHistory: [{ output: { outcome: "published" } }],
  };
}

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

  it("skips only raw_provider_error with the exact ADR-0145 waiver", () => {
    expect(() =>
      assertWorkflowHistoryCanaryClean(cleanArtifacts(), waivedCanary),
    ).not.toThrow();
    expect(isRawProviderErrorWaiver(RAW_PROVIDER_ERROR_WAIVER)).toBe(true);
    expect(isRawProviderErrorWaiver(waiver)).toBe(true);
  });

  it("still scans the other five probes while the raw Provider error is waived", () => {
    const leaked = cleanArtifacts();
    (leaked.logs as unknown[])[0] = { message: canary.privateBody };
    expect(() =>
      assertWorkflowHistoryCanaryClean(leaked, waivedCanary),
    ).toThrow("logs:private_body");
  });

  it("refuses a null raw Provider error without the approved waiver", () => {
    const values = { ...canary, rawProviderError: null };
    expect(() => assertWorkflowHistoryCanaryClean(cleanArtifacts(), values)).toThrow(
      "approved ADR-0145 waiver",
    );
  });

  it("refuses unknown or tampered waiver metadata", () => {
    const tampered = [
      { ...waiver, approvedBy: "Mallory" },
      { ...waiver, decision: "ADR-0000" },
      { ...waiver, scope: "another-release" },
      { ...waiver, check: "secret" },
      { ...waiver, status: "passed" },
      { ...waiver, version: "g1-raw-provider-error-waiver:v2" },
      { ...waiver, extra: true },
      null,
      "skipped",
    ];
    for (const rawProviderErrorWaiver of tampered) {
      expect(() =>
        assertWorkflowHistoryCanaryClean(cleanArtifacts(), {
          ...canary,
          rawProviderError: null,
          rawProviderErrorWaiver,
        }),
      ).toThrow("approved ADR-0145 waiver");
    }
  });

  it("does not let the waiver suppress an existing real raw Provider error value", () => {
    const leaked = cleanArtifacts();
    (leaked.errors as unknown[])[0] = {
      code: "provider_timeout",
      message: canary.rawProviderError,
    };
    expect(() =>
      assertWorkflowHistoryCanaryClean(leaked, {
        ...canary,
        rawProviderErrorWaiver: waiver,
      }),
    ).toThrow("errors:raw_provider_error");
  });

  it("still requires the other five configured values to be non-empty strings", () => {
    expect(() =>
      assertWorkflowHistoryCanaryClean(cleanArtifacts(), {
        ...waivedCanary,
        secret: "   ",
      }),
    ).toThrow("must all be non-empty");
  });

  it("still requires every artifact export to be non-empty under the waiver", () => {
    for (const source of [
      "workflowHistory",
      "outboxPayloads",
      "logs",
      "traces",
      "errors",
      "receipts",
    ] as const) {
      const artifacts = cleanArtifacts();
      (artifacts as Record<string, unknown>)[source] = [];
      expect(() =>
        assertWorkflowHistoryCanaryClean(artifacts, waivedCanary),
      ).toThrow(`requires a non-empty ${source} artifact export`);
    }
  });
});
