import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const assertOperator = vi.fn(async () => {});
  const createServerComposition = vi.fn(() => ({
    authOptions: {},
    accessService: { assertOperator },
  }));
  return { assertOperator, createServerComposition };
});

vi.mock("../apps/web/src/server-composition", () => ({
  createServerComposition: mocks.createServerComposition,
}));

import { GET } from "../apps/web/app/api/internal/inspection/effective-runtime-config/route";
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

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(environment)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const key of Object.keys(environment)) {
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
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("route-dbsecret");
    expect(serialized).not.toContain("route-github-secret");
    expect(serialized).not.toContain("postgres://");
  });
});
