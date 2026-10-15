import { describe, expect, it, vi } from "vitest";
import { asUserId, RecoveryGateClosedError } from "@sayhear/application";
import { createJournalRetryHandler } from "../apps/web/src/journal-retry-handler";

const userId = asUserId("01984477-aaaa-7bbb-8ccc-dddddddddddd");
const open = { markerDataEpoch: null, markerPurgedAt: null, markerWrittenAt: null, receiptDestinations: [], status: "open" as const };
const request = (body: unknown, origin = "http://localhost", headers: Record<string, string> = {}) => new Request("http://localhost/api/internal/journals/retry", { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("terminal Journal retry", () => {
  it("uses authenticated Owner and selected date", async () => {
    const retry = vi.fn().mockResolvedValue(true);
    const response = await createJournalRetryHandler({ authenticate: async () => ({ userId }), recoveryGate: { evaluate: async () => open, requireOpen: async () => open }, retryForDate: retry })(request({ logicalDate: "2026-10-13" }));
    expect(response.status).toBe(202);
    expect(retry).toHaveBeenCalledWith({ userId, logicalDate: "2026-10-13" });
  });
  it.each([{ logicalDate: "2026-02-30" }, { logicalDate: "2026-10-13", userId: "other" }, {}])("rejects invalid date or client identity", async (body) => {
    const retry = vi.fn();
    const response = await createJournalRetryHandler({ authenticate: async () => ({ userId }), recoveryGate: { evaluate: async () => open, requireOpen: async () => open }, retryForDate: retry })(request(body));
    expect(response.status).toBe(400);
    expect(retry).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and unauthenticated mutation", async () => {
    const retry = vi.fn();
    const handler = createJournalRetryHandler({ authenticate: async () => ({ userId }), recoveryGate: { evaluate: async () => open, requireOpen: async () => open }, retryForDate: retry });
    expect((await handler(request({ logicalDate: "2026-10-13" }, "http://other"))).status).toBe(403);
    expect((await handler(request({ logicalDate: "2026-10-13" }, "http://localhost", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    const anonymous = createJournalRetryHandler({ authenticate: async () => null, recoveryGate: { evaluate: async () => open, requireOpen: async () => open }, retryForDate: retry });
    expect((await anonymous(request({ logicalDate: "2026-10-13" }))).status).toBe(401);
    expect(retry).not.toHaveBeenCalled();
  });
  it("denies closed Recovery Gate without mutating", async () => {
    const retry = vi.fn();
    const handler = createJournalRetryHandler({ authenticate: async () => ({ userId }), recoveryGate: { evaluate: async () => open, requireOpen: async () => { throw new RecoveryGateClosedError({ ...open, status: "needs_attention" }); } }, retryForDate: retry });
    expect((await handler(request({ logicalDate: "2026-10-13" }))).status).toBe(503);
    expect(retry).not.toHaveBeenCalled();
  });
});
