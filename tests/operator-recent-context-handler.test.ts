import { describe, expect, it } from "vitest";

import {
  InternalOwnerAccessDeniedError,
  RECENT_CONTEXT_DEFAULT_POLICY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  RecentContextGovernanceConflictError,
  asUserId,
  type InternalOwnerAccessService,
  type RecentContextGovernanceEffectiveState,
  type RecentContextGovernanceInput,
  type RecentContextGovernancePolicy,
  type RecentContextGovernanceRepository,
} from "@sayhear/application";

import { createOperatorRecentContextHandler } from "../apps/web/src/operator-recent-context-handler";

const OWNER = asUserId("00000000-0000-7000-8000-000000000001");

function policy(
  policyVersion: string,
  status: "active" | "revoked",
): RecentContextGovernancePolicy {
  return {
    budgetTokens: 4_000,
    changedBy: String(OWNER),
    compilerVersion: "context-compiler:recent:v1",
    createdAt: "2026-08-27T08:00:00.000Z",
    maxCandidateBytes: 5_000_000,
    maxCandidateRows: 500,
    maxSingleEventTokens: 2_000,
    policyVersion,
    readTimeoutMs: 5_000,
    revokedAt: status === "revoked" ? "2026-08-27T09:00:00.000Z" : null,
    revokedBy: status === "revoked" ? String(OWNER) : null,
    selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
    selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    status,
  };
}

function createRepository(seed?: RecentContextGovernancePolicy) {
  let active: RecentContextGovernancePolicy | null = seed ?? null;
  const versions: RecentContextGovernancePolicy[] = active ? [active] : [];
  let counter = 0;
  const repository: RecentContextGovernanceRepository = {
    async findActivePolicy() {
      return active;
    },
    async findEffectiveState(): Promise<RecentContextGovernanceEffectiveState> {
      return {
        active,
        enabled: active !== null,
        latest: versions.at(-1) ?? null,
        policyCount: versions.length,
      };
    },
    async findPolicyStatus(policyVersion) {
      return (
        versions.find((entry) => entry.policyVersion === policyVersion)
          ?.status ?? "absent"
      );
    },
    async insertActivePolicy(input: RecentContextGovernanceInput) {
      if (active) throw new RecentContextGovernanceConflictError();
      counter += 1;
      const created = policy(`recent-context-governance:test-${counter}`, "active");
      active = created;
      versions.push(created);
      return created;
    },
    async revokeActivePolicy() {
      if (!active) return { outcome: "already_disabled" as const };
      const revoked = policy(active.policyVersion, "revoked");
      active = null;
      versions.push(revoked);
      return { outcome: "revoked" as const, policy: revoked };
    },
  };
  return repository;
}

function createAccessService(denied: boolean): InternalOwnerAccessService {
  return {
    async getAccess() {
      if (denied) throw new InternalOwnerAccessDeniedError();
    },
  } as unknown as InternalOwnerAccessService;
}

function handler(
  repository: RecentContextGovernanceRepository,
  options: { denied?: boolean; authenticated?: boolean } = {},
) {
  return createOperatorRecentContextHandler({
    accessService: createAccessService(options.denied ?? false),
    authenticate: async () =>
      options.authenticated === false ? null : { userId: OWNER },
    now: () => new Date("2026-08-27T08:00:00.000Z"),
    repository,
  });
}

describe("operator recent-context governance handler (#295)", () => {
  it("reports the content-free effective state on GET", async () => {
    const response = await handler(createRepository(policy("v1", "active")))(
      new Request("https://example.test/api/internal/operator/recent-context"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active: { policyVersion: "v1" },
      enabled: true,
      policyCount: 1,
    });
  });

  it("disables by revoking the active version and re-enables with a new version", async () => {
    const repository = createRepository(policy("v1", "active"));
    const disable = await handler(repository)(
      new Request(
        "https://example.test/api/internal/operator/recent-context",
        {
          body: JSON.stringify({ action: "disable" }),
          method: "POST",
        },
      ),
    );
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({
      effective: { enabled: false },
      outcome: "revoked",
    });

    const enable = await handler(repository)(
      new Request(
        "https://example.test/api/internal/operator/recent-context",
        {
          body: JSON.stringify({ action: "enable" }),
          method: "POST",
        },
      ),
    );
    expect(enable.status).toBe(200);
    const body = (await enable.json()) as {
      outcome: string;
      policy: { policyVersion: string };
    };
    expect(body.outcome).toBe("enabled");
    expect(body.policy.policyVersion).not.toBe("v1");
  });

  it("fails closed on a second enable while a version is active", async () => {
    const response = await handler(createRepository(policy("v1", "active")))(
      new Request(
        "https://example.test/api/internal/operator/recent-context",
        { body: JSON.stringify({ action: "enable" }), method: "POST" },
      ),
    );
    expect(response.status).toBe(409);
  });

  it("requires a valid action, authentication and the Owner capability", async () => {
    const repository = createRepository(policy("v1", "active"));
    const invalid = await handler(repository)(
      new Request(
        "https://example.test/api/internal/operator/recent-context",
        { body: JSON.stringify({ action: "explode" }), method: "POST" },
      ),
    );
    expect(invalid.status).toBe(400);

    const unauthorized = await handler(repository, {
      authenticated: false,
    })(
      new Request("https://example.test/api/internal/operator/recent-context"),
    );
    expect(unauthorized.status).toBe(401);

    const forbidden = await handler(repository, { denied: true })(
      new Request("https://example.test/api/internal/operator/recent-context"),
    );
    expect(forbidden.status).toBe(403);
  });

  it("returns 405 for PUT/DELETE and 400 for invalid JSON", async () => {
    const repository = createRepository(policy("v1", "active"));
    for (const method of ["PUT", "DELETE"]) {
      const response = await handler(repository)(
        new Request(
          "https://example.test/api/internal/operator/recent-context",
          { body: "{}", method },
        ),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST");
    }

    const invalidJson = await handler(repository)(
      new Request(
        "https://example.test/api/internal/operator/recent-context",
        { body: "{not-json", method: "POST" },
      ),
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("rejects client-supplied owner identifiers", async () => {
    const response = await handler(createRepository())(
      new Request(
        "https://example.test/api/internal/operator/recent-context?owner_id=x",
      ),
    );
    expect(response.status).toBe(400);
  });
});
