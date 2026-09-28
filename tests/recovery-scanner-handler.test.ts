import { describe, expect, it, vi } from "vitest";

import { createRecoveryScannerHandler } from "../apps/web/src/recovery-scanner-handler";

function createHandler(
  failure: unknown,
): (request: Request) => Promise<Response> {
  return createRecoveryScannerHandler({
    scannerSecret: "scanner-secret",
    conversationResponseService: {
      scanStaleResponses: async () => ({ processed: 0, stale: 0 }),
    } as never,
    continuousExchangeService: {
      scanDueInactivity: async () => ({ applied: 0, processed: 0, stale: 0 }),
    } as never,
    journalEligibilityService: {
      scanPendingEligibility: async () => {
        throw failure;
      },
    } as never,
    outboxDispatcherService: {
      dispatchPending: async () => ({ dispatched: 0, failed: 0, reclaimed: 0 }),
    } as never,
  });
}

describe("recovery scanner handler", () => {
  it("returns a content-free schema diagnostic for an undefined database column", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await createHandler({ code: "42703" })(
        new Request("http://localhost/api/internal/recovery/scan", {
          headers: { authorization: "Bearer scanner-secret" },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "recovery_scan_failed",
        diagnosticCode: "schema_drift",
      });
      expect(log).toHaveBeenCalledWith("[sayhear.recovery.scan.error]", {
        diagnosticCode: "schema_drift",
      });
    } finally {
      log.mockRestore();
    }
  });
});
