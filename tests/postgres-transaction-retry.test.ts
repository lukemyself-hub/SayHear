import { describe, expect, it, vi } from "vitest";
import { retryPostgresTransaction } from "../packages/data/src/postgres-transaction-retry";

describe("whole transaction conflict retry", () => {
  it.each(["40P01", "40001"])("retries %s at most three whole operations", async (code) => {
    const operation = vi.fn().mockRejectedValueOnce({ code }).mockRejectedValueOnce({ code }).mockResolvedValue("committed");
    expect(await retryPostgresTransaction(operation)).toBe("committed");
    expect(operation).toHaveBeenCalledTimes(3);
    const fails = vi.fn().mockRejectedValue({ code });
    await expect(retryPostgresTransaction(fails)).rejects.toEqual({ code });
    expect(fails).toHaveBeenCalledTimes(3);
  });
  it.each(["55P03", "57014", "ECONNRESET"])("does not retry non-allowlisted %s", async (code) => {
    const operation = vi.fn().mockRejectedValue({ code });
    await expect(retryPostgresTransaction(operation)).rejects.toEqual({ code });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
