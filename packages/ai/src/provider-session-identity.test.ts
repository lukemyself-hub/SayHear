import { describe, expect, it } from "vitest";

import { providerSessionIdFor } from "./provider-session-identity";

describe("providerSessionIdFor", () => {
  it("keeps one conversation stable across different generation commands", () => {
    const dailySessionId = "01984477-59a9-7d20-9d97-e588769566a0";
    const owner = "owner-1";
    const firstTurn = providerSessionIdFor({ ownerId: owner, scopeId: dailySessionId });
    const laterTurn = providerSessionIdFor({ ownerId: owner, scopeId: dailySessionId });
    expect(firstTurn).toBe(laterTurn);
    expect(firstTurn).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates different owners and different logical scopes", () => {
    const scope = "01984477-59a9-7d20-9d97-e588769566a0";
    const a = providerSessionIdFor({ ownerId: "owner-a", scopeId: scope });
    const b = providerSessionIdFor({ ownerId: "owner-b", scopeId: scope });
    const c = providerSessionIdFor({ ownerId: "owner-a", scopeId: `${scope}-other` });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("never embeds the raw owner or scope in the header value", () => {
    const owner = "01984477-59a9-7d20-9d97-e588769566a0";
    const scope = "01984477-59a9-7d20-9d97-e588769566a1";
    const value = providerSessionIdFor({ ownerId: owner, scopeId: scope });
    expect(value).not.toContain(owner);
    expect(value).not.toContain(scope);
  });

  it("fails closed when the logical scope is missing", () => {
    expect(() => providerSessionIdFor({ ownerId: "owner", scopeId: "  " })).toThrow(
      /non-empty trusted logical scope/,
    );
  });
});
