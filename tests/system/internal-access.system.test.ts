import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createInternalAccessHandler } from "../../apps/web/src/internal-access-handler";
import {
  asUserId,
  createInternalOwnerAccessService,
} from "@sayhear/application";
import {
  createPostgresAuthAdapter,
  PostgresInternalOwnerAccessRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

describe("Authenticated Internal Text Conversation System Seam", () => {
  const sessionCookieName = "sayhear.session-token";
  const sessionToken = "request-path-session-token";
  let database: IsolatedPostgresSchema;
  let nextServer: RunningNextServer | undefined;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    nextServer = await startNextTestServer(database.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query("DELETE FROM auth_sessions");
    await database.pool.query("DELETE FROM backup_policy_versions");
    await createPostgresAuthAdapter(database.pool).createSession({
      expires: new Date("2099-01-01T00:00:00.000Z"),
      sessionToken,
      userId: fixedInternalOwnerPrincipal.userId,
    });
  });

  afterAll(async () => {
    await nextServer?.stop();
    await database.dispose();
  }, 10_000);

  it("keeps private writes blocked when backup evidence is absent", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(new Request("http://localhost/internal/access"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      privateWrites: {
        allowed: false,
        reason: "backup_evidence_missing",
      },
    });
  });

  it("opens private writes for the current verified backup policy", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(new Request("http://localhost/internal/access"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      privateWrites: {
        allowed: true,
        reason: "backup_evidence_current",
      },
    });
  });

  it("rejects an unconfigured GitHub identity without provisioning a user", async () => {
    const adapter = createPostgresAuthAdapter(database.pool);

    expect(
      await adapter.getUserByAccount({
        provider: "github",
        providerAccountId: "not-the-owner",
      }),
    ).toBeNull();
    await expect(
      adapter.createUser({
        email: "stranger@example.invalid",
        emailVerified: null,
        image: null,
        name: "Stranger",
      }),
    ).rejects.toThrow("pre-provisioned");

    const users = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_users",
    );
    expect(users.rows[0]?.count).toBe("1");
  });

  it("rejects client-supplied owner identifiers at the BFF boundary", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(
      new Request(
        "http://localhost/internal/access?user_id=01984477-59a9-7d20-9d97-e588769566a0",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "client_owner_identifier_not_allowed",
    });
  });

  it("derives the owner through the real Next/Auth.js/PostgreSQL request path", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const unauthorized = await fetch(`${nextServer.origin}/api/internal/access`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${nextServer.origin}/api/internal/access`, {
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}`,
      },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      privateWrites: {
        allowed: false,
        reason: "backup_evidence_missing",
      },
    });
  });

  it("keeps the pre-provisioned owner identity immutable", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);

    await expect(
      repository.provisionInternalOwner({
        issuer: "https://github.com",
        subject: "test-owner",
        userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
      }),
    ).rejects.toThrow("already provisioned");

    const users = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_users",
    );
    expect(users.rows[0]?.count).toBe("1");
  });

  it("creates and revokes a PostgreSQL-backed Auth.js session without storing the raw token", async () => {
    const adapter = createPostgresAuthAdapter(database.pool, {
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
    });
    const expires = new Date("2026-07-28T16:00:00.000Z");

    await adapter.createSession({
      expires,
      sessionToken: "synthetic-session-token",
      userId: fixedInternalOwnerPrincipal.userId,
    });

    const { getSessionAndUser } = adapter;
    expect(await getSessionAndUser("synthetic-session-token")).toEqual({
      session: {
        expires,
        sessionToken: "synthetic-session-token",
        userId: fixedInternalOwnerPrincipal.userId,
      },
      user: {
        email: null,
        emailVerified: null,
        id: fixedInternalOwnerPrincipal.userId,
        image: null,
        name: "Internal Owner",
      },
    });
    const storedToken = await database.pool.query<{ stores_raw: boolean }>(
      `
        SELECT session_token_hash = convert_to($1, 'UTF8') AS stores_raw
        FROM auth_sessions
        LIMIT 1
      `,
      ["synthetic-session-token"],
    );
    expect(storedToken.rows[0]?.stores_raw).toBe(false);

    const expiredAdapter = createPostgresAuthAdapter(database.pool, {
      clock: () => new Date("2026-07-29T16:00:00.000Z"),
    });
    expect(
      await expiredAdapter.getSessionAndUser("synthetic-session-token"),
    ).toBeNull();

    await adapter.deleteSession("synthetic-session-token");
    expect(await getSessionAndUser("synthetic-session-token")).toBeNull();
  });
});

type RunningNextServer = Readonly<{
  origin: string;
  stop(): Promise<void>;
}>;

async function startNextTestServer(
  databaseUrl: string,
): Promise<RunningNextServer> {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const webDirectory = fileURLToPath(
    new URL("../../apps/web/", import.meta.url),
  );
  const nextBinary = fileURLToPath(
    new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url),
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBinary, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: webDirectory,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        GITHUB_CLIENT_ID: "system-test-client",
        GITHUB_CLIENT_SECRET: "system-test-client-secret",
        NEXTAUTH_SECRET: "system-test-server-only-secret",
        NEXTAUTH_URL: origin,
        NODE_ENV: "development",
        SAYHEAR_AUTH_SECRET_SOURCE: "managed",
        SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "sha256:expected",
        SAYHEAR_BACKUP_POLICY_VERSION: "neon-production-v1",
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = captureOutput(child);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next test server exited early.\n${output.read()}`);
    }
    try {
      const response = await fetch(`${origin}/api/internal/access`);
      if (response.status === 401) {
        return {
          origin,
          async stop() {
            await stopChild(child);
          },
        };
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await stopChild(child);
  throw new Error(`Next test server did not become ready.\n${output.read()}`);
}

function captureOutput(child: ChildProcess): { read(): string } {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return {
    read: () => output,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const forceStop = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(forceStop);
      resolve();
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local port for the Next test server.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
