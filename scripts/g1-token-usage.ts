import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createPostgresPool } from "@sayhear/data";

/**
 * Read-only, content-free G1 token-usage report (issue #252 follow-up).
 *
 * The report reads only allowlisted counters already persisted on
 * `model_run_attempts` plus the frozen `maxOutputTokens` cap. It never selects
 * request/response text, Evidence, reasoning text, credentials, or the database
 * URL, and it never writes. Unknown is `null` and is counted separately from a
 * reported zero; `outputTokens` already includes reasoning and is never summed
 * with `reasoningTokens`.
 */

const USAGE_FIELDS = [
  "cachedTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

export type G1UsageField = (typeof USAGE_FIELDS)[number];

export type G1UsageCounters = Readonly<Record<G1UsageField, number | null>>;

export type G1UsageRow = Readonly<{
  role: string;
  commandStatus: string;
  attemptStatus: string;
  maxOutputTokens: number | null;
  usage: G1UsageCounters;
}>;

export type G1UsageBucket = {
  attemptCount: number;
  known: Record<G1UsageField, number>;
  unknownCounts: Record<G1UsageField, number>;
  /** Attempts whose output reached at least 80% of the frozen cap. */
  soft80Count: number;
  /** Attempts whose output reached at least 95% of the frozen cap. */
  soft95Count: number;
};

export type G1TokenUsageReport = Readonly<{
  attempts: number;
  total: G1UsageBucket;
  byRole: Record<string, G1UsageBucket>;
  byCommandStatus: Record<string, G1UsageBucket>;
  byAttemptStatus: Record<string, G1UsageBucket>;
}>;

function emptyBucket(): G1UsageBucket {
  return {
    attemptCount: 0,
    known: {
      cachedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    unknownCounts: {
      cachedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    soft80Count: 0,
    soft95Count: 0,
  };
}

function normalizeCount(value: number | null): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function addRow(bucket: G1UsageBucket, row: G1UsageRow): void {
  bucket.attemptCount += 1;
  for (const field of USAGE_FIELDS) {
    const value = normalizeCount(row.usage[field]);
    if (value === null) {
      bucket.unknownCounts[field] += 1;
    } else {
      bucket.known[field] += value;
    }
  }
  const cap = row.maxOutputTokens;
  const output = normalizeCount(row.usage.outputTokens);
  // No division when the cap is absent or non-positive: the flag stays off
  // rather than producing NaN/Infinity.
  if (cap !== null && cap > 0 && output !== null) {
    const ratio = output / cap;
    if (ratio >= 0.8) bucket.soft80Count += 1;
    if (ratio >= 0.95) bucket.soft95Count += 1;
  }
}

function bucketFor(
  buckets: Map<string, G1UsageBucket>,
  key: string,
): G1UsageBucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const created = emptyBucket();
  buckets.set(key, created);
  return created;
}

function toRecord(buckets: Map<string, G1UsageBucket>): Record<string, G1UsageBucket> {
  return Object.fromEntries(
    [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Pure aggregation over allowlisted rows. Failed, discarded, result-unknown,
 * and retry attempts are ordinary rows, so they are included by construction.
 * `reasoningTokens` is aggregated on its own axis and never added into
 * `outputTokens`.
 */
export function summarizeG1TokenUsage(
  rows: readonly G1UsageRow[],
): G1TokenUsageReport {
  const total = emptyBucket();
  const byRole = new Map<string, G1UsageBucket>();
  const byCommandStatus = new Map<string, G1UsageBucket>();
  const byAttemptStatus = new Map<string, G1UsageBucket>();
  for (const row of rows) {
    addRow(total, row);
    addRow(bucketFor(byRole, row.role), row);
    addRow(bucketFor(byCommandStatus, row.commandStatus), row);
    addRow(bucketFor(byAttemptStatus, row.attemptStatus), row);
  }
  return {
    attempts: total.attemptCount,
    total,
    byRole: toRecord(byRole),
    byCommandStatus: toRecord(byCommandStatus),
    byAttemptStatus: toRecord(byAttemptStatus),
  };
}

type CliOptions = Readonly<{
  owner: string;
  roles: readonly string[];
  runPrefix: string | null;
  summaryOnly: boolean;
  json: boolean;
}>;

const ALLOWED_ROLES = new Set([
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
]);

export function parseG1TokenUsageArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let summaryOnly = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--summary") {
      summaryOnly = true;
      continue;
    }
    if (key === "--json") {
      json = true;
      continue;
    }
    if (key !== "--owner" && key !== "--role" && key !== "--run") {
      throw new Error("Unknown G1 token usage argument.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value.`);
    }
    if (key === "--role") {
      if (!ALLOWED_ROLES.has(value)) {
        throw new Error("--role must be one of the four active G1 model roles.");
      }
      values.set(`--role:${value}`, value);
    } else {
      if (values.has(key)) throw new Error(`${key} was supplied more than once.`);
      values.set(key, value);
    }
    index += 1;
  }
  const owner = values.get("--owner");
  if (!owner) {
    throw new Error("--owner is required; there is no implicit production owner.");
  }
  const selectedRoles = [...values.entries()]
    .filter(([key]) => key.startsWith("--role:"))
    .map(([, value]) => value);
  const roles = selectedRoles.length > 0 ? selectedRoles : [...ALLOWED_ROLES];
  const runPrefix = values.get("--run") ?? null;
  return { owner, roles, runPrefix, summaryOnly, json };
}

type UsageRowRecord = Readonly<{
  attempt_id: string;
  generation_command_id: string;
  role: string;
  command_status: string;
  attempt_status: string;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  cached_tokens: string | number | null;
  total_tokens: string | number | null;
  max_output_tokens: string | null;
}>;

function optionalInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optionalCap(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function readUsageRows(
  options: CliOptions,
  connectionString: string,
): Promise<readonly UsageRowRecord[]> {
  const pool = createPostgresPool({
    applicationName: "sayhear-g1-token-usage-report",
    connectionString,
  });
  try {
    const result = await pool.query<UsageRowRecord>(
      `SELECT attempt.model_run_attempt_id AS attempt_id,
              attempt.generation_command_id,
              command.model_role AS role,
              command.status AS command_status,
              attempt.status AS attempt_status,
              attempt.input_tokens,
              attempt.output_tokens,
              attempt.reasoning_tokens,
              attempt.cached_tokens,
              attempt.total_tokens,
              command.parameter_snapshot ->> 'maxOutputTokens' AS max_output_tokens
       FROM model_run_attempts attempt
       INNER JOIN generation_commands command
         ON command.generation_command_id = attempt.generation_command_id
        AND command.user_id = attempt.user_id
       WHERE attempt.user_id = $1
         AND ($2::text[] IS NULL OR command.model_role = ANY($2::text[]))
         AND ($3::text IS NULL OR left(command.intent_key, length($3::text)) = $3::text)
       ORDER BY attempt.created_at, attempt.model_run_attempt_id`,
      [
        options.owner,
        options.roles.length > 0 ? options.roles : null,
        options.runPrefix,
      ],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

function toUsageRow(row: UsageRowRecord): G1UsageRow {
  return {
    role: row.role,
    commandStatus: row.command_status,
    attemptStatus: row.attempt_status,
    maxOutputTokens: optionalCap(row.max_output_tokens),
    usage: {
      cachedTokens: optionalInteger(row.cached_tokens),
      inputTokens: optionalInteger(row.input_tokens),
      outputTokens: optionalInteger(row.output_tokens),
      reasoningTokens: optionalInteger(row.reasoning_tokens),
      totalTokens: optionalInteger(row.total_tokens),
    },
  };
}

function printBucket(label: string, bucket: G1UsageBucket): void {
  console.log(
    `${label} attempts=${bucket.attemptCount} known(input=${bucket.known.inputTokens},output=${bucket.known.outputTokens},reasoning=${bucket.known.reasoningTokens},cached=${bucket.known.cachedTokens},total=${bucket.known.totalTokens}) unknown(input=${bucket.unknownCounts.inputTokens},output=${bucket.unknownCounts.outputTokens},reasoning=${bucket.unknownCounts.reasoningTokens},cached=${bucket.unknownCounts.cachedTokens},total=${bucket.unknownCounts.totalTokens}) soft80=${bucket.soft80Count} soft95=${bucket.soft95Count}`,
  );
}

async function main(): Promise<void> {
  const options = parseG1TokenUsageArgs(process.argv.slice(2));
  const connectionString = process.env.G1_TOKEN_USAGE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "G1_TOKEN_USAGE_DATABASE_URL is required; no connection default is assumed.",
    );
  }
  const rows = await readUsageRows(options, connectionString);
  const report = summarizeG1TokenUsage(rows.map(toUsageRow));
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printBucket("total", report.total);
  for (const [role, bucket] of Object.entries(report.byRole)) {
    printBucket(`role:${role}`, bucket);
  }
  for (const [status, bucket] of Object.entries(report.byCommandStatus)) {
    printBucket(`command:${status}`, bucket);
  }
  for (const [status, bucket] of Object.entries(report.byAttemptStatus)) {
    printBucket(`attempt:${status}`, bucket);
  }
  if (!options.summaryOnly) {
    for (const row of rows) {
      console.log(
        `attempt ${row.attempt_id} command ${row.generation_command_id} role=${row.role} command_status=${row.command_status} attempt_status=${row.attempt_status} cap=${row.max_output_tokens ?? "unknown"} input=${row.input_tokens ?? "unknown"} output=${row.output_tokens ?? "unknown"} reasoning=${row.reasoning_tokens ?? "unknown"} cached=${row.cached_tokens ?? "unknown"} total=${row.total_tokens ?? "unknown"}`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Never print the connection string or any private value.
    console.error(
      "G1 token usage report failed:",
      error instanceof Error ? error.name : "Error",
    );
    process.exitCode = 1;
  });
}
