import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asUserId,
  createJournalService,
  encodeJournalDateCursor,
  InvalidJournalDateError,
  JournalDateCursorError,
  RecoveryGateClosedError,
  type JournalService,
  type RecoveryGate,
  type RecoveryGateResult,
} from "@sayhear/application";
import {
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { createJournalDateListHandler } from "../../apps/web/src/journal-date-list-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const CURSOR_SECRET = "system-test-journal-date-cursor-secret";

const OPEN_RESULT: RecoveryGateResult = Object.freeze({
  markerDataEpoch: null,
  markerPurgedAt: null,
  markerWrittenAt: null,
  receiptDestinations: [],
  status: "open",
});

const openGate: RecoveryGate = {
  async evaluate() {
    return OPEN_RESULT;
  },
  async requireOpen() {
    return OPEN_RESULT;
  },
};

const closedGate: RecoveryGate = {
  async evaluate() {
    return { ...OPEN_RESULT, status: "needs_attention" };
  },
  async requireOpen() {
    throw new RecoveryGateClosedError({
      ...OPEN_RESULT,
      status: "needs_attention",
    });
  },
};

type SeedOptions = Readonly<{
  activityState?: "active" | "quiescent" | "finalized";
  diagnosticStatus?: "available" | "unavailable" | "not_run";
  journalSourceRevision?: number;
  purged?: boolean;
  sessionSourceRevision?: number;
  setCurrent?: boolean;
  text?: string;
  versionStatus?: "published" | "validation_failed";
}>;

type SeededDay = Readonly<{
  dailySessionId: string;
  journalId: string;
  versionId: string;
}>;

function buildService(
  database: IsolatedPostgresSchema,
  gate: RecoveryGate = openGate,
): JournalService {
  return createJournalService({
    cursorSecret: CURSOR_SECRET,
    evidenceExtractionPolicyVersion: "evidence-extraction:v1",
    generationMetadata: {
      configVersion: "test:journal-draft",
      model: "test",
      promptFingerprint: "test:journal-draft",
      provider: "deterministic",
      role: "journal.draft",
      rolePolicyVersion: "journal-generation:v2",
    },
    journalPolicyVersion: "journal-generation:v2",
    model: {
      async generate() {
        throw new Error("Journal generation is not exercised by this seam.");
      },
    },
    recoveryGate: gate,
    repository: new PostgresJournalRepository(database.pool),
    validationMetadata: {
      configVersion: "test:journal-validate",
      model: "test",
      promptFingerprint: "test:journal-validate",
      provider: "deterministic",
      role: "journal.validate",
      rolePolicyVersion: "journal-validator:v3",
    },
    validationProvider: {
      role: "journal.validate",
      async validate() {
        return { findings: [], status: "available" };
      },
    },
    validatorVersion: "journal-validator:v3",
  });
}

describe("Portal Journal date browsing system seam — ticket #265", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
  }, 30_000);

  beforeEach(async () => {
    await database.pool.query("TRUNCATE TABLE app_users CASCADE");
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "portal-journal-dates-owner",
      userId: OWNER,
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  async function seedDay(
    date: string,
    options: SeedOptions = {},
  ): Promise<SeededDay> {
    const versionStatus = options.versionStatus ?? "published";
    const current = options.setCurrent ?? versionStatus === "published";
    const sessionSourceRevision = options.sessionSourceRevision ?? 1;
    const journalSourceRevision = options.journalSourceRevision ?? 1;
    const text = options.text ?? `Synthetic journal for ${date}`;
    const ids = {
      attemptId: randomUUID(),
      commandId: randomUUID(),
      evidenceId: randomUUID(),
      eventId: randomUUID(),
      journalId: randomUUID(),
      revisionId: randomUUID(),
      sessionId: randomUUID(),
      snapshotId: randomUUID(),
      statementId: randomUUID(),
      turnId: randomUUID(),
      validationId: randomUUID(),
      versionId: randomUUID(),
    };

    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, activity_state, source_revision,
         created_at, updated_at)
       VALUES ($1, $2, $3::date, 'America/Los_Angeles', now(), now(), $4, $5, now(), now())`,
      [
        ids.sessionId,
        OWNER,
        date,
        options.activityState ?? "finalized",
        sessionSourceRevision,
      ],
    );
    await database.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, 1, 'settled', now(), now(), now())`,
      [ids.turnId, OWNER, ids.sessionId, `turn-${date}`],
    );
    await database.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'user', 'text', 'user_text', 'active', now())`,
      [ids.eventId, OWNER, ids.sessionId, ids.turnId, `event-${date}`],
    );
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at)
       VALUES ($1, $2, $3, 1, 'en-US', $4, 'final', 'client', now())`,
      [ids.revisionId, OWNER, ids.eventId, options.purged ? "" : `source ${date}`],
    );
    await database.pool.query(
      "UPDATE conversation_events SET current_revision_id = $1 WHERE conversation_event_id = $2",
      [ids.revisionId, ids.eventId],
    );
    if (options.purged) {
      await database.pool.query(
        `UPDATE conversation_event_revisions
         SET content_purged_at = now()
         WHERE conversation_event_revision_id = $1`,
        [ids.revisionId],
      );
    }
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at)
       VALUES ($1, $2, $3, $4, 'evidence-extraction:v1', $5, $6,
         'cfg', 'openai', 'gpt', 'snap', 'policy', now())`,
      [
        ids.snapshotId,
        OWNER,
        ids.sessionId,
        journalSourceRevision,
        randomUUID(),
        randomUUID(),
      ],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision',
         '0:1', 'evidence-extraction:v1', 'factual_support', 'active', now())`,
      [ids.evidenceId, OWNER, ids.snapshotId, ids.eventId, ids.revisionId],
    );
    await database.pool.query(
      `INSERT INTO journal_generation_commands (
         generation_command_id, user_id, daily_session_id, source_revision,
         generation_policy_version, expected_data_epoch, created_at)
       VALUES ($1, $2, $3, $4, 'journal-generation:v2', 1, now())`,
      [ids.commandId, OWNER, ids.sessionId, journalSourceRevision],
    );
    await database.pool.query(
      `INSERT INTO journal_model_run_attempts (
         model_run_attempt_id, generation_command_id, role, provider, model,
         config_version, role_policy_version, prompt_fingerprint, status, created_at)
       VALUES ($1, $2, 'journal.draft', 'deterministic', 'test', 'cfg',
         'policy', 'fp', 'completed', now())`,
      [ids.attemptId, ids.commandId],
    );
    await database.pool.query(
      `INSERT INTO journals (journal_id, user_id, daily_session_id, created_at)
       VALUES ($1, $2, $3, now())`,
      [ids.journalId, OWNER, ids.sessionId],
    );
    await database.pool.query(
      `INSERT INTO journal_versions (
         journal_version_id, journal_id, user_id, daily_session_id,
         source_revision, generation_policy_version, validator_version, locale,
         evidence_source_snapshot_id, status, generation_command_id,
         model_run_attempt_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'journal-generation:v2', 'journal-validator:v3',
         'en-US', $6, $7, $8, $9, now())`,
      [
        ids.versionId,
        ids.journalId,
        OWNER,
        ids.sessionId,
        journalSourceRevision,
        ids.snapshotId,
        versionStatus,
        ids.commandId,
        ids.attemptId,
      ],
    );
    await database.pool.query(
      `INSERT INTO journal_statements (
         journal_statement_id, journal_version_id, statement_index,
         statement_key, statement_text, user_id, source_revision,
         evidence_source_snapshot_id)
       VALUES ($1, $2, 0, 's1', $3, $4, $5, $6)`,
      [
        ids.statementId,
        ids.versionId,
        text,
        OWNER,
        journalSourceRevision,
        ids.snapshotId,
      ],
    );
    await database.pool.query(
      `INSERT INTO journal_statement_evidence_links (
         journal_statement_id, evidence_item_id, user_id, source_revision,
         evidence_source_snapshot_id, evidence_role)
       VALUES ($1, $2, $3, $4, $5, 'factual_support')`,
      [
        ids.statementId,
        ids.evidenceId,
        OWNER,
        journalSourceRevision,
        ids.snapshotId,
      ],
    );
    await database.pool.query(
      `INSERT INTO journal_validation_results (
         journal_validation_result_id, journal_version_id, daily_session_id,
         source_revision, generation_command_id, model_run_attempt_id,
         programmatic_valid, failure_code, status, diagnostic_status,
         validator_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'journal-validator:v3', now())`,
      [
        ids.validationId,
        ids.versionId,
        ids.sessionId,
        journalSourceRevision,
        ids.commandId,
        ids.attemptId,
        versionStatus === "published",
        versionStatus === "published" ? null : "invalid_schema",
        versionStatus === "published" ? "validated" : "needs_review",
        options.diagnosticStatus ?? "available",
      ],
    );
    if (current) {
      await database.pool.query(
        "UPDATE journals SET current_version_id = $1 WHERE journal_id = $2",
        [ids.versionId, ids.journalId],
      );
    }
    return {
      dailySessionId: ids.sessionId,
      journalId: ids.journalId,
      versionId: ids.versionId,
    };
  }

  function days(endDay: number): string[] {
    return Array.from({ length: endDay }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return `2026-01-${day}`;
    });
  }

  it("pages the date list with a fixed cap, stable order and no duplicates or misses (AC #7)", async () => {
    const expected = days(31);
    for (const date of expected) {
      await seedDay(date, { text: `Journal ${date}` });
    }
    const service = buildService(database);

    const first = await service.listJournalDates({ userId: OWNER });
    expect(first.entries).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries.map((entry) => entry.logicalDate)).toEqual(
      [...expected].reverse().slice(0, 30),
    );

    const second = await service.listJournalDates({
      cursor: first.nextCursor,
      userId: OWNER,
    });
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.entries[0]?.logicalDate).toBe("2026-01-01");

    const combined = [...first.entries, ...second.entries].map(
      (entry) => entry.logicalDate,
    );
    expect(new Set(combined).size).toBe(31);
    expect(combined).toEqual([...expected].reverse());
  });

  it("rejects a cursor that is malformed or bound to a different owner (AC #7)", async () => {
    await seedDay("2026-03-01");
    const service = buildService(database);
    const foreignCursor = encodeJournalDateCursor(
      {
        after: ["2026-03-01", randomUUID()],
        owner: randomUUID(),
        sort: "logical_date_desc",
        version: 1,
      },
      CURSOR_SECRET,
    );
    await expect(
      service.listJournalDates({ cursor: foreignCursor, userId: OWNER }),
    ).rejects.toBeInstanceOf(JournalDateCursorError);
    await expect(
      service.listJournalDates({ cursor: "not-a-cursor", userId: OWNER }),
    ).rejects.toBeInstanceOf(JournalDateCursorError);
  });

  it("reads the selected day's current published version and never a failed draft (AC #2, #3, #5)", async () => {
    await seedDay("2026-02-01", { text: "CURRENT 2026-02-01" });
    await seedDay("2026-02-02", {
      text: "FAILED DRAFT 2026-02-02",
      versionStatus: "validation_failed",
    });
    const service = buildService(database);

    const published = await service.readByDate({
      logicalDate: "2026-02-01",
      userId: OWNER,
    });
    expect(published?.version.statements[0]?.text).toBe(
      "CURRENT 2026-02-01",
    );

    const failed = await service.readByDate({
      logicalDate: "2026-02-02",
      userId: OWNER,
    });
    expect(failed).toBeNull();

    const list = await service.listJournalDates({ userId: OWNER });
    expect(list.entries.map((entry) => entry.logicalDate)).toEqual([
      "2026-02-01",
    ]);
  });

  it("derives current / updating / outdated from the existing lifecycle semantics (AC #1, #3)", async () => {
    await seedDay("2026-04-01", {
      activityState: "finalized",
      journalSourceRevision: 2,
      sessionSourceRevision: 2,
    });
    await seedDay("2026-04-02", {
      activityState: "quiescent",
      journalSourceRevision: 2,
      sessionSourceRevision: 3,
    });
    await seedDay("2026-04-03", {
      activityState: "finalized",
      journalSourceRevision: 2,
      sessionSourceRevision: 3,
    });
    const service = buildService(database);

    const list = await service.listJournalDates({ userId: OWNER });
    const byDate = Object.fromEntries(
      list.entries.map((entry) => [entry.logicalDate, entry.state]),
    );
    expect(byDate).toEqual({
      "2026-04-01": "current",
      "2026-04-02": "updating",
      "2026-04-03": "outdated",
    });

    const updating = await service.readByDate({
      logicalDate: "2026-04-02",
      userId: OWNER,
    });
    expect(updating?.state).toBe("updating");
    expect(updating?.version.diagnosticStatus).toBe("available");
  });

  it("keeps published journals readable when diagnostics are unavailable (AC #3)", async () => {
    await seedDay("2026-05-01", {
      diagnosticStatus: "unavailable",
      text: "PUBLISHED WITHOUT DIAGNOSTICS",
    });
    const service = buildService(database);
    const journal = await service.readByDate({
      logicalDate: "2026-05-01",
      userId: OWNER,
    });
    expect(journal?.version.diagnosticStatus).toBe("unavailable");
    expect(journal?.version.statements[0]?.text).toBe(
      "PUBLISHED WITHOUT DIAGNOSTICS",
    );
  });

  it("does not expose superseded versions or purged content (AC #7)", async () => {
    const seeded = await seedDay("2026-06-01", { text: "CURRENT VERSION" });
    // A second, non-current version that must never be surfaced.
    const located = await database.pool.query<{
      evidence_source_snapshot_id: string;
      source_revision: string;
    }>(
      `SELECT evidence_source_snapshot_id, source_revision
       FROM journal_versions WHERE journal_version_id = $1`,
      [seeded.versionId],
    );
    const snapshotId = located.rows[0]!.evidence_source_snapshot_id;
    const supersededRevision = Number(located.rows[0]!.source_revision) + 5;
    const supersededCommandId = randomUUID();
    const supersededAttemptId = randomUUID();
    const supersededVersionId = randomUUID();
    await database.pool.query(
      `INSERT INTO journal_generation_commands (
         generation_command_id, user_id, daily_session_id, source_revision,
         generation_policy_version, expected_data_epoch, created_at)
       VALUES ($1, $2, $3, $4, 'journal-generation:v3', 1, now())`,
      [supersededCommandId, OWNER, seeded.dailySessionId, supersededRevision],
    );
    await database.pool.query(
      `INSERT INTO journal_model_run_attempts (
         model_run_attempt_id, generation_command_id, role, provider, model,
         config_version, role_policy_version, prompt_fingerprint, status, created_at)
       VALUES ($1, $2, 'journal.draft', 'deterministic', 'test', 'cfg',
         'policy', 'fp', 'completed', now())`,
      [supersededAttemptId, supersededCommandId],
    );
    await database.pool.query(
      `INSERT INTO journal_versions (
         journal_version_id, journal_id, user_id, daily_session_id,
         source_revision, generation_policy_version, validator_version, locale,
         evidence_source_snapshot_id, status, generation_command_id,
         model_run_attempt_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'journal-generation:v3', 'journal-validator:v3',
         'en-US', $6, 'stale', $7, $8, now())`,
      [
        supersededVersionId,
        seeded.journalId,
        OWNER,
        seeded.dailySessionId,
        supersededRevision,
        snapshotId,
        supersededCommandId,
        supersededAttemptId,
      ],
    );
    await database.pool.query(
      `INSERT INTO journal_statements (
         journal_statement_id, journal_version_id, statement_index,
         statement_key, statement_text, user_id, source_revision,
         evidence_source_snapshot_id)
       VALUES ($1, $2, 0, 's1', 'SUPERSEDED VERSION', $3, $4, $5)`,
      [
        randomUUID(),
        supersededVersionId,
        OWNER,
        supersededRevision,
        snapshotId,
      ],
    );

    await seedDay("2026-06-02", { purged: true, text: "PURGED" });
    const service = buildService(database);

    const current = await service.readByDate({
      logicalDate: "2026-06-01",
      userId: OWNER,
    });
    expect(current?.version.statements).toHaveLength(1);
    expect(current?.version.statements[0]?.text).toBe("CURRENT VERSION");
    expect(JSON.stringify(current)).not.toContain("SUPERSEDED VERSION");

    const purged = await service.readByDate({
      logicalDate: "2026-06-02",
      userId: OWNER,
    });
    expect(purged).toBeNull();
    const list = await service.listJournalDates({ userId: OWNER });
    expect(list.entries.map((entry) => entry.logicalDate)).not.toContain(
      "2026-06-02",
    );
  });

  it("scopes every read to the authenticated owner (AC #7)", async () => {
    await seedDay("2026-07-01");
    const service = buildService(database);
    const foreignUser = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc69");

    await expect(
      service.listJournalDates({ userId: foreignUser }),
    ).resolves.toEqual({ entries: [], nextCursor: null });
    await expect(
      service.readByDate({ logicalDate: "2026-07-01", userId: foreignUser }),
    ).resolves.toBeNull();
  });

  it("fails closed on an invalid date and on a closed recovery gate (AC #7)", async () => {
    await seedDay("2026-08-01");
    const service = buildService(database);
    await expect(
      service.readByDate({ logicalDate: "2026-02-30", userId: OWNER }),
    ).rejects.toBeInstanceOf(InvalidJournalDateError);

    const closed = buildService(database, closedGate);
    await expect(
      closed.listJournalDates({ userId: OWNER }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
    await expect(
      closed.readByDate({ logicalDate: "2026-08-01", userId: OWNER }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
  });

  it("stops exposing journals once the owner is no longer active (epoch fence) (AC #7)", async () => {
    await seedDay("2026-09-01");
    const service = buildService(database);
    await expect(
      service.readByDate({ logicalDate: "2026-09-01", userId: OWNER }),
    ).resolves.not.toBeNull();

    await database.pool.query(
      "UPDATE app_users SET status = 'disabled', data_epoch = data_epoch + 1 WHERE user_id = $1",
      [OWNER],
    );
    await expect(
      service.readByDate({ logicalDate: "2026-09-01", userId: OWNER }),
    ).resolves.toBeNull();
    await expect(
      service.listJournalDates({ userId: OWNER }),
    ).resolves.toEqual({ entries: [], nextCursor: null });
  });

  it("serves the list through the read-only BFF and rejects owner identifiers", async () => {
    await seedDay("2026-10-01");
    const service = buildService(database);
    const listHandler = createJournalDateListHandler({
      async authenticate() {
        return { userId: OWNER };
      },
      service,
    });

    const ok = await listHandler(
      new Request("http://localhost/api/internal/journals"),
    );
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { entries: unknown[] };
    expect(payload.entries).toHaveLength(1);

    const unauthorized = await createJournalDateListHandler({
      async authenticate() {
        return null;
      },
      service,
    })(new Request("http://localhost/api/internal/journals"));
    expect(unauthorized.status).toBe(401);

    const withOwner = await listHandler(
      new Request("http://localhost/api/internal/journals?user_id=other"),
    );
    expect(withOwner.status).toBe(400);
    expect(await withOwner.json()).toEqual({
      error: "client_owner_identifier_not_allowed",
    });

    const badCursor = await listHandler(
      new Request("http://localhost/api/internal/journals?cursor=not-a-cursor"),
    );
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: "invalid_cursor" });
  });
});
