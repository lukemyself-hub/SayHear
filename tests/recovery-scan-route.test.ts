import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  now: new Date("2026-10-18T22:00:00Z"),
  readDerivedLatency: vi.fn(async () => ({ oldestPendingSeconds: 0, pendingSessions: 0 })),
}));

vi.mock("../apps/web/src/server-composition", () => ({
  createServerComposition: () => ({
    clock: () => fixture.now,
    reflectionReadinessPolicyVersion: "reflection-readiness:v1",
    reflectionRepository: { readDerivedLatency: fixture.readDerivedLatency },
  }),
}));

vi.mock("../apps/web/src/recovery-scanner-handler", () => ({
  createRecoveryScannerHandler: (dependencies: {
    readDerivedLatency: () => Promise<unknown>;
  }) => async () => Response.json(await dependencies.readDerivedLatency()),
}));

import { GET } from "../apps/web/app/api/internal/recovery/scan/route";

describe("recovery scan route", () => {
  it("reads completed runs using their admission policy rather than the scheduling policy", async () => {
    const response = await GET(new Request("http://localhost/api/internal/recovery/scan"));

    expect(response.status).toBe(200);
    expect(fixture.readDerivedLatency).toHaveBeenCalledExactlyOnceWith(
      fixture.now,
      "reflection-admission:v1",
    );
  });
});
