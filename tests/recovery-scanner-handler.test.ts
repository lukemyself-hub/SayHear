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
    readDerivedLatency: async () => ({ oldestPendingSeconds: 0, pendingSessions: 0 }),
  });
}

describe("recovery scanner handler", () => {
  it("executes the scan pipeline for an authenticated GET and reports dispatch counters", async () => {
    // A 200 acknowledges that the scan ran and the outbox accepted the
    // dispatch; it is not evidence that downstream workflows reached a
    // terminal state. The returned counters are the observable dispatch
    // result, and no terminal-completion field is asserted here.
    const handler = createRecoveryScannerHandler({
      scannerSecret: "scanner-secret",
      conversationResponseService: {
        scanStaleResponses: async () => ({ processed: 7, stale: 3 }),
      } as never,
      continuousExchangeService: {
        scanDueInactivity: async () => ({ applied: 4, processed: 4, stale: 0 }),
      } as never,
      journalEligibilityService: {
        scanPendingEligibility: async () => ({ eligible: 9 }),
      } as never,
      outboxDispatcherService: {
        dispatchPending: async () => ({ dispatched: 5, failed: 0, reclaimed: 1 }),
      } as never,
      readDerivedLatency: async () => ({ oldestPendingSeconds: 7310, pendingSessions: 2 }),
    });

    const response = await handler(
      new Request("http://localhost/api/internal/recovery/scan", {
        method: "GET",
        headers: { authorization: "Bearer scanner-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inactivity: { applied: 4, processed: 4, stale: 0 },
      responses: { processed: 7, stale: 3 },
      eligibility: { eligible: 9 },
      dialogueState: { queued: 0 },
      rollingSummary: { queued: 0 },
      purge: { retried: 0, remaining: 0 },
      consolidation: { daily: 0, weekly: 0, sweeper: 0, reArmed: 0 },
      episode: { buildsQueued: 0, maintenanceQueued: 0 },
      reflection: { dailyQueued: 0, weeklyQueued: 0, maintenanceQueued: 0 },
      derivedLatency: { oldestPendingSeconds: 7310, pendingSessions: 2 },
      candidateRemaps: { remapCommandsCreated: 0 },
      outbox: { dispatched: 5, failed: 0, reclaimed: 1 },
    });
  });

  it("rejects an unauthenticated GET before running the scan", async () => {
    const handler = createRecoveryScannerHandler({
      scannerSecret: "scanner-secret",
      conversationResponseService: {
        scanStaleResponses: async () => {
          throw new Error("the scan must not run for a rejected request");
        },
      } as never,
      continuousExchangeService: {
        scanDueInactivity: async () => ({ applied: 0, processed: 0, stale: 0 }),
      } as never,
      journalEligibilityService: {
        scanPendingEligibility: async () => ({ eligible: 0 }),
      } as never,
      outboxDispatcherService: {
        dispatchPending: async () => ({
          dispatched: 0,
          failed: 0,
          reclaimed: 0,
        }),
      } as never,
      readDerivedLatency: async () => ({ oldestPendingSeconds: 0, pendingSessions: 0 }),
    });

    const response = await handler(
      new Request("http://localhost/api/internal/recovery/scan", {
        method: "GET",
        headers: { authorization: "Bearer wrong" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

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
