import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { acquireNextDevServerLock } from "@sayhear/test-support";

/**
 * Starts the real SayHear web app (`next dev`) in its existing `test`
 * composition, pointed at an isolated schema and at the loopback Provider
 * stub. This reuses the exact startup that
 * `tests/system/internal-access.system.test.ts` already relies on; nothing here
 * adds a test-only answer path or a client-settable clock.
 *
 * Controlled time: the app's test composition re-reads one instant from the
 * file named by `SAYHEAR_TEST_NOW_FILE` on every clock call. The runner owns
 * that file, so scenario time advances across turns and days without a client
 * "now" parameter and without restarting the app. Provider/network latency is
 * always measured by the caller with the real monotonic clock.
 */

export const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

export const ACCEPTANCE_CRON_SECRET = "continuity-acceptance-recovery-scanner-secret";
/** Idle time after which production's scan ends a Continuous Exchange. */
export const ACCEPTANCE_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
export const ACCEPTANCE_BACKUP_POLICY_VERSION = "continuity-acceptance-synthetic:v1";
export const ACCEPTANCE_BACKUP_FINGERPRINT = "sha256:continuity-acceptance-synthetic";

export type AppServerInput = Readonly<{
  databaseUrl: string;
  /** File holding the controlled instant; see `writeControlledNow`. */
  clockFile: string;
  markerDatabaseUrl: string;
  /**
   * End-to-end chat request budget for this run. Omitted keeps the product
   * default (30 s); the deterministic mode shortens it so a stalled Provider
   * can be shown to stop without a 30 second wait (#319).
   */
  requestBudgetMs?: number;
  provider:
    | Readonly<{
        apiKey: string;
        baseUrl: string;
        kind?: "responses-stub";
        model: string;
        timeoutMs: number;
      }>
    /**
     * T08 #321: the production OpenCode Go adapter with its fixed endpoint.
     * `gateUrl` is the run's loopback gate; the egress tap loaded into the app
     * shows it every request before it leaves (see `egress-tap.mjs`).
     */
    | Readonly<{
        apiKey: string;
        gateUrl: string;
        kind: "opencode-go";
        timeoutMs: number;
      }>;
}>;

/** The egress tap, loaded into the app process with `node --import`. */
export const egressTapPath = path.join(import.meta.dirname, "egress-tap.mjs");

export type RunningAppServer = Readonly<{
  origin: string;
  output(): string;
  stop(): Promise<void>;
}>;

/**
 * The spawn environment is built from an allowlist instead of inheriting
 * `process.env`: a developer shell (or a symlinked `apps/web/.env`) may carry
 * real Provider credentials or a production model override, and none of that
 * may reach an acceptance run. Variables that Next would otherwise read from
 * `.env` are pinned explicitly here, because Next never overrides a variable
 * that is already set.
 */
export function buildAppEnvironment(
  input: AppServerInput,
  origin: string,
): Record<string, string> {
  const passthrough: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"]) {
    const value = process.env[name];
    if (value !== undefined) passthrough[name] = value;
  }
  const provider =
    input.provider.kind === "opencode-go"
      ? {
          DEEPSEEK_API_KEY: "",
          NODE_OPTIONS: `--import=${pathToFileURL(egressTapPath).href}`,
          OPENCODE_GO_API_KEY: input.provider.apiKey,
          SAYHEAR_ACCEPTANCE_EGRESS_GATE: input.provider.gateUrl,
          SAYHEAR_CONVERSATION_TEXT_MODEL: "deepseek-v4.1-flash",
          SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: "deepseek-v4.1-flash",
          SAYHEAR_PROVIDER_ADAPTER: "opencode-go",
        }
      : {
          DEEPSEEK_API_KEY: input.provider.apiKey,
          // Pinned empty so a local .env cannot supply a second live Provider.
          OPENCODE_GO_API_KEY: "",
          SAYHEAR_CONVERSATION_TEXT_MODEL: input.provider.model,
          SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: input.provider.model,
          SAYHEAR_DEEPSEEK_BASE_URL: input.provider.baseUrl,
          SAYHEAR_PROVIDER_ADAPTER: "deepseek",
        };
  return {
    ...passthrough,
    ...provider,
    CRON_SECRET: ACCEPTANCE_CRON_SECRET,
    DATABASE_URL: input.databaseUrl,
    GITHUB_CLIENT_ID: "continuity-acceptance-client",
    GITHUB_CLIENT_SECRET: "continuity-acceptance-client-secret",
    NEXTAUTH_SECRET: "continuity-acceptance-server-only-secret",
    NEXTAUTH_URL: origin,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
    // Pinned empty so a local .env cannot supply a second live Provider.
    OPENAI_API_KEY: "",
    PURGE_MARKER_DATABASE_URL: input.markerDatabaseUrl,
    SAYHEAR_AUTH_SECRET_SOURCE: "managed",
    SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: ACCEPTANCE_BACKUP_FINGERPRINT,
    SAYHEAR_BACKUP_POLICY_VERSION: ACCEPTANCE_BACKUP_POLICY_VERSION,
    SAYHEAR_CONTEXT_HMAC_SECRET: "continuity-acceptance-context-integrity-secret",
    ...(input.requestBudgetMs === undefined
      ? {}
      : { SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS: String(input.requestBudgetMs) }),
    SAYHEAR_DEPLOYMENT: "test",
    SAYHEAR_EPISODE_BUILD_ENABLED: "false",
    // Background derivation (Evidence, fast-path Claims, consolidation,
    // Journal publish) is off: its model roles have no deterministic stand-in
    // here, and a stub must not write derived memory. Conversation, Context
    // compilation, recent context and memory *retrieval* run unchanged.
    SAYHEAR_EVIDENCE_EXTRACTION_ENABLED: "false",
    SAYHEAR_FAST_PATH_EXTRACTION_ENABLED: "false",
    // Issue 314: the controlled read-only history review is what the history
    // cases exercise; it is default-off in every other deployment.
    SAYHEAR_HISTORY_RECALL_ENABLED: "true",
    SAYHEAR_INACTIVITY_TIMEOUT_MS: String(ACCEPTANCE_INACTIVITY_TIMEOUT_MS),
    SAYHEAR_JOURNAL_PUBLISH_ENABLED: "false",
    SAYHEAR_MEMORY_CONSOLIDATION_ENABLED: "false",
    SAYHEAR_PROVIDER_TIMEOUT_MS: String(input.provider.timeoutMs),
    SAYHEAR_REFLECTION_ENABLED: "false",
    SAYHEAR_TEST_NOW_FILE: input.clockFile,
    SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: "",
  };
}

/** Atomically replace the controlled instant the running app reads. */
export function writeControlledNow(clockFile: string, now: Date): void {
  if (Number.isNaN(now.getTime())) {
    throw new Error("Controlled time must be a valid instant.");
  }
  const temporary = `${clockFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${now.toISOString()}\n`, { mode: 0o600 });
  renameSync(temporary, clockFile);
}

export async function startAppServer(
  input: AppServerInput,
): Promise<RunningAppServer> {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const webDirectory = path.join(repositoryRoot, "apps/web");
  const nextBinary = path.join(webDirectory, "node_modules/next/dist/bin/next");
  // Next allows one `next dev` per project directory. Suites and CLI runs that
  // start the real app wait for each other here instead of colliding.
  const releaseDevServerLock = await acquireNextDevServerLock(webDirectory);
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBinary, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: webDirectory,
      env: buildAppEnvironment(input, origin) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) {
      releaseDevServerLock();
      throw new Error(`SayHear app exited before becoming ready.\n${output}`);
    }
    try {
      const response = await fetch(`${origin}/api/internal/access`);
      await response.body?.cancel();
      if (response.status === 401) {
        return {
          origin,
          output: () => output,
          async stop() {
            await stopChild(child);
            // Debug aid: keep the app process output (content-free server logs).
            if (process.env["SAYHEAR_ACCEPTANCE_APP_LOG"]) {
              appendFileSync(process.env["SAYHEAR_ACCEPTANCE_APP_LOG"], output);
            }
            releaseDevServerLock();
          },
        };
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopChild(child);
  releaseDevServerLock();
  throw new Error(`SayHear app did not become ready.\n${output}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const forceStop = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
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
    throw new Error("Could not reserve a local port for the SayHear app.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
