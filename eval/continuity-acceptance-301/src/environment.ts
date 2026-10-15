import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PostgresInternalOwnerAccessRepository,
  createPostgresAuthAdapter,
  createUuidV7,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import {
  ACCEPTANCE_CRON_SECRET,
  ACCEPTANCE_BACKUP_FINGERPRINT,
  ACCEPTANCE_BACKUP_POLICY_VERSION,
  repositoryRoot,
  startAppServer,
  writeControlledNow,
  type RunningAppServer,
} from "./app-server";
import { SESSION_COOKIE_NAME, createAcceptanceClient, type AcceptanceClient } from "./client";
import {
  SEED_CAPABILITY,
  SYNTHETIC_ISSUER,
  assertSyntheticOwner,
  syntheticSubject,
  type IsolationTarget,
  type RunOwnership,
} from "./isolation";
import {
  REAL_MODEL_IDENTITY,
  startProviderGate,
  type ProviderGate,
} from "./provider-gate";
import {
  DETERMINISTIC_STUB_MODEL,
  startProviderStub,
  type ProviderStub,
} from "./provider-stub";

/**
 * One isolated SayHear for one run (T00 #313): a schema this run created in
 * the business database, a schema in the separate purge-marker database, the
 * synthetic owner, the loopback Provider stub and the real web app in its test
 * composition. Reuses `createIsolatedPostgresSchema`, `runMigrations` and the
 * owner/backup/session provisioning the system suites already rely on.
 */

/**
 * Request budget of the app under test in deterministic runs (#319). The
 * product's own value is 30 seconds; the stub can stall on purpose, so the
 * suite shortens it to show the deadline working in seconds, not half a minute.
 * A real-model run must NOT use this: it keeps the product's 30 second budget.
 */
export const DETERMINISTIC_REQUEST_BUDGET_MS = 6_000;

export type AcceptanceEnvironment = Readonly<{
  client: AcceptanceClient;
  /**
   * Where the running app listens and the session cookie that signs in as the
   * synthetic owner. For looking at the real Portal in a browser by hand
   * (UI verification); acceptance cases never use it.
   */
  connection(): Readonly<{ origin: string; sessionCookie: string; sessionToken: string }>;
  /** Enable the seven-day recent context through the real operator route. */
  enableRecentContext(): Promise<string>;
  /** Enable the history-recall governance through the real operator route (#320). */
  enableHistoryRecall(): Promise<string>;
  /** Checks run identity, owner identity and seed capability, or throws. */
  assertOwned(): Promise<void>;
  dispose(): Promise<void>;
  /**
   * The run's side of the egress tap when the app uses its production
   * OpenCode Go adapter (T08 #321); null when the Provider is the stub.
   */
  gate: ProviderGate | null;
  /** Whether requests after seeding go to the real, paid Provider. */
  live: boolean;
  /** Clears the legacy request timezone of one command (see `HistoryTurn`). */
  clearRequestTimezone(generationCommandId: string): Promise<void>;
  model: string;
  /** Drop this run's schemas and start again from an empty, stamped baseline. */
  reset(): Promise<void>;
  /**
   * Fixture state: an active Forget request whose exclusions name the Evidence
   * of these user revisions (see `ForgetStep`). Owned-schema only.
   */
  seedForget(revisionIds: readonly string[], at: Date): Promise<void>;
  /** Restart the app process: a reconnect / recovery boundary. */
  restartApp(): Promise<void>;
  /**
   * Runs the same scheduled recovery scan production's Cron runs, at the
   * current controlled time. This is how idle time passes for the product:
   * it ends Continuous Exchanges that went quiet, which is what lets the next
   * message open a new-date Daily Session.
   */
  runScheduledScan(): Promise<Readonly<Record<string, unknown>>>;
  runId: string;
  /**
   * Connection string of the schema this run created. For the harness's own
   * self-tests only: acceptance cases observe the product through HTTP and
   * must never read or write it.
   */
  schemaConnectionString(): string;
  setNow(now: Date): void;
  stub: ProviderStub;
}>;

const SESSION_EXPIRY = new Date("2099-01-01T00:00:00.000Z");

async function readOwnership(
  database: IsolatedPostgresSchema,
): Promise<RunOwnership | null> {
  const stamped = await database.pool.query<{ exists: boolean }>(
    "SELECT to_regclass('acceptance_run_identity') IS NOT NULL AS exists",
  );
  if (!stamped.rows[0]?.exists) return null;
  const identity = await database.pool.query<{
    run_id: string;
    seed_capability: string | null;
  }>("SELECT run_id, seed_capability FROM acceptance_run_identity");
  const owner = await database.pool.query<{ issuer: string; subject: string }>(
    "SELECT issuer, subject FROM internal_owner_identities",
  );
  const users = await database.pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM app_users",
  );
  if (identity.rows.length !== 1 || owner.rows.length !== 1) return null;
  return {
    issuer: owner.rows[0]!.issuer,
    ownerCount: Number(users.rows[0]?.count ?? "0"),
    runId: identity.rows[0]!.run_id,
    seedCapability: identity.rows[0]!.seed_capability,
    subject: owner.rows[0]!.subject,
  };
}

export async function createAcceptanceEnvironment(input: {
  initialNow: Date;
  /**
   * Omitted: the loopback Responses API stub. `opencode-go`: the app's
   * production adapter behind the egress tap; with `live` false every request
   * is answered locally (a rehearsal that pays for nothing), with `live` true
   * requests after seeding reach the real Provider with this credential.
   */
  provider?: Readonly<{ apiKey: string; kind: "opencode-go"; live: boolean }>;
  /** False runs the app with the history review branch closed (diagnostic). */
  historyRecallEnabled?: boolean;
  /** Overrides the deterministic request budget (latency measurements, #319). */
  requestBudgetMs?: number;
  target: IsolationTarget;
}): Promise<AcceptanceEnvironment> {
  const runId = `run-${randomUUID()}`;
  const sessionToken = `continuity-acceptance-session-${randomUUID()}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "sayhear-acceptance-"));
  const clockFile = path.join(scratch, "now");
  writeControlledNow(clockFile, input.initialNow);
  const realProvider = input.provider ?? null;
  const gate = realProvider ? await startProviderGate() : null;
  const stub: ProviderStub = gate ?? (await startProviderStub());

  let database: IsolatedPostgresSchema | null = null;
  let markerDatabase: IsolatedPostgresSchema | null = null;
  let app: RunningAppServer | null = null;

  async function provision(): Promise<void> {
    database = await createIsolatedPostgresSchema(input.target.databaseUrl);
    markerDatabase = await createIsolatedPostgresSchema(input.target.markerDatabaseUrl);
    await runMigrations(database.pool);
    await runMigrations(markerDatabase.pool, {
      migrationsDirectory: path.join(repositoryRoot, "packages/data/migrations-purge-marker"),
    });
    // The run stamps the schema it created. Seeding and reset re-read this
    // stamp, so they cannot be pointed at a schema this run does not own.
    await database.pool.query(
      `CREATE TABLE acceptance_run_identity (
         run_id TEXT PRIMARY KEY,
         seed_capability TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    await database.pool.query(
      "INSERT INTO acceptance_run_identity (run_id, seed_capability) VALUES ($1, $2)",
      [runId, SEED_CAPABILITY],
    );
    const access = new PostgresInternalOwnerAccessRepository(database.pool);
    await access.provisionInternalOwner({
      issuer: SYNTHETIC_ISSUER,
      subject: syntheticSubject(runId),
      userId: fixedInternalOwnerPrincipal.userId,
    });
    await access.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: ACCEPTANCE_BACKUP_FINGERPRINT,
      databaseRetentionDays: 30,
      evidenceReference: "synthetic continuity acceptance environment (#313)",
      pitrRetentionDays: 7,
      policyVersion: ACCEPTANCE_BACKUP_POLICY_VERSION,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      verifiedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await createPostgresAuthAdapter(database.pool).createSession({
      expires: SESSION_EXPIRY,
      sessionToken,
      userId: fixedInternalOwnerPrincipal.userId,
    });
  }

  async function startApp(): Promise<void> {
    if (!database || !markerDatabase) throw new Error("Environment is not provisioned.");
    app = await startAppServer({
      clockFile,
      // The deterministic stub can stall on purpose; a short budget shows the
      // request deadline working without a 30 second wait. Real-model runs keep
      // the product's own 30 seconds (#319).
      ...(realProvider
        ? input.requestBudgetMs === undefined
          ? {}
          : { requestBudgetMs: input.requestBudgetMs }
        : { requestBudgetMs: input.requestBudgetMs ?? DETERMINISTIC_REQUEST_BUDGET_MS }),
      databaseUrl: database.connectionString,
      ...(input.historyRecallEnabled === false ? { historyRecallEnabled: false } : {}),
      markerDatabaseUrl: markerDatabase.connectionString,
      provider: realProvider
        ? {
            apiKey: realProvider.apiKey,
            gateUrl: stub.baseUrl,
            kind: "opencode-go",
            // The product's documented default (.env.example); the chat path
            // keeps its own 30 second request budget and Provider timeout.
            timeoutMs: 60_000,
          }
        : {
            apiKey: "continuity-acceptance-stub-credential",
            baseUrl: stub.baseUrl,
            model: DETERMINISTIC_STUB_MODEL,
            timeoutMs: 20_000,
          },
    });
  }

  async function dropSchemas(): Promise<void> {
    await app?.stop();
    app = null;
    await database?.dispose();
    database = null;
    await markerDatabase?.dispose();
    markerDatabase = null;
  }

  async function assertOwned(): Promise<void> {
    if (!database) throw new Error("Environment is not provisioned.");
    assertSyntheticOwner(await readOwnership(database), runId);
  }

  try {
    await provision();
    await startApp();
  } catch (error) {
    await dropSchemas().catch(() => {});
    await stub.stop();
    rmSync(scratch, { force: true, recursive: true });
    throw error;
  }

  // The client follows the app across restarts: the origin changes, the
  // session and the data do not.
  const client: AcceptanceClient = {
    chat: (submission) => current().chat(submission),
    correct: (correction) => current().correct(correction),
    dates: () => current().dates(),
    inspect: (id) => current().inspect(id),
    messages: (id) => current().messages(id),
  };
  function current(): AcceptanceClient {
    if (!app) throw new Error("The SayHear app is not running.");
    return createAcceptanceClient({ origin: app.origin, sessionToken });
  }

  return {
    assertOwned,
    async clearRequestTimezone(generationCommandId) {
      await assertOwned();
      const result = await database!.pool.query(
        "UPDATE generation_commands SET request_timezone = NULL WHERE generation_command_id = $1",
        [generationCommandId],
      );
      if (result.rowCount !== 1) {
        throw new Error("Could not mark the seeded turn as a legacy row without a request timezone.");
      }
    },
    client,
    async dispose() {
      await dropSchemas();
      await stub.stop();
      rmSync(scratch, { force: true, recursive: true });
    },
    async enableHistoryRecall() {
      if (!app) throw new Error("The SayHear app is not running.");
      if (input.historyRecallEnabled === false) return "closed";
      const response = await fetch(`${app.origin}/api/internal/operator/history-recall`, {
        body: JSON.stringify({ action: "enable" }),
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (response.status === 409 && body.error === "already_enabled") return "active";
      if (!response.ok) {
        throw new Error(`Enabling history recall failed with HTTP ${response.status}.`);
      }
      return "active";
    },
    async enableRecentContext() {
      if (!app) throw new Error("The SayHear app is not running.");
      const response = await fetch(`${app.origin}/api/internal/operator/recent-context`, {
        body: JSON.stringify({ action: "enable" }),
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string; outcome?: string };
      if (response.status === 409 && body.error === "already_enabled") return "active";
      if (!response.ok) {
        throw new Error(`Enabling recent context failed with HTTP ${response.status}.`);
      }
      return "active";
    },
    connection() {
      if (!app) throw new Error("The SayHear app is not running.");
      return { origin: app.origin, sessionCookie: SESSION_COOKIE_NAME, sessionToken };
    },
    gate,
    live: realProvider?.live === true,
    model: realProvider ? REAL_MODEL_IDENTITY : DETERMINISTIC_STUB_MODEL,
    async runScheduledScan() {
      if (!app) throw new Error("The SayHear app is not running.");
      const response = await fetch(`${app.origin}/api/internal/recovery/scan`, {
        headers: { authorization: `Bearer ${ACCEPTANCE_CRON_SECRET}` },
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          `The scheduled recovery scan failed with HTTP ${response.status} (${String(body["diagnosticCode"] ?? "unknown")}).`,
        );
      }
      return body;
    },
    async reset() {
      // Ownership is proven before anything is dropped, and only the schemas
      // this run created are dropped.
      await assertOwned();
      await dropSchemas();
      await provision();
      await startApp();
    },
    async seedForget(revisionIds, at) {
      await assertOwned();
      const pool = database!.pool;
      const owner = fixedInternalOwnerPrincipal.userId;
      const forgetRequestId = createUuidV7(at);
      for (const [index, revisionId] of revisionIds.entries()) {
        const found = await pool.query<{
          conversation_event_id: string;
          daily_session_id: string;
          sequence_no: string;
        }>(
          `SELECT revision.conversation_event_id::text, event.daily_session_id::text,
                  event.sequence_no::text
           FROM conversation_event_revisions revision
           INNER JOIN conversation_events event
             ON event.conversation_event_id = revision.conversation_event_id
           WHERE revision.conversation_event_revision_id = $1`,
          [revisionId],
        );
        const row = found.rows[0];
        if (!row) throw new Error("A forgotten revision was not found in the run's schema.");
        const snapshotId = createUuidV7(at);
        const itemId = createUuidV7(at);
        await pool.query(
          `INSERT INTO evidence_source_snapshots (
             evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
             extraction_policy_version, command_id, attempt_id, champion_config_version,
             champion_provider, champion_model, champion_snapshot,
             champion_provider_policy_version, created_at
           ) VALUES ($1, $2, $3, $4, 'evidence-extraction:v2', 'acceptance-seed', 'acceptance-seed', 'test', 'openai', 'test', 'test', 'test', $5)`,
          [snapshotId, owner, row.daily_session_id, row.sequence_no, at],
        );
        await pool.query(
          `INSERT INTO evidence_items (
             evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
             source_revision_id, source_actor, source_status, locator_type,
             locator_key, extraction_policy_version, evidence_role, created_at
           ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', $6, 'evidence-extraction:v2', 'factual_support', $7)`,
          [itemId, owner, snapshotId, row.conversation_event_id, revisionId, `revision:${revisionId}`, at],
        );
        if (index === 0) {
          await pool.query(
            `INSERT INTO memory_forget_requests (
               memory_forget_request_id, user_id, request_event_revision_id,
               target_claim_id, target_scope, canonical_side, qualifier_key,
               qualifier_typed_value, status, applied_claim_version_id,
               forget_policy_version, created_at
             ) VALUES ($1, $2, $3, NULL, 'whole_claim', NULL, NULL, NULL, 'pending_scope', NULL, 'memory-forget:v1', $4)`,
            [forgetRequestId, owner, revisionId, at],
          );
        }
        await pool.query(
          `INSERT INTO memory_forget_evidence_exclusions (
             memory_forget_evidence_exclusion_id, user_id, memory_forget_request_id,
             evidence_item_id, exclusion_scope, canonical_side, qualifier_key, status, created_at
           ) VALUES ($1, $2, $3, $4, 'whole_claim', NULL, NULL, 'active', $5)`,
          [createUuidV7(at), owner, forgetRequestId, itemId, at],
        );
      }
    },
    async restartApp() {
      await app?.stop();
      app = null;
      await startApp();
    },
    runId,
    schemaConnectionString() {
      if (!database) throw new Error("Environment is not provisioned.");
      return database.connectionString;
    },
    setNow(now) {
      writeControlledNow(clockFile, now);
    },
    stub,
  };
}
