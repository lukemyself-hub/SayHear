import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOwnerFullPurgeService,
  PURGE_SURFACE_REGISTRY,
} from "@sayhear/application";
import {
  PostgresOwnerPurgeRepository,
  PostgresPurgeMarkerRepository,
  purgeMarkerMigrationsDirectory,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import {
  ASK_AT,
  OWNER,
  U_BAG,
  askVia,
  createHistoryPathHarness,
  seedLife,
  terminal,
  type EntranceName,
} from "../support/history-path-harness";

/**
 * Issue #320: Purge covers exactly what the history path reads and writes,
 * clears a real history turn without leaving the person's words or the search
 * clues anywhere, and holds against late work: a request in flight when the
 * Data Epoch moves can neither send, show nor leave a row behind. The
 * restore-from-old-backup replay of the new surface is exercised in
 * g1-purge-restore-drill.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testPurgeMarkerDatabaseUrl = process.env.TEST_PURGE_MARKER_DATABASE_URL;
if (!testDatabaseUrl || !testPurgeMarkerDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL and TEST_PURGE_MARKER_DATABASE_URL are required.");
}

const harness = createHistoryPathHarness(testDatabaseUrl);
let markerDatabase: IsolatedPostgresSchema;

beforeEach(async () => {
  await harness.setup();
  markerDatabase = await createIsolatedPostgresSchema(testPurgeMarkerDatabaseUrl);
  await runMigrations(markerDatabase.pool, {
    migrationsDirectory: purgeMarkerMigrationsDirectory,
  });
}, 60_000);

afterEach(async () => {
  await harness.teardown();
  await markerDatabase?.dispose();
}, 30_000);

/** Full Purge exactly as the operator route runs it. */
async function fullPurge(): Promise<void> {
  const repository = new PostgresOwnerPurgeRepository(harness.database.pool);
  const service = createOwnerFullPurgeService({
    clock: harness.clock,
    markerRepository: new PostgresPurgeMarkerRepository(markerDatabase.pool),
    providerRetentionDays: 30,
    repository,
  });
  const started = await repository.startOrder({
    confirmation: "PURGE",
    now: harness.clock(),
    policyVersion: "owner-full-purge:v1",
    status: "retention_pending",
    userId: OWNER,
  });
  if (started.outcome !== "started") throw new Error(`purge start: ${started.outcome}`);
  const result = await service.propagate({ ownerPurgeOrderId: started.order.ownerPurgeOrderId });
  expect(result.status).toBe("retention_pending");
}

const TABLE_REFERENCE = /\b(?:from|join|into|update)\s+("?[a-z_][a-z0-9_]*"?)(\s*\()?/gi;
const NOT_TABLES = new Set([
  "select", "set", "only", "lateral", "unnest", "jsonb_array_elements", "generate_series",
  "values", "excluded", "current_timestamp", "of",
]);

/** Records the tables named by every SQL statement the pool runs. */
function recordTables(sink: Set<string>): () => void {
  const pool = harness.database.pool as unknown as {
    connect: (...args: unknown[]) => Promise<{ query: (...args: unknown[]) => unknown }>;
    query: (...args: unknown[]) => unknown;
  };
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  const note = (arguments_: unknown[]) => {
    const first = arguments_[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    if (!text) return;
    const ctes = new Set(
      [...text.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*(?:not\s+materialized\s*)?\(/gi)].map(
        (match) => match[1]!.toLowerCase(),
      ),
    );
    for (const match of text.matchAll(TABLE_REFERENCE)) {
      const name = match[1]!.replaceAll('"', "").toLowerCase();
      if (match[2] || NOT_TABLES.has(name) || ctes.has(name)) continue;
      sink.add(name);
    }
  };
  pool.query = (...arguments_: unknown[]) => {
    note(arguments_);
    return originalQuery(...arguments_);
  };
  pool.connect = async (...arguments_: unknown[]) => {
    // pg itself calls connect(callback) for pool.query; leave that untouched.
    if (typeof arguments_[0] === "function") return originalConnect(...arguments_);
    const client = await originalConnect(...arguments_);
    const originalClientQuery = client.query.bind(client);
    client.query = (...queryArguments: unknown[]) => {
      note(queryArguments);
      return originalClientQuery(...queryArguments);
    };
    return client;
  };
  return () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  };
}

/** Content-free global tables: identities and policy rows with no owner column. */
const GLOBAL_CONTENT_FREE_TABLES = new Set([
  "history_recall_policies",
  "backup_policy_versions",
  "continuous_exchange_inactivity_policies",
  "recent_context_policies",
  "provider_egress_policy_versions",
  "provider_egress_consents",
  "schema_migrations",
  "recent_context_policy",
  "model_role_configurations",
  "model_role_definitions",
  "model_role_rollout_pins",
  "dialogue_state_policies",
  "internal_owner_identities",
  "pg_catalog",
  "information_schema",
]);

describe("the Purge registry equals the surfaces the history path really touches", () => {
  const entrances: EntranceName[] = ["date", "search", "continuation"];
  for (const entrance of entrances) {
    it(`${entrance}: every table it reads or writes is registered for Purge or is a content-free global policy`, async () => {
      await seedLife(harness);
      const touched = new Set<string>();
      const stop = recordTables(touched);
      let events;
      try {
        events = await askVia(harness, entrance);
      } finally {
        stop();
      }
      expect(terminal(events)).toBe("assistant_committed");
      const registered = new Set(PURGE_SURFACE_REGISTRY.map((surface) => surface.surfaceId));
      const unaccounted = [...touched]
        .filter((table) => !registered.has(table) && !GLOBAL_CONTENT_FREE_TABLES.has(table))
        .sort();
      expect(unaccounted).toEqual([]);
      // The new private surface itself, and the Context that carried the
      // clues to the model, are among what was touched and are registered.
      expect(touched.has("history_recall_results")).toBe(true);
      expect(registered.has("history_recall_results")).toBe(true);
      expect(registered.has("compiled_contexts")).toBe(true);
      expect(registered.has("compiled_context_revision_refs")).toBe(true);
    });
  }

  it("every table that gained rows during a history turn and holds an owner column is registered", async () => {
    await seedLife(harness);
    const countAll = async () => {
      const tables = await harness.rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name = 'user_id'`,
      );
      const counts = new Map<string, number>();
      for (const { table_name } of tables) {
        const [row] = await harness.rows<{ count: string }>(`SELECT count(*)::text FROM "${table_name}"`);
        counts.set(table_name, Number(row!.count));
      }
      return counts;
    };
    const before = await countAll();
    await askVia(harness, "search");
    const after = await countAll();
    const registered = new Set(PURGE_SURFACE_REGISTRY.map((surface) => surface.surfaceId));
    const grown = [...after].filter(([table, count]) => count > (before.get(table) ?? 0)).map(([table]) => table);
    expect(grown).toContain("history_recall_results");
    expect(grown.filter((table) => !registered.has(table))).toEqual([]);
  });
});

describe("a real history turn leaves nothing behind after Full Purge", () => {
  it("removes the words, the search clue and every derived row from the whole schema", async () => {
    await seedLife(harness);
    expect(terminal(await askVia(harness, "search"))).toBe("assistant_committed");

    const tables = (
      await harness.rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      )
    ).map((row) => row.table_name);
    const holders = async (needle: string) => {
      const found: string[] = [];
      for (const table of tables) {
        const [row] = await harness.rows<{ count: string }>(
          `SELECT count(*)::text FROM "${table}" AS t WHERE t::text LIKE $1`,
          [`%${needle}%`],
        );
        if (Number(row!.count) > 0) found.push(table);
      }
      return found.sort();
    };
    // The scan is meaningful: before the purge the clue and the words are held.
    expect(await holders("帆布包")).toEqual(
      expect.arrayContaining(["history_recall_results", "conversation_event_revisions"]),
    );

    await fullPurge();

    expect(await holders("帆布包")).toEqual([]);
    expect(await holders(U_BAG)).toEqual([]);
    expect(await harness.rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    expect(await harness.rows("SELECT 1 FROM compiled_contexts")).toHaveLength(0);
    expect(await harness.rows("SELECT 1 FROM compiled_context_revision_refs")).toHaveLength(0);
    // The content-free governance identity is global and is deliberately kept,
    // and nothing in it can bring a purged result back.
    expect(
      (await harness.rows<{ status: string }>("SELECT status FROM history_recall_policies")).map(
        (row) => row.status,
      ),
    ).toEqual(["active"]);
  });
});

describe("work that is late for a Full Purge is refused", () => {
  const stops: ReadonlyArray<readonly [string, "afterRead" | "afterAdmit" | "afterAnswerCompile" | "beforeFirstDelta"]> = [
    ["after the source was read", "afterRead"],
    ["after the result was frozen", "afterAdmit"],
    ["after the answer was compiled", "afterAnswerCompile"],
    ["before the first visible token", "beforeFirstDelta"],
  ];
  for (const [label, hook] of stops) {
    it(`leaves no row, no Assistant Event and no new send when the purge lands ${label}`, async () => {
      await seedLife(harness);
      harness.state.hooks[hook] = () => fullPurge();
      const events = await askVia(harness, "date", { tolerateThrow: true });
      expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
      const answers = harness.state.requests.filter((request) => request.toolsDisabled);
      expect(answers.length).toBeLessThanOrEqual(hook === "beforeFirstDelta" ? 1 : 0);
      for (const table of [
        "history_recall_results",
        "compiled_contexts",
        "compiled_context_revision_refs",
        "generation_commands",
        "model_run_attempts",
      ]) {
        expect(await harness.rows(`SELECT 1 FROM ${table}`)).toHaveLength(0);
      }
      expect(
        await harness.rows(
          "SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1",
          [new Date(ASK_AT)],
        ),
      ).toHaveLength(0);
      // The recovery scan finds nothing to resume.
      const before = harness.state.requests.length;
      await harness.built.service.scanPendingHistoryAnswers?.();
      expect(harness.state.requests.length).toBe(before);
    });
  }

  it("refuses to admit a stale Decision's history proposal after the purge", async () => {
    await seedLife(harness);
    harness.state.hooks.duringDecision = () => fullPurge();
    const events = await askVia(harness, "search", { tolerateThrow: true });
    expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
    expect(await harness.rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    expect(harness.state.requests.filter((request) => request.toolsDisabled)).toHaveLength(0);
    expect(OWNER).toBeDefined();
  });
});
