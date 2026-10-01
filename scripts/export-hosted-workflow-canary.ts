import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPostgresPool } from "@sayhear/data";
import {
  assertHostedWorkflowCanaryEvidence,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "./hosted-workflow-canary-gate";

type RecordValue = Record<string, unknown>;

/** Backwards-compatible export; the shared gate owns the correlation rule. */
export {
  assertCanaryExportCorrelation,
  assertHostedWorkflowCanaryEvidence,
  assertPreparedWorkflowPages,
  assertWorkflowHistoryCanaryResolved,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "./hosted-workflow-canary-gate";

type WorkflowPage<T> = Readonly<{
  cursor: string | null;
  data: readonly T[];
  hasMore: boolean;
}>;

type LockedWorkflowWorld = {
  close?: () => Promise<void>;
  events: {
    list: (parameters: RecordValue) => Promise<WorkflowPage<unknown>>;
  };
  getEncryptionKeyForRun?: (run: unknown) => Promise<Uint8Array | undefined>;
  runs: {
    get: (runId: string, parameters?: RecordValue) => Promise<RecordValue>;
  };
  steps: {
    list: (parameters: RecordValue) => Promise<WorkflowPage<unknown>>;
  };
};

type LockedWorkflowTools = Readonly<{
  hydrateResourceIO: (
    resource: unknown,
    keyResolver: ((runId: string) => Promise<Uint8Array | undefined>) | null,
  ) => Promise<unknown>;
  setupCliWorld: (
    flags: Readonly<{
      authToken: string;
      backend: string;
      env: string;
      json: boolean;
      project: string;
      team: string;
      verbose: boolean;
    }>,
    version: string,
  ) => Promise<LockedWorkflowWorld | null>;
}>;

const MAX_WORKFLOW_PAGE_LIMIT = 100;

/**
 * Drain every platform page; never treat the first page as a complete export.
 * The locked Workflow SDK's list methods return a `{ data, cursor, hasMore }`
 * envelope; the CLI's `inspect steps/events --json` drops that envelope and
 * prints a bare array, so the array can never be read as "complete with no
 * next page" (see tests/hosted-canary-export.test.ts).
 */
export async function collectWorkflowPages<T>(
  fetchPage: (cursor?: string) => Promise<unknown>,
): Promise<readonly T[]> {
  const records: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await fetchPage(cursor)) as RecordValue;
    if (!page || !Array.isArray(page.data) || typeof page.hasMore !== "boolean") throw new Error("Invalid Workflow export page.");
    records.push(...(page.data as T[]));
    if (!page.hasMore) return records;
    if (typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor)) throw new Error("Incomplete or repeated Workflow export cursor.");
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (seen.size < 1000);
  throw new Error("Workflow export exceeds the bounded page limit.");
}

/**
 * Resolve the locked `workflow` package and its own `@workflow/cli`
 * dependency. No new dependency is introduced: the CLI is already the
 * declared `workflow` package's dependency, and both are resolved from the
 * web app that pins them. Importing the CLI's world setup and hydration means
 * pagination comes from the SDK envelope and decryption uses the exact locked
 * code path the CLI uses, rather than re-implementing either.
 */
export async function loadLockedWorkflowTools(root: string): Promise<LockedWorkflowTools & { cliVersion: string }> {
  const requireFromWeb = createRequire(resolve(root, "apps/web/package.json"));
  const workflowRuntimePath = requireFromWeb.resolve("workflow/runtime");
  const requireFromWorkflow = createRequire(workflowRuntimePath);
  const setupPath = requireFromWorkflow.resolve("@workflow/cli/dist/lib/inspect/setup.js");
  const hydrationPath = requireFromWorkflow.resolve("@workflow/cli/dist/lib/inspect/hydration.js");
  const cliPackagePath = requireFromWorkflow.resolve("@workflow/cli/package.json");
  // The CLI packages are ESM-only, so they must be imported, not required.
  const setup = (await import(pathToFileURL(setupPath).href)) as RecordValue;
  const hydration = (await import(pathToFileURL(hydrationPath).href)) as RecordValue;
  const cliVersion = (JSON.parse(readFileSync(cliPackagePath, "utf8")) as { version?: string }).version;
  if (typeof cliVersion !== "string" || !cliVersion) throw new Error("Locked Workflow CLI package has no version.");
  const setupCliWorld = setup.setupCliWorld;
  const hydrateResourceIO = hydration.hydrateResourceIO;
  if (typeof setupCliWorld !== "function" || typeof hydrateResourceIO !== "function") {
    throw new Error("Locked Workflow tooling does not expose the expected world setup and hydration contract.");
  }
  return {
    cliVersion,
    hydrateResourceIO: hydrateResourceIO as LockedWorkflowTools["hydrateResourceIO"],
    setupCliWorld: setupCliWorld as LockedWorkflowTools["setupCliWorld"],
  };
}

export async function fetchWorkflowRun(
  world: LockedWorkflowWorld,
  hydrateResourceIO: LockedWorkflowTools["hydrateResourceIO"],
  runId: string,
  expectedDeploymentId: string,
): Promise<{ events: readonly unknown[]; run: RecordValue; steps: readonly unknown[] }> {
  const run = await world.runs.get(runId, { resolveData: "all" });
  if (run.runId !== runId || run.deploymentId !== expectedDeploymentId) {
    throw new Error("Canary Workflow run does not match its deployment.");
  }
  const keyCache = new Map<string, Promise<Uint8Array | undefined>>();
  const resolveKey = world.getEncryptionKeyForRun
    ? (keyRunId: string): Promise<Uint8Array | undefined> => {
        let cached = keyCache.get(keyRunId);
        if (!cached) {
          cached = world.runs
            .get(keyRunId)
            .then((keyRun) => world.getEncryptionKeyForRun!(keyRun));
          keyCache.set(keyRunId, cached);
        }
        return cached;
      }
    : null;
  const steps = await collectWorkflowPages<unknown>((cursor) =>
    world.steps.list({
      pagination: { cursor, limit: MAX_WORKFLOW_PAGE_LIMIT, sortOrder: "asc" },
      resolveData: "all",
      runId,
    }),
  );
  const events = await collectWorkflowPages<unknown>((cursor) =>
    world.events.list({
      pagination: { cursor, limit: MAX_WORKFLOW_PAGE_LIMIT, sortOrder: "asc" },
      resolveData: "all",
      runId,
    }),
  );
  const hydratedSteps = await Promise.all(
    steps.map((step) => hydrateResourceIO(step, resolveKey)),
  );
  const hydratedEvents = await Promise.all(
    events.map((event) => hydrateResourceIO(event, resolveKey)),
  );
  const hydratedRun = await hydrateResourceIO(run, resolveKey);
  if (!hydratedRun || typeof hydratedRun !== "object" || Array.isArray(hydratedRun)) {
    throw new Error("Workflow run hydration did not return a complete resource.");
  }
  return { events: hydratedEvents, run: hydratedRun as RecordValue, steps: hydratedSteps };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--run-root", "--deployment-id", "--project", "--team", "--environment", "--auth-token", "--run-ids", "--outbox-ids", "--receipt-ids", "--logs", "--traces", "--errors", "--values"]);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid canary export arguments.");
    options.set(key, value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  const root = resolve(import.meta.dirname, "..");
  const runRoot = resolve(root, required("--run-root"));
  if (!relative(root, runRoot) || relative(root, runRoot).startsWith("..")) throw new Error("Canary output must stay inside the repository.");
  const environment = required("--environment");
  if (environment !== "preview") throw new Error("This exporter is restricted to isolated preview acceptance.");
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const productionUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !productionUrl) throw new Error("TEST_DATABASE_URL and production DATABASE_URL identity are required for isolation verification.");
  const databaseIdentity = (value: string) => {
    const u = new URL(value);
    return `${u.hostname.replace(/-pooler(?=\.)/, "")}:${u.port || "5432"}${u.pathname}`;
  };
  if (databaseIdentity(databaseUrl) === databaseIdentity(productionUrl)) throw new Error("Hosted canary database must be isolated from production.");
  const deploymentId = required("--deployment-id");
  const runIds = required("--run-ids").split(",");
  if (runIds.some(id => !/^wrun_[A-Za-z0-9]+$/.test(id)) || new Set(runIds).size !== runIds.length) throw new Error("Canary run IDs must be unique platform run IDs.");
  const tools = await loadLockedWorkflowTools(root);
  const authToken = options.get("--auth-token") ?? process.env.WORKFLOW_VERCEL_AUTH_TOKEN ?? process.env.VERCEL_TOKEN ?? "";
  // CLI 4.3.6 otherwise infers a project name from .vercel and overwrites
  // even an explicit project ID with the current checkout's linked project.
  // An ID is also a valid name fallback in the locked SDK.
  process.env.WORKFLOW_VERCEL_PROJECT_NAME = required("--project");
  const world = await tools.setupCliWorld(
    {
      authToken,
      backend: "vercel",
      env: environment,
      json: true,
      project: required("--project"),
      team: required("--team"),
      verbose: false,
    },
    tools.cliVersion,
  );
  if (!world) throw new Error("Locked Workflow world setup did not return a Vercel world.");
  if (process.env.WORKFLOW_VERCEL_PROJECT !== required("--project")) {
    await world.close?.();
    throw new Error("Workflow world resolved a different project.");
  }
  const workflowHistory: unknown[] = [];
  const completenessRuns: Record<string, { events: number; eventsComplete: true; steps: number; stepsComplete: true }> = {};
  try {
    for (const runId of runIds) {
      const fetched = await fetchWorkflowRun(world, tools.hydrateResourceIO, runId, deploymentId);
      workflowHistory.push({
        ...fetched.run,
        steps: fetched.steps,
        events: fetched.events
      });
      completenessRuns[runId] = {
        events: fetched.events.length,
        eventsComplete: true,
        steps: fetched.steps.length,
        stepsComplete: true,
      };
    }
  } finally {
    await world.close?.();
  }
  const pool = createPostgresPool({
    applicationName: "sayhear-canary-export",
    connectionString: databaseUrl
  });
  let outboxPayloads: unknown[] = [];
  let receipts: unknown[] = [];
  const ids = (key: string) => {
    const values = required(key).split(",");
    if (values.some(x => !x) || new Set(values).size !== values.length) throw new Error("Canary database IDs must be unique and non-empty.");
    return values;
  };
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const outboxIds = ids("--outbox-ids"),
        receiptIds = ids("--receipt-ids");
      const outbox = await client.query("SELECT * FROM outbox_events WHERE outbox_event_id = ANY($1::uuid[])", [outboxIds]);
      const result = await client.query("SELECT * FROM conversation_action_receipts WHERE action_receipt_id = ANY($1::uuid[])", [receiptIds]);
      if (outbox.rows.length !== outboxIds.length || result.rows.length !== receiptIds.length) throw new Error("Canary export is missing database records.");
      outboxPayloads = outbox.rows;
      receipts = result.rows;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  const load = async (key: string) => {
    const raw: unknown = JSON.parse(await readFile(resolve(root, required(key)), "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("Native diagnostic exports must be non-empty arrays.");
    return raw;
  };
  const artifacts: WorkflowCanaryArtifacts = {
    completeness: {
      runs: completenessRuns,
      version: "1a3b-hosted-canary-completeness:v1",
      workflowRuns: workflowHistory.length,
    },
    workflowHistory,
    outboxPayloads,
    receipts,
    logs: await load("--logs"),
    traces: await load("--traces"),
    errors: await load("--errors")
  };
  const values = JSON.parse(await readFile(resolve(root, required("--values")), "utf8")) as WorkflowCanaryValues;
  // One shared gate: unresolved/expired placeholder data, probes, correlation,
  // page completeness and deployment identity all fail closed before anything
  // is written to the run root.
  assertHostedWorkflowCanaryEvidence(artifacts, values, { deploymentId, runIds });
  const output = resolve(runRoot, "hosted-canary");
  await mkdir(output, {
    recursive: true,
    mode: 0o700
  });
  await writeFile(resolve(output, "artifacts.json"), `${JSON.stringify(artifacts, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await writeFile(resolve(output, "values.env.json"), `${JSON.stringify(values, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  console.log(`[hosted-canary] verified exports from ${runIds.length} platform runs.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Hosted canary export failed; no release evidence was produced.");
    process.exitCode = 1;
  });
}
