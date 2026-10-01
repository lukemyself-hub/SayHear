import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { assertWorkflowHistoryCanaryClean, type WorkflowCanaryArtifacts, type WorkflowCanaryValues } from "@sayhear/application";
import { createPostgresPool } from "@sayhear/data";
const execFileAsync = promisify(execFile);
type RecordValue = Record<string, unknown>;

/** Native exports need an execution link, not merely the right deployment. */
export function assertCanaryExportCorrelation(artifacts: WorkflowCanaryArtifacts, runIds: readonly string[]): void {
  const databaseIds = new Set<string>();
  const collectIds = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectIds);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:Id|_id)$/.test(key) && typeof nested === "string" && /^[0-9a-f-]{36}$/i.test(nested)) databaseIds.add(nested);else collectIds(nested);
    }
  };
  [...artifacts.outboxPayloads, ...artifacts.receipts].forEach(collectIds);
  // Owner IDs cannot establish that an export belongs to this execution.
  for (const record of [...artifacts.outboxPayloads, ...artifacts.receipts]) {
    if (record && typeof record === "object") {
      for (const key of ["user_id", "userId", "owner_id", "ownerId"]) {
        const value = (record as RecordValue)[key];
        if (typeof value === "string") databaseIds.delete(value);
      }
    }
  }
  if (!databaseIds.size) throw new Error("Canary database exports have no execution identifiers.");
  const workflowIds = new Set<string>();
  for (const record of artifacts.workflowHistory) {
    const run = record as RecordValue;
    if (typeof run.runId !== "string" || !runIds.includes(run.runId) || workflowIds.has(run.runId) || ![...databaseIds].some(id => JSON.stringify(run).includes(id))) {
      throw new Error("Canary Workflow cannot be correlated with its database execution.");
    }
    workflowIds.add(run.runId);
  }
  if (workflowIds.size !== runIds.length) throw new Error("Canary Workflow export is incomplete.");
  const identifiers = [...databaseIds, ...runIds];
  for (const source of ["logs", "traces", "errors"] as const) {
    if (!artifacts[source].length || artifacts[source].some(record => !identifiers.some(id => JSON.stringify(record).includes(id)))) {
      throw new Error(`Canary ${source} contains an uncorrelated diagnostic export.`);
    }
  }
}

/** Drain every platform page; never treat the first page as a complete export. */
export async function collectWorkflowPages(fetchPage: (cursor?: string) => Promise<unknown>): Promise<readonly unknown[]> {
  const records: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await fetchPage(cursor)) as RecordValue;
    if (!page || !Array.isArray(page.data) || typeof page.hasMore !== "boolean") throw new Error("Invalid Workflow export page.");
    records.push(...page.data);
    if (!page.hasMore) return records;
    if (typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor)) throw new Error("Incomplete or repeated Workflow export cursor.");
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (seen.size < 1000);
  throw new Error("Workflow export exceeds the bounded page limit.");
}
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--run-root", "--deployment-id", "--project", "--team", "--environment", "--run-ids", "--outbox-ids", "--receipt-ids", "--logs", "--traces", "--errors", "--values"]);
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
  const inspect = async (resource: string, id: string, cursor?: string) => {
    const flags = ["inspect", resource];
    if (resource === "run") flags.push(id);else flags.push("--runId", id);
    flags.push("--backend", "vercel", "--env", environment, "--project", required("--project"), "--team", required("--team"), "--json", "--withData", "--decrypt");
    if (cursor) flags.push("--cursor", cursor);
    const {
      stdout
    } = await execFileAsync(resolve(root, "apps/web/node_modules/.bin/workflow"), flags, {
      cwd: root,
      maxBuffer: 20_000_000,
      timeout: 60_000
    });
    return JSON.parse(stdout);
  };
  const workflowHistory: unknown[] = [];
  for (const runId of runIds) {
    const run = (await inspect("run", runId)) as RecordValue;
    if (run.runId !== runId || run.deploymentId !== deploymentId) throw new Error("Canary Workflow run does not match its deployment.");
    const steps = await collectWorkflowPages(cursor => inspect("steps", runId, cursor));
    const events = await collectWorkflowPages(cursor => inspect("events", runId, cursor));
    workflowHistory.push({
      ...run,
      steps,
      events
    });
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
    workflowHistory,
    outboxPayloads,
    receipts,
    logs: await load("--logs"),
    traces: await load("--traces"),
    errors: await load("--errors")
  };
  const values = JSON.parse(await readFile(resolve(root, required("--values")), "utf8")) as WorkflowCanaryValues;
  assertCanaryExportCorrelation(artifacts, runIds);
  assertWorkflowHistoryCanaryClean(artifacts, values);
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
