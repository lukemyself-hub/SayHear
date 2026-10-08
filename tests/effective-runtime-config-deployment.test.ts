import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildEffectiveRuntimeConfiguration,
  handleEffectiveRuntimeConfigRequest,
  type EffectiveRuntimeConfigHandlerDependencies,
} from "../apps/web/src/effective-runtime-config";
import {
  EFFECTIVE_RUNTIME_CONFIG_CATEGORIES,
  EFFECTIVE_RUNTIME_CONFIG_VERSION,
  parseEffectiveConfigurationSnapshot,
} from "../scripts/effective-runtime-config-gate.ts";

const deployedEnvironment = {
  NODE_ENV: "test",
  SAYHEAR_PROVIDER_ADAPTER: "openai",
  OPENAI_API_KEY: "sk-live-openai-secret-value",
  DATABASE_URL: "postgres://user:dbsecret@business-pooler.db.example.com:5432/sayhear",
  PURGE_MARKER_DATABASE_URL: "postgres://user:markersecret@marker.db.example.com:5432/sayhear",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  VERCEL_PROJECT_ID: "prj_isolated",
  VERCEL_ORG_ID: "team_isolated",
  VERCEL_DEPLOYMENT_ID: "dpl_isolated",
  NEXTAUTH_SECRET: "nextauth-secret-value",
  SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "backup-config-fingerprint",
  SAYHEAR_BACKUP_POLICY_VERSION: "neon-free-6h-pitr-1gb-limit",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-secret-value",
  SAYHEAR_CONTEXT_HMAC_SECRET: "context-hmac-secret-value",
  CRON_SECRET: "cron-secret-value",
  SAYHEAR_INTERNAL_OWNER_SUBJECT: "1001",
  SAYHEAR_INTERNAL_OWNER_USER_ID: "user-1001",
} as const;

const now = () => new Date("2026-10-07T20:00:00.000Z");

describe("deployed effective runtime configuration", () => {
  it("builds a content-free snapshot that covers every required category and binds deployment identity", () => {
    const built = buildEffectiveRuntimeConfiguration(deployedEnvironment, { now });

    expect(built.version).toBe(EFFECTIVE_RUNTIME_CONFIG_VERSION);
    expect(built.commit).toBe("a".repeat(40));
    expect(built.deploymentId).toBe("dpl_isolated");
    expect(built.collectedAt).toBe("2026-10-07T20:00:00.000Z");
    expect(new Set(built.items.map((entry) => entry.category))).toEqual(
      new Set(EFFECTIVE_RUNTIME_CONFIG_CATEGORIES),
    );
    // The payload the deployment returns is exactly what the comparison gate
    // is allowed to parse.
    const parsed = parseEffectiveConfigurationSnapshot(
      JSON.parse(JSON.stringify(built)),
    );
    expect(parsed.items).toHaveLength(built.items.length);
  });

  it("never emits a secret value, connection string or private body", () => {
    const built = buildEffectiveRuntimeConfiguration(deployedEnvironment, { now });
    const serialized = JSON.stringify(built);
    for (const forbidden of [
      "sk-live-openai-secret-value",
      "dbsecret",
      "markersecret",
      "nextauth-secret-value",
      "github-secret-value",
      "context-hmac-secret-value",
      "cron-secret-value",
      "postgres://",
      "postgresql://",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports credential existence only and never the credential itself", () => {
    const built = buildEffectiveRuntimeConfiguration(deployedEnvironment, { now });
    const providerKey = built.items.find(
      (entry) => entry.key === "credentials.provider_key",
    );
    expect(providerKey?.value).toBe("present");
    expect(providerKey?.critical).toBe(true);
    expect(built.items.find((entry) => entry.key === "credentials.cron_secret")?.value).toBe(
      "present",
    );
  });

  it("reports the default, the override source, and marks an unreadable key unverified", () => {
    const withDefault = buildEffectiveRuntimeConfiguration(deployedEnvironment, { now });
    const providerDeadline = withDefault.items.find(
      (entry) => entry.key === "deadline.provider_ms",
    );
    expect(providerDeadline).toMatchObject({
      source: "default",
      value: 60_000,
      defaultValue: 60_000,
    });

    const withOverride = buildEffectiveRuntimeConfiguration(
      { ...deployedEnvironment, SAYHEAR_PROVIDER_TIMEOUT_MS: "300000" },
      { now },
    );
    expect(
      withOverride.items.find((entry) => entry.key === "deadline.provider_ms"),
    ).toMatchObject({ source: "override", value: 300_000, defaultValue: 60_000 });

    const scheduleTarget = withDefault.items.find(
      (entry) => entry.key === "schedule.recovery_scan_target",
    );
    expect(scheduleTarget).toMatchObject({
      source: "unverified",
      value: null,
      critical: false,
    });
  });

  it("records the safe target identity of a separate business and purge-marker database", () => {
    const built = buildEffectiveRuntimeConfiguration(deployedEnvironment, { now });
    const business = built.items.find(
      (entry) => entry.key === "database.business_target",
    );
    const marker = built.items.find(
      (entry) => entry.key === "database.purge_marker_target",
    );
    expect(business?.value).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(marker?.value).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(business?.value).not.toBe(marker?.value);
  });
});

describe("effective runtime configuration inspection handler", () => {
  const dependencies = (
    overrides: Partial<EffectiveRuntimeConfigHandlerDependencies> = {},
  ): EffectiveRuntimeConfigHandlerDependencies => ({
    environment: deployedEnvironment,
    operatorSecret: "test-only-cron-secret",
    getSession: async () => null,
    assertOperator: async () => {},
    now,
    ...overrides,
  });

  it("refuses an unauthenticated request", async () => {
    const response = await handleEffectiveRuntimeConfigRequest(
      new Request("https://acceptance.example/api/internal/inspection/effective-runtime-config"),
      dependencies(),
    );
    expect(response.status).toBe(401);
  });

  it("refuses an authenticated non-operator session", async () => {
    const response = await handleEffectiveRuntimeConfigRequest(
      new Request("https://acceptance.example", { headers: { cookie: "session" } }),
      dependencies({
        getSession: async () => ({ user: { id: "user-1" } }),
        assertOperator: async () => {
          throw new Error("not an operator");
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("returns the content-free snapshot to the Cron operator bearer without reading local declarations", async () => {
    const response = await handleEffectiveRuntimeConfigRequest(
      new Request("https://acceptance.example", {
        headers: { authorization: "Bearer test-only-cron-secret" },
      }),
      dependencies(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("fails closed with 503 when the deployment cannot resolve its runtime configuration", async () => {
    const response = await handleEffectiveRuntimeConfigRequest(
      new Request("https://acceptance.example", {
        headers: { authorization: "Bearer test-only-cron-secret" },
      }),
      dependencies({ environment: { NODE_ENV: "production" } }),
    );
    expect(response.status).toBe(503);
  });
});

describe("effective runtime configuration over controlled HTTP", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const handlerResponse = await handleEffectiveRuntimeConfigRequest(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers: request.headers as Record<string, string>,
        }),
        {
          environment: deployedEnvironment,
          operatorSecret: "test-only-cron-secret",
          getSession: async () => null,
          assertOperator: async () => {},
          now,
        },
      );
      response.writeHead(handlerResponse.status, {
        "content-type": handlerResponse.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await handlerResponse.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("serves the snapshot to the bearer and rejects the anonymous caller", async () => {
    const authorized = await fetch(
      `${baseUrl}/api/internal/inspection/effective-runtime-config`,
      { headers: { authorization: "Bearer test-only-cron-secret" } },
    );
    expect(authorized.status).toBe(200);
    const snapshot = parseEffectiveConfigurationSnapshot(await authorized.json());
    expect(snapshot.commit).toBe("a".repeat(40));

    const anonymous = await fetch(
      `${baseUrl}/api/internal/inspection/effective-runtime-config`,
    );
    expect(anonymous.status).toBe(401);
  });
});
