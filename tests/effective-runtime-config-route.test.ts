import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const assertOperator = vi.fn(async () => {});
  const createServerComposition = vi.fn(() => ({
    authOptions: {},
    accessService: { assertOperator },
    recentContextGovernanceRepository: {
      findEffectiveState: async () => ({
        active: null,
        enabled: false,
        latest: null,
        policyCount: 0,
      }),
    },
  }));
  return { assertOperator, createServerComposition };
});

vi.mock("../apps/web/src/server-composition", () => ({
  createServerComposition: mocks.createServerComposition,
}));

import {
  RECENT_CONTEXT_COMPILER_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  type RecentContextGovernancePolicy,
} from "@sayhear/application";

import { GET } from "../apps/web/app/api/internal/inspection/effective-runtime-config/route";
import { buildEffectiveRuntimeConfiguration } from "../apps/web/src/effective-runtime-config";
import {
  EFFECTIVE_RUNTIME_CONFIG_CATEGORIES,
  parseEffectiveConfigurationSnapshot,
} from "../scripts/effective-runtime-config-gate.ts";

const environment = {
  NODE_ENV: "test",
  SAYHEAR_PROVIDER_ADAPTER: "openai",
  OPENAI_API_KEY: "sk-route-openai-secret",
  DATABASE_URL: "postgres://user:route-dbsecret@business-pooler.db.example.com:5432/sayhear",
  PURGE_MARKER_DATABASE_URL: "postgres://user:route-markersecret@marker.db.example.com:5432/sayhear",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
  VERCEL_PROJECT_ID: "prj_route",
  VERCEL_ORG_ID: "team_route",
  VERCEL_DEPLOYMENT_ID: "dpl_route",
  NEXTAUTH_SECRET: "route-nextauth-secret",
  SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "route-backup-config",
  SAYHEAR_BACKUP_POLICY_VERSION: "neon-free-6h-pitr-1gb-limit",
  GITHUB_CLIENT_ID: "route-client-id",
  GITHUB_CLIENT_SECRET: "route-github-secret",
  SAYHEAR_CONTEXT_HMAC_SECRET: "route-context-hmac",
  CRON_SECRET: "route-cron-secret",
} as const;

// The PR CI workflow exports these synthetic variables for the whole job.
// `SAYHEAR_DEPLOYMENT` conflicts with the `VERCEL_ENV=preview` signal this
// test asserts, and `resolveDeployment` correctly rejects the contradiction,
// so the test must remove any inherited value before exercising the route.
const inheritedKeysToClear = ["SAYHEAR_DEPLOYMENT"] as const;

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(environment)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  for (const key of inheritedKeysToClear) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of [...Object.keys(environment), ...inheritedKeysToClear]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("effective runtime configuration route", () => {
  it("returns the content-free snapshot to the Cron operator bearer", async () => {
    const response = await GET(
      new Request("https://acceptance.example/api/internal/inspection/effective-runtime-config", {
        headers: { authorization: "Bearer route-cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    const snapshot = parseEffectiveConfigurationSnapshot(await response.json());
    expect(snapshot.commit).toBe("c".repeat(40));
    expect(snapshot.deploymentId).toBe("dpl_route");
    expect(new Set(snapshot.items.map((entry) => entry.category))).toEqual(
      new Set(EFFECTIVE_RUNTIME_CONFIG_CATEGORIES),
    );
    // #295: the independent recent-context governance is reported content-free
    // and separately from the G1 manifest fingerprint.
    expect(
      snapshot.items.find(
        (entry) => entry.key === "switch.recent_context_enabled",
      ),
    ).toMatchObject({ inManifestFingerprint: false, value: false });
    expect(
      snapshot.items.find(
        (entry) => entry.key === "policy.recent_context_governance_version",
      ),
    ).toMatchObject({ inManifestFingerprint: false, source: "unverified" });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("route-dbsecret");
    expect(serialized).not.toContain("route-github-secret");
    expect(serialized).not.toContain("postgres://");
  });
});

describe("effective runtime configuration recent-context governance (#295)", () => {
  function activePolicy(
    overrides: Partial<RecentContextGovernancePolicy> = {},
  ): RecentContextGovernancePolicy {
    return {
      budgetTokens: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
      changedBy: "operator",
      compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
      createdAt: "2026-08-27T08:00:00.000Z",
      maxCandidateBytes:
        RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
      maxCandidateRows: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
      maxSingleEventTokens:
        RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens,
      policyVersion: "recent-context-governance:test",
      readTimeoutMs: RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs,
      revokedAt: null,
      revokedBy: null,
      selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
      selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      status: "active",
      ...overrides,
    };
  }

  function governanceOf(active: RecentContextGovernancePolicy) {
    return {
      active,
      enabled: true,
      latest: active,
      policyCount: 1,
    };
  }

  it("reports override with real values for a matching active policy", () => {
    const snapshot = buildEffectiveRuntimeConfiguration(environment, {
      recentContextGovernance: governanceOf(activePolicy()),
    });
    const item = (key: string) =>
      snapshot.items.find((entry) => entry.key === key)!;
    expect(item("switch.recent_context_enabled")).toMatchObject({
      inManifestFingerprint: false,
      source: "override",
      value: true,
    });
    expect(item("policy.recent_context_governance_version")).toMatchObject({
      source: "override",
      value: "recent-context-governance:test",
    });
    expect(item("parameters.recent_context.budget_tokens")).toMatchObject({
      source: "override",
      value: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
    });
  });

  it("reports not-effective and unverified on a mismatched active policy", () => {
    const snapshot = buildEffectiveRuntimeConfiguration(environment, {
      recentContextGovernance: governanceOf(
        activePolicy({ compilerVersion: "context-compiler:v1" }),
      ),
    });
    const item = (key: string) =>
      snapshot.items.find((entry) => entry.key === key)!;
    expect(item("switch.recent_context_enabled")).toMatchObject({
      inManifestFingerprint: false,
      source: "override",
      value: false,
    });
    expect(item("policy.recent_context_governance_version")).toMatchObject({
      source: "unverified",
      value: null,
    });
    expect(item("parameters.recent_context.budget_tokens")).toMatchObject({
      source: "unverified",
      value: null,
    });
  });
});
