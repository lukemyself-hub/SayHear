import { describe, expect, it } from "vitest";

import {
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_RECALL_DEFAULT_POLICY,
  HistoryRecallGovernanceConflictError,
  InternalOwnerAccessDeniedError,
  asUserId,
  type HistoryRecallGovernancePolicy,
  type HistoryRecallGovernanceRepository,
  type InternalOwnerAccessService,
} from "@sayhear/application";

import { createOperatorHistoryRecallHandler } from "../apps/web/src/operator-history-recall-handler";

const OWNER = asUserId("00000000-0000-7000-8000-000000000001");

function policy(version: string, status: "active" | "revoked"): HistoryRecallGovernancePolicy {
  return {
    changedBy: String(OWNER),
    compilerVersion: "context-compiler:history-time:v1",
    createdAt: "2026-10-11T08:00:00.000Z",
    harnessPolicyVersion: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
    historyPolicyVersion: HISTORY_RECALL_DEFAULT_POLICY.version,
    policyVersion: version,
    revokedAt: status === "revoked" ? "2026-10-11T09:00:00.000Z" : null,
    revokedBy: status === "revoked" ? String(OWNER) : null,
    status,
  };
}

function repository(): HistoryRecallGovernanceRepository {
  let active: HistoryRecallGovernancePolicy | null = null;
  const all: HistoryRecallGovernancePolicy[] = [];
  let counter = 0;
  return {
    async findActivePolicy() {
      return active;
    },
    async findEffectiveState() {
      return { active, enabled: active !== null, latest: all.at(-1) ?? null, policyCount: all.length };
    },
    async findPolicyStatus(version) {
      return all.find((entry) => entry.policyVersion === version)?.status ?? "absent";
    },
    async insertActivePolicy() {
      if (active) throw new HistoryRecallGovernanceConflictError();
      counter += 1;
      active = policy(`history-recall-governance:test-${counter}`, "active");
      all.push(active);
      return active;
    },
    async revokeActivePolicy() {
      if (!active) return { outcome: "already_disabled" as const };
      const revoked = policy(active.policyVersion, "revoked");
      active = null;
      all.push(revoked);
      return { outcome: "revoked" as const, policy: revoked };
    },
  };
}

const allowedAccess = { getAccess: async () => ({}) } as unknown as InternalOwnerAccessService;
const deniedAccess = {
  getAccess: async () => {
    throw new InternalOwnerAccessDeniedError();
  },
} as unknown as InternalOwnerAccessService;

function handler(options: { access?: InternalOwnerAccessService; authenticated?: boolean } = {}) {
  const repo = repository();
  return {
    handle: createOperatorHistoryRecallHandler({
      accessService: options.access ?? allowedAccess,
      authenticate: async () => (options.authenticated === false ? null : { userId: OWNER }),
      now: () => new Date("2026-10-11T10:00:00.000Z"),
      repository: repo,
    }),
    repo,
  };
}

const post = (action: unknown) =>
  new Request("http://localhost/api/internal/operator/history-recall", {
    body: JSON.stringify({ action }),
    method: "POST",
  });

describe("operator history-recall governance endpoint", () => {
  it("requires a signed-in Internal Owner and refuses client-supplied owner ids", async () => {
    expect((await handler({ authenticated: false }).handle(post("enable"))).status).toBe(401);
    expect((await handler({ access: deniedAccess }).handle(post("enable"))).status).toBe(403);
    const withOwner = new Request("http://localhost/api/internal/operator/history-recall?user_id=x", { method: "GET" });
    expect((await handler().handle(withOwner)).status).toBe(400);
  });

  it("enables with a new version, refuses a second active one, and disables to nothing", async () => {
    const { handle } = handler();
    const enabled = await handle(post("enable"));
    expect(enabled.status).toBe(200);
    const body = (await enabled.json()) as { effective: { enabled: boolean }; outcome: string; policy: { historyPolicyVersion: string } };
    expect(body.outcome).toBe("enabled");
    expect(body.effective.enabled).toBe(true);
    expect(body.policy.historyPolicyVersion).toBe(HISTORY_RECALL_DEFAULT_POLICY.version);
    expect((await handle(post("enable"))).status).toBe(409);

    const disabled = (await (await handle(post("disable"))).json()) as { effective: { enabled: boolean }; outcome: string };
    expect(disabled).toMatchObject({ effective: { enabled: false }, outcome: "revoked" });
    expect(((await (await handle(post("disable"))).json()) as { outcome: string }).outcome).toBe("already_disabled");
  });

  it("enables again with a brand-new version and never reuses a revoked one", async () => {
    const { handle } = handler();
    const first = (await (await handle(post("enable"))).json()) as { policy: { policyVersion: string } };
    await handle(post("disable"));
    const second = (await (await handle(post("enable"))).json()) as { policy: { policyVersion: string } };
    expect(second.policy.policyVersion).not.toBe(first.policy.policyVersion);
  });

  it("rejects an unknown action and a non-POST/GET method", async () => {
    const { handle } = handler();
    expect((await handle(post("purge"))).status).toBe(400);
    expect((await handle(new Request("http://localhost/x", { method: "DELETE" }))).status).toBe(405);
  });
});
