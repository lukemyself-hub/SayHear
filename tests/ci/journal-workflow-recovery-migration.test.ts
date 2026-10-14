/**
 * Journal workflow recovery migration drill (Issues #340 / #341).
 *
 * The recovery migration extends the frozen base schema with bounded retry
 * metadata on `journal_workflow_outcomes` and owner-scoped dispatch claims on
 * `evidence_model_run_attempts`. The schema registry alone cannot prove the
 * shape that matters here: a database built from the base commit's migrations
 * must upgrade in place, keep reading the rows an old writer inserted, backfill
 * the new ownership columns from the Evidence snapshot and its owner, and
 * recover a legacy `retryable_failed` Journal outcome.
 *
 * The base migration bytes come from the base commit's tree
 * (`SAYHEAR_MIGRATION_BASE_SHA`, else `GITHUB_EVENT_PATH`'s
 * `pull_request.base.sha`, else the `origin/main` merge base) rather than the
 * working tree. Deriving the prefix from the head tree would fold an edited or
 * unregistered migration into the prefix and let the drill agree with itself.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  matchFrozenPrefixSchemaContract,
  registeredSchemaExtensions,
  type OneA3bG1SchemaMigrationPin,
} from "@sayhear/application";
import {
  PostgresJournalRepository,
  PostgresJournalWorkflowRecovery,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_RELATIVE_DIRECTORY = "packages/data/migrations";
const HEAD_MIGRATIONS_DIRECTORY = join(REPOSITORY_ROOT, MIGRATIONS_RELATIVE_DIRECTORY);

// `pg` is a dependency of the workspace packages, not the repository root, so
// the post-dispose inspection resolves it from a package that owns it.
const requireFromData = createRequire(resolve(REPOSITORY_ROOT, "packages/data/package.json"));
const { Client } = requireFromData("pg") as typeof import("pg");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const EXTRACTION_POLICY_VERSION = "evidence-extraction:v1";
const USER = fixedInternalOwnerPrincipal.userId;
const SESSION = "01984477-2a00-7000-8000-000000000001";
const TURN = "01984477-2a00-7000-8000-000000000002";
const EVENT = "01984477-2a00-7000-8000-000000000003";
const REVISION = "01984477-2a00-7000-8000-000000000004";
const SNAPSHOT_LEGACY = "01984477-2a00-7000-8000-000000000005";
const ATTEMPT_LEGACY = "evidence-attempt-legacy-1";
const ITEM_LEGACY = "01984477-2a00-7000-8000-000000000006";
const GENERATION_COMMAND = "journal-command-legacy-1";
const MODEL_RUN_ATTEMPT = "journal-attempt-legacy-1";
const JOURNAL = "01984477-2a00-7000-8000-000000000007";
const VERSION_LEGACY = "01984477-2a00-7000-8000-000000000008";
const WORKFLOW_COMMAND = "01984477-2a00-7000-8000-000000000009";
const SNAPSHOT_OLDWRITER = "01984477-2a00-7000-8000-00000000000a";
const ATTEMPT_OLDWRITER = "evidence-attempt-oldwriter-1";
const ITEM_OLDWRITER = "01984477-2a00-7000-8000-00000000000b";
const VERSION_OLDWRITER = "01984477-2a00-7000-8000-00000000000c";
const GENERATION_COMMAND_OLDWRITER = "journal-command-oldwriter-1";
const MODEL_RUN_ATTEMPT_OLDWRITER = "journal-attempt-oldwriter-1";
const SNAPSHOT_CROSS = "01984477-2a00-7000-8000-00000000000d";
const ATTEMPT_CROSS = "evidence-attempt-cross-1";
const ITEM_CROSS_LOCAL = "01984477-2a00-7000-8000-00000000000e";
const SOURCE_REVISION = 5;
const DATA_EPOCH = 1;
const TEXT = "Synthetic migration evidence sentence about the garden fence.";

const RECOVERY_MIGRATION_NAME = "0082_journal_workflow_recovery.sql";
const RECOVERY_MIGRATION_SHA256 =
  "86392dc6d5f98b8d50f637eb4c31762a3678b8bfa4cb5ed1ce4071c0dc407b6f";

const NEW_WORKFLOW_OUTCOME_COLUMNS = [
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
] as const;
const NEW_EVIDENCE_ATTEMPT_COLUMNS = [
  "user_id",
  "daily_session_id",
  "source_revision",
  "expected_data_epoch",
  "frozen_evidence_item_ids",
] as const;

function runGitCommand(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readGitBlob(arguments_: readonly string[]): Buffer {
  return execFileSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPullRequestBaseSha(eventPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const sha = (parsed as { pull_request?: { base?: { sha?: unknown } } }).pull_request
    ?.base?.sha;
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}

function resolveMergeBase(): string | null {
  for (const reference of ["refs/remotes/origin/main", "origin/main", "main"]) {
    try {
      const mergeBase = runGitCommand(["merge-base", "HEAD", reference]);
      if (mergeBase.length > 0) return mergeBase;
    } catch {
      // The reference is absent in this checkout; try the next one.
    }
  }
  return null;
}

function resolveBaseCommit(): string {
  const explicit = process.env.SAYHEAR_MIGRATION_BASE_SHA?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (eventPath !== undefined && eventPath.length > 0) {
    const fromEvent = readPullRequestBaseSha(eventPath);
    if (fromEvent !== null) return fromEvent;
  }

  const mergeBase = resolveMergeBase();
  if (mergeBase !== null) return mergeBase;

  throw new Error(
    "The journal recovery migration drill cannot resolve a base commit: set " +
      "SAYHEAR_MIGRATION_BASE_SHA, provide GITHUB_EVENT_PATH with " +
      "pull_request.base.sha, or check out a branch whose base is reachable " +
      "from refs/remotes/origin/main.",
  );
}

type PinnedMigrationFile = Readonly<{
  pin: OneA3bG1SchemaMigrationPin;
  bytes: Buffer;
}>;

function readCommitMigrationFiles(
  commit: string,
  directory: string,
): readonly PinnedMigrationFile[] {
  const names = runGitCommand(["ls-tree", "--name-only", `${commit}:${directory}`])
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return names.map((name) => {
    const bytes = readGitBlob(["cat-file", "blob", `${commit}:${directory}/${name}`]);
    return { pin: { name, sha256: sha256Bytes(bytes) }, bytes };
  });
}

function isolatedSchemaName(connectionString: string): string {
  const options = new URL(connectionString).searchParams.get("options") ?? "";
  return options.replace("-c search_path=", "");
}

async function readAppliedPins(
  pool: Pool,
): Promise<readonly OneA3bG1SchemaMigrationPin[]> {
  const result = await pool.query<{ migration_name: string; migration_sha256: string }>(
    "SELECT migration_name, migration_sha256 FROM schema_migrations ORDER BY migration_name",
  );
  return result.rows.map((row) => ({
    name: row.migration_name,
    sha256: row.migration_sha256,
  }));
}

async function missingColumns(
  pool: Pool,
  table: string,
  columns: readonly string[],
): Promise<string[]> {
  const present = new Set(
    (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      )
    ).rows.map(({ column_name }) => column_name),
  );
  return columns.filter((column) => !present.has(column));
}

async function readSourceErrorCode(
  readSource: () => Promise<unknown>,
): Promise<string> {
  try {
    await readSource();
    return "resolved";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return typeof code === "string" ? code : "no-code";
  }
}

async function readPreBranchSnapshotItemIds(
  pool: Pool,
  snapshotId: string,
): Promise<string[]> {
  const result = await pool.query<{ evidence_item_id: string }>(
    `SELECT item.evidence_item_id
     FROM evidence_source_snapshots snapshot
     LEFT JOIN evidence_items item ON item.evidence_source_snapshot_id = snapshot.evidence_source_snapshot_id
     INNER JOIN app_users owner ON owner.user_id = snapshot.user_id
     WHERE snapshot.evidence_source_snapshot_id = $1 AND owner.status = 'active' AND owner.data_epoch = $2
       AND item.extraction_policy_version = $3
     ORDER BY item.evidence_item_id`,
    [snapshotId, DATA_EPOCH, EXTRACTION_POLICY_VERSION],
  );
  return result.rows.map(({ evidence_item_id }) => evidence_item_id);
}

async function readPreservedRows(
  pool: Pool,
): Promise<Record<string, string | null>> {
  const scalar = async (sql: string, values: unknown[]): Promise<string | null> =>
    (await pool.query<{ row: string | null }>(sql, values)).rows[0]?.row ?? null;

  return {
    applicationUser: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM app_users t WHERE t.user_id = $1`,
      [USER],
    ),
    dailySession: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM daily_sessions t WHERE t.daily_session_id = $1`,
      [SESSION],
    ),
    interactionTurn: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM interaction_turns t WHERE t.interaction_turn_id = $1`,
      [TURN],
    ),
    conversationEvent: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM conversation_events t WHERE t.conversation_event_id = $1`,
      [EVENT],
    ),
    conversationEventRevision: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM conversation_event_revisions t
       WHERE t.conversation_event_revision_id = $1`,
      [REVISION],
    ),
    evidenceSourceSnapshot: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM evidence_source_snapshots t
       WHERE t.evidence_source_snapshot_id = $1`,
      [SNAPSHOT_LEGACY],
    ),
    evidenceItem: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM evidence_items t WHERE t.evidence_item_id = $1`,
      [ITEM_LEGACY],
    ),
    journalGenerationCommand: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM journal_generation_commands t
       WHERE t.generation_command_id = $1`,
      [GENERATION_COMMAND],
    ),
    journal: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM journals t WHERE t.journal_id = $1`,
      [JOURNAL],
    ),
    journalVersion: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM journal_versions t WHERE t.journal_version_id = $1`,
      [VERSION_LEGACY],
    ),
    journalModelRunAttempt: await scalar(
      `SELECT to_jsonb(t)::text AS row FROM journal_model_run_attempts t
       WHERE t.model_run_attempt_id = $1`,
      [MODEL_RUN_ATTEMPT],
    ),
    evidenceModelRunAttemptLegacyColumns: await scalar(
      `SELECT to_jsonb(legacy)::text AS row FROM (
         SELECT evidence_model_run_attempt_id, evidence_source_snapshot_id, role, provider, model,
           config_version, extraction_policy_version, prompt_fingerprint, provider_request_id,
           provider_completed_at, result_metadata, status, created_at
         FROM evidence_model_run_attempts WHERE evidence_model_run_attempt_id = $1
       ) legacy`,
      [ATTEMPT_LEGACY],
    ),
  };
}

/**
 * The workflow outcome columns that neither the migration nor the retry
 * recovery may rewrite: the row keeps its owner, session, revision, epoch and
 * creation time. `outcome` and `reason` move with recovery, so they are
 * asserted at the settle step instead.
 */
async function readWorkflowOutcomeIdentity(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ row: string | null }>(
    `SELECT to_jsonb(identity)::text AS row FROM (
       SELECT workflow_command_id, user_id, daily_session_id, source_revision,
         expected_data_epoch, created_at
       FROM journal_workflow_outcomes WHERE workflow_command_id = $1
     ) identity`,
    [WORKFLOW_COMMAND],
  );
  return result.rows[0]?.row ?? null;
}

async function seedLegacy(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO app_users (user_id, status, data_epoch) VALUES ($1, 'active', $2)`,
    [USER, DATA_EPOCH],
  );
  await pool.query(
    `INSERT INTO daily_sessions (daily_session_id, user_id, logical_date, timezone_at_start,
       started_at, last_activity_at, created_at, updated_at, activity_state, source_revision)
     VALUES ($1, $2, '2026-10-12', 'America/Los_Angeles', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'quiescent', $3)`,
    [SESSION, USER, SOURCE_REVISION],
  );
  await pool.query(
    `INSERT INTO interaction_turns (interaction_turn_id, user_id, daily_session_id, client_turn_id,
       turn_sequence_no, continuous_exchange_no, status, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'legacy-turn-1', 1, 1, 'settled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [TURN, USER, SESSION],
  );
  await pool.query(
    `INSERT INTO conversation_events (conversation_event_id, user_id, daily_session_id, interaction_turn_id,
       sequence_no, client_event_id, actor, channel, event_type, current_revision_id, lifecycle_status, created_at)
     VALUES ($1, $2, $3, $4, 1, 'legacy-event-1', 'user', 'text', 'user_text',
       NULL, 'active', CURRENT_TIMESTAMP)`,
    [EVENT, USER, SESSION, TURN],
  );
  await pool.query(
    `INSERT INTO conversation_event_revisions (conversation_event_revision_id, user_id, conversation_event_id,
       revision, locale, canonical_text, transcript_status, created_by, created_at)
     VALUES ($1, $2, $3, 1, 'en-US', $4, 'final', 'client', CURRENT_TIMESTAMP)`,
    [REVISION, USER, EVENT, TEXT],
  );
  await pool.query(
    `UPDATE conversation_events SET current_revision_id = $1 WHERE conversation_event_id = $2`,
    [REVISION, EVENT],
  );
  await pool.query(
    `INSERT INTO evidence_source_snapshots (evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
       extraction_policy_version, command_id, attempt_id, champion_config_version, champion_provider,
       champion_model, champion_snapshot, champion_provider_policy_version, created_at)
     VALUES ($1, $2, $3, $4, $5, 'evidence-command-legacy-1', 'attempt-legacy-1', 'evidence-extraction:v1',
       'openai', 'gpt-5.4', 'gpt-5.4', 'openai-conversation-text:v1', CURRENT_TIMESTAMP)`,
    [SNAPSHOT_LEGACY, USER, SESSION, SOURCE_REVISION, EXTRACTION_POLICY_VERSION],
  );
  await pool.query(
    `INSERT INTO evidence_model_run_attempts (evidence_model_run_attempt_id, evidence_source_snapshot_id, role,
       provider, model, config_version, extraction_policy_version, prompt_fingerprint, status, created_at)
     VALUES ($1, $2, 'evidence.extract', 'openai', 'gpt-5.4', 'evidence-extraction:v1', $3,
       'fingerprint-legacy-1', 'started', CURRENT_TIMESTAMP)`,
    [ATTEMPT_LEGACY, SNAPSHOT_LEGACY, EXTRACTION_POLICY_VERSION],
  );
  await pool.query(
    `INSERT INTO evidence_items (evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
       source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version,
       evidence_role, created_at)
     VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', 'legacy', $6, 'factual_support', CURRENT_TIMESTAMP)`,
    [ITEM_LEGACY, USER, SNAPSHOT_LEGACY, EVENT, REVISION, EXTRACTION_POLICY_VERSION],
  );
  await pool.query(
    `INSERT INTO journal_generation_commands (generation_command_id, user_id, daily_session_id, source_revision,
       generation_policy_version, expected_data_epoch, created_at)
     VALUES ($1, $2, $3, $4, 'journal-generation:v1', $5, CURRENT_TIMESTAMP)`,
    [GENERATION_COMMAND, USER, SESSION, SOURCE_REVISION, DATA_EPOCH],
  );
  await pool.query(
    `INSERT INTO journal_model_run_attempts (model_run_attempt_id, generation_command_id, status, created_at)
     VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)`,
    [MODEL_RUN_ATTEMPT, GENERATION_COMMAND],
  );
  await pool.query(
    `INSERT INTO journals (journal_id, user_id, daily_session_id, created_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [JOURNAL, USER, SESSION],
  );
  await pool.query(
    `INSERT INTO journal_versions (journal_version_id, journal_id, user_id, daily_session_id, source_revision,
       generation_policy_version, validator_version, locale, evidence_source_snapshot_id, status,
       generation_command_id, model_run_attempt_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'journal-generation:v1', 'journal-validation:v1', 'en-US', $6, 'published',
       $7, $8, CURRENT_TIMESTAMP)`,
    [
      VERSION_LEGACY,
      JOURNAL,
      USER,
      SESSION,
      SOURCE_REVISION,
      SNAPSHOT_LEGACY,
      GENERATION_COMMAND,
      MODEL_RUN_ATTEMPT,
    ],
  );
  await pool.query(`UPDATE journals SET current_version_id = $1 WHERE journal_id = $2`, [
    VERSION_LEGACY,
    JOURNAL,
  ]);
  await pool.query(
    `INSERT INTO journal_workflow_outcomes (workflow_command_id, user_id, daily_session_id, source_revision,
       expected_data_epoch, outcome, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, 'retryable_failed', 'evidence_provider_failed', CURRENT_TIMESTAMP)`,
    [WORKFLOW_COMMAND, USER, SESSION, SOURCE_REVISION, DATA_EPOCH],
  );
}

/**
 * One published Evidence group inserted in the old writer shape: no
 * `evidence_model_run_attempts` ownership columns, no frozen membership. This
 * is what a pre-branch writer produced on a database that already has the head
 * schema.
 */
async function insertOldWriterGroup(
  pool: Pool,
  input: Readonly<{
    snapshotId: string;
    attemptId: string;
    itemId: string;
    locatorKey: string;
    sourceRevision: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    journalVersionId: string;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO evidence_source_snapshots (evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
       extraction_policy_version, command_id, attempt_id, champion_config_version, champion_provider,
       champion_model, champion_snapshot, champion_provider_policy_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'evidence-extraction:v1', 'openai', 'gpt-5.4', 'gpt-5.4',
       'openai-conversation-text:v1', CURRENT_TIMESTAMP)`,
    [
      input.snapshotId,
      USER,
      SESSION,
      input.sourceRevision,
      EXTRACTION_POLICY_VERSION,
      `evidence-command-${input.locatorKey}`,
      `attempt-${input.locatorKey}`,
    ],
  );
  await pool.query(
    `INSERT INTO evidence_model_run_attempts (evidence_model_run_attempt_id, evidence_source_snapshot_id, role,
       provider, model, config_version, extraction_policy_version, prompt_fingerprint, status, created_at)
     VALUES ($1, $2, 'evidence.extract', 'openai', 'gpt-5.4', 'evidence-extraction:v1', $3,
       $4, 'started', CURRENT_TIMESTAMP)`,
    [
      input.attemptId,
      input.snapshotId,
      EXTRACTION_POLICY_VERSION,
      `fingerprint-${input.locatorKey}`,
    ],
  );
  await pool.query(
    `INSERT INTO evidence_items (evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
       source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version,
       evidence_role, created_at)
     VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', $6, $7, 'factual_support', CURRENT_TIMESTAMP)`,
    [
      input.itemId,
      USER,
      input.snapshotId,
      EVENT,
      REVISION,
      input.locatorKey,
      EXTRACTION_POLICY_VERSION,
    ],
  );
  await pool.query(
    `INSERT INTO journal_generation_commands (generation_command_id, user_id, daily_session_id, source_revision,
       generation_policy_version, expected_data_epoch, created_at)
     VALUES ($1, $2, $3, $4, 'journal-generation:v1', $5, CURRENT_TIMESTAMP)`,
    [input.generationCommandId, USER, SESSION, input.sourceRevision, DATA_EPOCH],
  );
  await pool.query(
    `INSERT INTO journal_model_run_attempts (model_run_attempt_id, generation_command_id, status, created_at)
     VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)`,
    [input.modelRunAttemptId, input.generationCommandId],
  );
  await pool.query(
    `INSERT INTO journal_versions (journal_version_id, journal_id, user_id, daily_session_id, source_revision,
       generation_policy_version, validator_version, locale, evidence_source_snapshot_id, status,
       generation_command_id, model_run_attempt_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'journal-generation:v1', 'journal-validation:v1', 'en-US', $6, 'published',
       $7, $8, CURRENT_TIMESTAMP)`,
    [
      input.journalVersionId,
      JOURNAL,
      USER,
      SESSION,
      input.sourceRevision,
      input.snapshotId,
      input.generationCommandId,
      input.modelRunAttemptId,
    ],
  );
}

systemDescribe("Journal workflow recovery migration (issues #340 / #341)", () => {
  it(
    "upgrades the base schema in place and recovers legacy Journal state",
    async () => {
      const baseCommit = resolveBaseCommit();
      const baseFiles = readCommitMigrationFiles(
        baseCommit,
        MIGRATIONS_RELATIVE_DIRECTORY,
      );
      expect(baseFiles.length).toBeGreaterThan(0);
      const baseFilePins = baseFiles.map(({ pin }) => pin);
      const basePinNames = new Set(baseFilePins.map(({ name }) => name));
      const headMigrationNames = (await readdir(HEAD_MIGRATIONS_DIRECTORY))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const newRegistrationNames = headMigrationNames.filter(
        (name) => !basePinNames.has(name),
      );
      expect(newRegistrationNames).toContain(RECOVERY_MIGRATION_NAME);
      const businessExtensions = registeredSchemaExtensions("business");
      const registeredNewPins = businessExtensions
        .filter((extension) => !basePinNames.has(extension.name))
        .map(({ name, sha256 }) => ({ name, sha256 }));

      const baseDirectory = await mkdtemp(
        join(tmpdir(), "sayhear-journal-recovery-base-"),
      );
      let schema: IsolatedPostgresSchema | undefined;
      let schemaName = "";
      try {
        for (const { pin, bytes } of baseFiles) {
          await writeFile(join(baseDirectory, pin.name), bytes);
        }

        schema = await createIsolatedPostgresSchema(testDatabaseUrl!);
        schemaName = isolatedSchemaName(schema.connectionString);
        const { pool } = schema;
        const repository = new PostgresJournalRepository(pool);
        const readSource = () =>
          repository.readSource({
            dailySessionId: SESSION,
            sourceRevision: SOURCE_REVISION,
            expectedDataEpoch: DATA_EPOCH,
            extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
          });

        await runMigrations(pool, { migrationsDirectory: baseDirectory });
        const basePins = await readAppliedPins(pool);
        expect(basePins).toEqual(baseFilePins);
        expect(basePins.map(({ name }) => name)).not.toContain(
          RECOVERY_MIGRATION_NAME,
        );
        expect(
          await missingColumns(
            pool,
            "journal_workflow_outcomes",
            NEW_WORKFLOW_OUTCOME_COLUMNS,
          ),
        ).toEqual([...NEW_WORKFLOW_OUTCOME_COLUMNS]);
        expect(
          await missingColumns(
            pool,
            "evidence_model_run_attempts",
            NEW_EVIDENCE_ATTEMPT_COLUMNS,
          ),
        ).toEqual([...NEW_EVIDENCE_ATTEMPT_COLUMNS]);

        await seedLegacy(pool);
        const seeded = await pool.query<{
          evidence: string;
          version_status: string;
          outcome: string;
        }>(
          `SELECT (SELECT count(*)::text FROM evidence_items) AS evidence,
             (SELECT status FROM journal_versions WHERE journal_version_id = $1) AS version_status,
             (SELECT outcome FROM journal_workflow_outcomes WHERE workflow_command_id = $2) AS outcome`,
          [VERSION_LEGACY, WORKFLOW_COMMAND],
        );
        expect(seeded.rows[0]).toEqual({
          evidence: "1",
          version_status: "published",
          outcome: "retryable_failed",
        });
        const preservedBefore = await readPreservedRows(pool);
        const outcomeIdentityBefore = await readWorkflowOutcomeIdentity(pool);

        expect(await readSourceErrorCode(readSource)).toBe("42703");

        await runMigrations(pool, { migrationsDirectory: HEAD_MIGRATIONS_DIRECTORY });
        const upgradedPins = await readAppliedPins(pool);
        const contract = matchFrozenPrefixSchemaContract({
          expected: basePins,
          applied: upgradedPins,
          extensions: businessExtensions,
        });
        expect(contract.mismatch).toBeNull();
        expect(contract.matches).toBe(true);
        expect(contract.appliedExtensions.map(({ name }) => name)).toEqual(
          newRegistrationNames,
        );
        expect(contract.appliedExtensions).toEqual(registeredNewPins);
        expect(
          contract.appliedExtensions.find(
            ({ name }) => name === RECOVERY_MIGRATION_NAME,
          ),
        ).toEqual({
          name: RECOVERY_MIGRATION_NAME,
          sha256: RECOVERY_MIGRATION_SHA256,
        });
        expect(upgradedPins.slice(0, basePins.length)).toEqual(basePins);
        expect(
          await missingColumns(
            pool,
            "journal_workflow_outcomes",
            NEW_WORKFLOW_OUTCOME_COLUMNS,
          ),
        ).toEqual([]);
        expect(
          await missingColumns(
            pool,
            "evidence_model_run_attempts",
            NEW_EVIDENCE_ATTEMPT_COLUMNS,
          ),
        ).toEqual([]);

        const upgradedOutcome = (
          await pool.query<{
            attempt_count: number;
            next_attempt_at: Date | null;
            lease_token: string | null;
            lease_expires_at: Date | null;
            outcome: string;
            reason: string | null;
          }>(
            `SELECT attempt_count, next_attempt_at, lease_token, lease_expires_at, outcome, reason
             FROM journal_workflow_outcomes WHERE workflow_command_id = $1`,
            [WORKFLOW_COMMAND],
          )
        ).rows[0];
        expect(upgradedOutcome).toEqual({
          attempt_count: 0,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null,
          outcome: "retryable_failed",
          reason: "evidence_provider_failed",
        });

        const upgradedAttempt = (
          await pool.query<{
            user_id: string;
            daily_session_id: string;
            source_revision: string;
            expected_data_epoch: string;
            frozen_evidence_item_ids: string[] | null;
          }>(
            `SELECT user_id, daily_session_id, source_revision::text AS source_revision,
               expected_data_epoch::text AS expected_data_epoch, frozen_evidence_item_ids
             FROM evidence_model_run_attempts WHERE evidence_model_run_attempt_id = $1`,
            [ATTEMPT_LEGACY],
          )
        ).rows[0];
        expect(upgradedAttempt).toEqual({
          user_id: USER,
          daily_session_id: SESSION,
          source_revision: String(SOURCE_REVISION),
          expected_data_epoch: String(DATA_EPOCH),
          frozen_evidence_item_ids: null,
        });

        const legacyRead = await readSource();
        expect(legacyRead?.sourceSnapshotId).toBe(SNAPSHOT_LEGACY);
        expect(legacyRead?.evidenceItems.map(({ id }) => id)).toEqual([ITEM_LEGACY]);
        expect(legacyRead?.sourceTextByEvidenceId).toEqual({ [ITEM_LEGACY]: TEXT });

        const recovery = new PostgresJournalWorkflowRecovery(pool, 300_000);
        const identity = {
          workflowCommandId: WORKFLOW_COMMAND,
          subjectId: SESSION,
          sourceRevision: SOURCE_REVISION,
          expectedDataEpoch: DATA_EPOCH,
        };
        const readOutcome = async () =>
          (
            await pool.query<{
              outcome: string;
              reason: string | null;
              attempt_count: number;
              lease_token: string | null;
            }>(
              `SELECT outcome, reason, attempt_count, lease_token FROM journal_workflow_outcomes
               WHERE workflow_command_id = $1`,
              [WORKFLOW_COMMAND],
            )
          ).rows[0];

        expect(await recovery.claim(identity, "legacy-recovery-token-1")).toBe(true);
        expect(await readOutcome()).toEqual({
          outcome: "retryable_failed",
          reason: "evidence_provider_failed",
          attempt_count: 1,
          lease_token: "legacy-recovery-token-1",
        });
        await recovery.settle(
          identity,
          "legacy-recovery-token-1",
          "published",
          null,
        );
        expect(await readOutcome()).toEqual({
          outcome: "published",
          reason: null,
          attempt_count: 1,
          lease_token: null,
        });
        expect(await recovery.claim(identity, "legacy-recovery-token-2")).toBe(false);
        expect(await readOutcome()).toEqual({
          outcome: "published",
          reason: null,
          attempt_count: 1,
          lease_token: null,
        });

        await insertOldWriterGroup(pool, {
          snapshotId: SNAPSHOT_OLDWRITER,
          attemptId: ATTEMPT_OLDWRITER,
          itemId: ITEM_OLDWRITER,
          locatorKey: "oldwriter",
          sourceRevision: SOURCE_REVISION + 1,
          generationCommandId: GENERATION_COMMAND_OLDWRITER,
          modelRunAttemptId: MODEL_RUN_ATTEMPT_OLDWRITER,
          journalVersionId: VERSION_OLDWRITER,
        });
        const oldWriterRead = await repository.readSource({
          dailySessionId: SESSION,
          sourceRevision: SOURCE_REVISION + 1,
          expectedDataEpoch: DATA_EPOCH,
          extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
        });
        expect(oldWriterRead?.evidenceItems.map(({ id }) => id)).toEqual([
          ITEM_OLDWRITER,
        ]);
        expect(oldWriterRead?.sourceTextByEvidenceId).toEqual({
          [ITEM_OLDWRITER]: TEXT,
        });

        await pool.query(
          `INSERT INTO evidence_source_snapshots (evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
             extraction_policy_version, command_id, attempt_id, champion_config_version, champion_provider,
             champion_model, champion_snapshot, champion_provider_policy_version, created_at)
           VALUES ($1, $2, $3, $4, $5, 'evidence-command-cross-1', 'attempt-cross-1', 'evidence-extraction:v1',
             'openai', 'gpt-5.4', 'gpt-5.4', 'openai-conversation-text:v1', CURRENT_TIMESTAMP)`,
          [SNAPSHOT_CROSS, USER, SESSION, SOURCE_REVISION + 2, EXTRACTION_POLICY_VERSION],
        );
        await pool.query(
          `INSERT INTO evidence_items (evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
             source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version,
             evidence_role, created_at)
           VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', 'cross-local', $6, 'factual_support', CURRENT_TIMESTAMP)`,
          [
            ITEM_CROSS_LOCAL,
            USER,
            SNAPSHOT_CROSS,
            EVENT,
            REVISION,
            EXTRACTION_POLICY_VERSION,
          ],
        );
        await pool.query(
          `INSERT INTO evidence_model_run_attempts (evidence_model_run_attempt_id, evidence_source_snapshot_id, role,
             provider, model, config_version, extraction_policy_version, prompt_fingerprint, status, created_at,
             user_id, daily_session_id, source_revision, expected_data_epoch, frozen_evidence_item_ids)
           VALUES ($1, $2, 'evidence.extract', 'openai', 'gpt-5.4', 'evidence-extraction:v1', $3,
             'fingerprint-cross-1', 'completed', CURRENT_TIMESTAMP, $4, $5, $6, $7, ARRAY[$8]::uuid[])`,
          [
            ATTEMPT_CROSS,
            SNAPSHOT_CROSS,
            EXTRACTION_POLICY_VERSION,
            USER,
            SESSION,
            SOURCE_REVISION + 2,
            DATA_EPOCH,
            ITEM_LEGACY,
          ],
        );
        const crossRead = await repository.readSource({
          dailySessionId: SESSION,
          sourceRevision: SOURCE_REVISION + 2,
          expectedDataEpoch: DATA_EPOCH,
          extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
        });
        expect(crossRead?.evidenceItems.map(({ id }) => id)).toEqual([ITEM_LEGACY]);
        expect(
          crossRead?.evidenceItems.some(({ id }) => id === ITEM_CROSS_LOCAL),
        ).toBe(false);
        expect(
          crossRead?.evidenceItems.some(({ id }) => id === ITEM_OLDWRITER),
        ).toBe(false);
        expect(crossRead?.sourceTextByEvidenceId).toEqual({ [ITEM_LEGACY]: TEXT });
        expect(await readPreBranchSnapshotItemIds(pool, SNAPSHOT_CROSS)).toEqual([
          ITEM_CROSS_LOCAL,
        ]);

        expect(await readPreservedRows(pool)).toEqual(preservedBefore);
        expect(await readWorkflowOutcomeIdentity(pool)).toEqual(outcomeIdentityBefore);
      } finally {
        await schema?.dispose();
        await rm(baseDirectory, { recursive: true, force: true });
      }

      const inspection = new Client({ connectionString: testDatabaseUrl! });
      await inspection.connect();
      try {
        const remaining = await inspection.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1`,
          [schemaName],
        );
        expect(schemaName.length).toBeGreaterThan(0);
        expect(remaining.rows[0]?.count).toBe(0);
      } finally {
        await inspection.end();
      }
    },
    240_000,
  );
});
