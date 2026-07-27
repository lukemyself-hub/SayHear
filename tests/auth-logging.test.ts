import { afterEach, describe, expect, it, vi } from "vitest";

import { createPostgresPool } from "@sayhear/data";

import { createAuthOptions } from "../apps/web/src/auth";

describe("Auth.js observability boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only an auth error code and drops sensitive metadata", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPostgresPool({
      applicationName: "sayhear-auth-log-test",
      connectionString: "postgresql://localhost/unused",
    });
    const options = createAuthOptions({
      configuration: {
        authSecret: "synthetic-signing-secret",
        backupConfigurationFingerprint: "sha256:expected",
        backupPolicyVersion: "neon-production-v1",
        clock: () => new Date("2026-07-27T16:00:00.000Z"),
        databaseUrl: "postgresql://localhost/unused",
        deployment: "test",
        githubClientId: "synthetic-client-id",
        githubClientSecret: "synthetic-client-secret",
      },
      pool,
    });

    options.logger?.error?.("OAUTH_CALLBACK_ERROR", {
      authorizationCode: "synthetic-oauth-code",
      privateContent: "synthetic private diary content",
      sessionToken: "synthetic-session-token",
    } as unknown as Error);

    expect(errorLog).toHaveBeenCalledWith("[sayhear.auth.error]", {
      code: "OAUTH_CALLBACK_ERROR",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(
      /oauth-code|session-token|private diary|client-secret|signing-secret/,
    );
    await pool.end();
  });
});
