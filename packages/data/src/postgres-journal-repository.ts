import type {
  JournalEvidenceReference,
  JournalRepository,
  JournalSourceSnapshot,
} from "@sayhear/application";
import type { Pool } from "pg";

import { createUuidV7 } from "./uuid-v7";

export class PostgresJournalRepository implements JournalRepository {
  public constructor(private readonly pool: Pool) {}

  public async readSource(input: { dailySessionId: string; sourceRevision: number; expectedDataEpoch: number; extractionPolicyVersion: string }): Promise<JournalSourceSnapshot | null> {
    const rows = await this.pool.query<{
      evidence_source_snapshot_id: string; user_id: string; source_revision: string; evidence_item_id: string;
      source_event_id: string; source_revision_id: string; source_status: "final" | "corrected";
      locator_type: JournalEvidenceReference["locatorType"]; locator_key: string;
      evidence_role: JournalEvidenceReference["role"]; extraction_policy_version: string;
      canonical_text: string | null; locale: string | null;
      }>(`SELECT snapshot.evidence_source_snapshot_id, snapshot.user_id, snapshot.source_revision, item.evidence_item_id,
          item.source_event_id, item.source_revision_id, item.source_status,
          item.locator_type, item.locator_key, item.evidence_role,
          item.extraction_policy_version,
          revision.canonical_text, revision.locale
        FROM evidence_source_snapshots snapshot
        LEFT JOIN evidence_items item ON item.evidence_source_snapshot_id = snapshot.evidence_source_snapshot_id
        LEFT JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = item.source_revision_id
        INNER JOIN app_users owner ON owner.user_id = snapshot.user_id
        WHERE snapshot.daily_session_id = $1 AND snapshot.source_revision = $2
          AND owner.status = 'active' AND owner.data_epoch = $3
          AND item.extraction_policy_version = $4
          AND (item.evidence_item_id IS NULL OR (item.status = 'active' AND revision.content_purged_at IS NULL))
        ORDER BY item.created_at`, [input.dailySessionId, input.sourceRevision, input.expectedDataEpoch, input.extractionPolicyVersion]);
    const first = rows.rows[0];
    if (!first) return null;
    const owner = await this.pool.query<{ data_epoch: string }>("SELECT data_epoch::text FROM app_users WHERE user_id = $1", [first.user_id]);
    const sourceTextByEvidenceId: Record<string, string> = {};
    for (const row of rows.rows) {
      if (!row.evidence_item_id || row.canonical_text === null) continue;
      const evidenceText = textAtLocator(row.canonical_text, row.locator_type, row.locator_key);
      if (!evidenceText) return null;
      sourceTextByEvidenceId[row.evidence_item_id] = evidenceText;
    }
    return {
      sourceSnapshotId: first.evidence_source_snapshot_id,
      dailySessionId: input.dailySessionId,
      userId: first.user_id,
      sourceRevision: Number(first.source_revision),
      extractionPolicyVersion: input.extractionPolicyVersion,
      ...(owner.rows[0] ? { dataEpoch: Number(owner.rows[0].data_epoch) } : {}),
      locale: first.locale ?? "en-US",
      sourceTextByEvidenceId,
      evidenceItems: rows.rows.filter((row) => row.evidence_item_id).map((row) => ({
        id: row.evidence_item_id, sourceEventId: row.source_event_id,
        sourceRevisionId: row.source_revision_id, sourceActor: "user",
        sourceStatus: row.source_status, locatorType: row.locator_type,
        locatorKey: row.locator_key, role: row.evidence_role,
      })),
    };
  }

  public async startGeneration(input: Parameters<JournalRepository["startGeneration"]>[0]): Promise<{ accepted: boolean; generationCommandId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ user_id: string; status: string; data_epoch: string; source_revision: string; activity_state: string }>(
        `SELECT session.user_id, owner.status, owner.data_epoch::text, session.source_revision, session.activity_state
         FROM daily_sessions session INNER JOIN app_users owner ON owner.user_id = session.user_id
         WHERE session.daily_session_id = $1 FOR UPDATE`, [input.dailySessionId],
      );
      const row = owner.rows[0];
      const generationKind = input.generationKind ?? "automatic";
      if (!row || row.user_id !== input.userId || row.status !== "active" || Number(row.data_epoch) !== input.expectedDataEpoch ||
        Number(row.source_revision) !== input.sourceRevision ||
        (generationKind !== "regeneration" && row.activity_state === "active")) {
        await client.query("ROLLBACK"); return { accepted: false, generationCommandId: input.generationCommandId };
      }
      let existing: { generation_command_id: string } | undefined;
      if (generationKind === "regeneration") {
        if (!input.actionExecutionId) {
          await client.query("ROLLBACK");
          return { accepted: false, generationCommandId: input.generationCommandId };
        }
        existing = (await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE action_execution_id = $1 AND user_id = $2 AND daily_session_id = $3
             AND source_revision = $4 AND generation_policy_version = $5
             AND generation_kind = 'regeneration'
           FOR UPDATE`,
          [input.actionExecutionId, input.userId, input.dailySessionId, input.sourceRevision, input.generationPolicyVersion],
        )).rows[0];
      } else {
        const inserted = await client.query<{ generation_command_id: string }>(
          `INSERT INTO journal_generation_commands (generation_command_id, user_id, daily_session_id, source_revision,
            generation_policy_version, expected_data_epoch, generation_kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'automatic', CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, daily_session_id, source_revision, generation_policy_version)
           WHERE generation_kind = 'automatic' DO NOTHING
           RETURNING generation_command_id`,
          [input.generationCommandId, input.userId, input.dailySessionId, input.sourceRevision, input.generationPolicyVersion, input.expectedDataEpoch],
        );
        existing = inserted.rows[0] ?? (await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE user_id = $1 AND daily_session_id = $2 AND source_revision = $3
             AND generation_policy_version = $4 AND generation_kind = 'automatic'`,
          [input.userId, input.dailySessionId, input.sourceRevision, input.generationPolicyVersion],
        )).rows[0];
      }
      if (!existing) { await client.query("ROLLBACK"); return { accepted: false, generationCommandId: input.generationCommandId }; }
      const attempt = await client.query<{ generation_command_id: string; status: "started" | "completed" | "failed" }>(
        `SELECT generation_command_id, status FROM journal_model_run_attempts WHERE model_run_attempt_id = $1`,
        [input.modelRunAttemptId],
      );
      if (attempt.rows[0] && attempt.rows[0].generation_command_id !== existing.generation_command_id) {
        await client.query("ROLLBACK"); return { accepted: false, generationCommandId: existing.generation_command_id };
      }
      if (attempt.rows[0]?.status !== undefined && attempt.rows[0].status !== "started") {
        await client.query("ROLLBACK"); return { accepted: false, generationCommandId: existing.generation_command_id };
      }
      await client.query(
        `INSERT INTO journal_model_run_attempts (model_run_attempt_id, generation_command_id, role, provider, model, config_version, role_policy_version, prompt_fingerprint, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'started', CURRENT_TIMESTAMP) ON CONFLICT (model_run_attempt_id) DO NOTHING`,
        [input.modelRunAttemptId, existing.generation_command_id, input.role, input.provider, input.model, input.configVersion, input.rolePolicyVersion, input.promptFingerprint],
      );
      await client.query("COMMIT");
      return { accepted: true, generationCommandId: existing.generation_command_id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async publish(input: Parameters<JournalRepository["publish"]>[0]): ReturnType<JournalRepository["publish"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = new Date();
      const session = await client.query<{ user_id: string; source_revision: string; activity_state: string }>(
        "SELECT user_id, source_revision, activity_state FROM daily_sessions WHERE daily_session_id = $1 FOR UPDATE",
        [input.dailySessionId],
      );
      const row = session.rows[0];
      const generationKind = input.generationKind ?? "automatic";
      if (!row || row.user_id !== input.userId || Number(row.source_revision) !== input.sourceRevision ||
        (generationKind !== "regeneration" && row.activity_state === "active")) {
        await client.query("ROLLBACK"); return { outcome: "stale" };
      }
      const owner = await client.query<{ status: string; data_epoch: string }>("SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE", [row.user_id]);
      if (!owner.rows[0] || owner.rows[0].status !== "active" || Number(owner.rows[0].data_epoch) !== input.expectedDataEpoch) {
        await client.query("ROLLBACK"); return { outcome: "fenced" };
      }
      const attemptState = await client.query<{ generation_command_id: string; status: "started" | "completed" | "failed" }>(
        "SELECT generation_command_id, status FROM journal_model_run_attempts WHERE model_run_attempt_id = $1 FOR UPDATE",
        [input.modelRunAttemptId],
      );
      const attemptRow = attemptState.rows[0];
      if (!attemptRow || attemptRow.generation_command_id !== input.generationCommandId) {
        await client.query("ROLLBACK"); return { outcome: "fenced" };
      }
      if (attemptRow.status === "completed") { await client.query("ROLLBACK"); return { outcome: "published" }; }
      if (attemptRow.status !== "started") { await client.query("ROLLBACK"); return { outcome: "fenced" }; }
      let generationCommandId = input.generationCommandId;
      if (generationKind === "regeneration") {
        const regenerationCommand = await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE generation_command_id = $1 AND user_id = $2 AND daily_session_id = $3
             AND source_revision = $4 AND generation_policy_version = $5
             AND generation_kind = 'regeneration'
             AND action_execution_id = $6
           FOR UPDATE`,
          [input.generationCommandId, input.userId, input.dailySessionId, input.sourceRevision,
            input.generationPolicyVersion, input.actionExecutionId ?? null],
        );
        if (!regenerationCommand.rows[0]) {
          await client.query("ROLLBACK");
          return { outcome: "fenced" };
        }
      } else {
        const generationCommand = await client.query<{ generation_command_id: string }>(
          `INSERT INTO journal_generation_commands (generation_command_id, user_id, daily_session_id, source_revision,
            generation_policy_version, expected_data_epoch, generation_kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'automatic', $7)
           ON CONFLICT (user_id, daily_session_id, source_revision, generation_policy_version)
           WHERE generation_kind = 'automatic' DO NOTHING
           RETURNING generation_command_id`,
          [input.generationCommandId, input.userId, input.dailySessionId, input.sourceRevision,
            input.generationPolicyVersion, input.expectedDataEpoch, now],
        );
        if (!generationCommand.rows[0]) {
        const existingCommand = await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE user_id = $1 AND daily_session_id = $2 AND source_revision = $3
             AND generation_policy_version = $4 AND generation_kind = 'automatic' FOR UPDATE`,
          [input.userId, input.dailySessionId, input.sourceRevision, input.generationPolicyVersion],
        );
        generationCommandId = existingCommand.rows[0]?.generation_command_id ?? input.generationCommandId;
        }
      }
      await client.query(
        `INSERT INTO journal_model_run_attempts (model_run_attempt_id, generation_command_id, status, created_at)
         VALUES ($1, $2, 'completed', $3) ON CONFLICT (model_run_attempt_id) DO NOTHING`,
        [input.modelRunAttemptId, generationCommandId, now],
      );
      await client.query(
        `UPDATE journal_model_run_attempts SET status = 'completed', provider_completed_at = $3,
           result_metadata = jsonb_build_object('outcome', 'published')
         WHERE model_run_attempt_id = $1 AND generation_command_id = $2 AND status = 'started'`,
        [input.modelRunAttemptId, generationCommandId, now],
      );
      let journal = await client.query<{ journal_id: string; current_version_id: string | null }>(
        `INSERT INTO journals (journal_id, user_id, daily_session_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (daily_session_id) DO NOTHING
         RETURNING journal_id, current_version_id`, [createUuidV7(now), input.userId, input.dailySessionId, now],
      );
      if (!journal.rows[0]) {
        journal = await client.query<{ journal_id: string; current_version_id: string | null }>(
          "SELECT journal_id, current_version_id FROM journals WHERE daily_session_id = $1 FOR UPDATE",
          [input.dailySessionId],
        );
      }
      if (!journal.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "fenced" };
      }
      if (generationKind === "regeneration") {
        const target = await client.query<{
          target_id: string;
          target_version_id: string;
          user_id: string;
        }>(
          `SELECT target_id, target_version_id, user_id
           FROM conversation_action_executions
           WHERE action_execution_id = $1
           FOR SHARE`,
          [input.actionExecutionId ?? null],
        );
        const frozenTarget = target.rows[0];
        if (
          !frozenTarget ||
          frozenTarget.user_id !== input.userId ||
          frozenTarget.target_id !== journal.rows[0].journal_id ||
          frozenTarget.target_version_id !== input.targetVersionId ||
          journal.rows[0].current_version_id !== frozenTarget.target_version_id
        ) {
          await client.query("ROLLBACK");
          return { outcome: "stale" };
        }
      }
      const versionValues = [createUuidV7(now), journal.rows[0]!.journal_id, input.userId, input.dailySessionId, input.sourceRevision,
        input.generationPolicyVersion, input.validatorVersion, input.locale, input.sourceSnapshotId,
        generationCommandId, input.modelRunAttemptId, journal.rows[0]!.current_version_id, now];
      let version = generationKind === "regeneration"
        ? await client.query<{ journal_version_id: string; inserted: boolean }>(
          `INSERT INTO journal_versions (journal_version_id, journal_id, user_id, daily_session_id,
            source_revision, generation_policy_version, validator_version, locale, evidence_source_snapshot_id, status,
            generation_command_id, model_run_attempt_id, supersedes_version_id, generation_kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', $10, $11, $12, 'regeneration', $13)
           ON CONFLICT (journal_id, generation_command_id) DO NOTHING
           RETURNING journal_version_id, (xmax = 0) AS inserted`,
          versionValues,
        )
        : await client.query<{ journal_version_id: string; inserted: boolean }>(
          `INSERT INTO journal_versions (journal_version_id, journal_id, user_id, daily_session_id,
            source_revision, generation_policy_version, validator_version, locale, evidence_source_snapshot_id, status,
            generation_command_id, model_run_attempt_id, supersedes_version_id, generation_kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', $10, $11, $12, 'automatic', $13)
           ON CONFLICT (journal_id, source_revision, generation_policy_version)
           WHERE generation_kind = 'automatic'
           DO NOTHING
           RETURNING journal_version_id, (xmax = 0) AS inserted`,
          versionValues,
        );
      if (!version.rows[0]) {
        version = generationKind === "regeneration"
          ? await client.query<{ journal_version_id: string; inserted: boolean }>(
            `SELECT journal_version_id, FALSE AS inserted FROM journal_versions
             WHERE journal_id = $1 AND generation_command_id = $2`,
            [journal.rows[0]!.journal_id, generationCommandId],
          )
          : await client.query<{ journal_version_id: string; inserted: boolean }>(
            `SELECT journal_version_id, FALSE AS inserted FROM journal_versions
             WHERE journal_id = $1 AND source_revision = $2 AND generation_policy_version = $3
               AND generation_kind = 'automatic'`,
            [journal.rows[0]!.journal_id, input.sourceRevision, input.generationPolicyVersion],
          );
        await client.query("COMMIT");
        return { outcome: "published" };
      }
      for (const [index, statement] of input.statements.entries()) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO journal_statements (journal_statement_id, journal_version_id, statement_index,
            statement_key, statement_text, epistemic_status, user_id, source_revision, evidence_source_snapshot_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING journal_statement_id AS id`,
          [createUuidV7(now), version.rows[0]!.journal_version_id, index, statement.id, statement.text, statement.epistemicStatus, input.userId, input.sourceRevision, input.sourceSnapshotId],
        );
        for (const evidenceId of statement.evidenceItemIds) {
          await client.query(`INSERT INTO journal_statement_evidence_links (journal_statement_id, evidence_item_id, user_id, source_revision, evidence_source_snapshot_id, evidence_role)
            SELECT $1, evidence_item_id, user_id, $5, evidence_source_snapshot_id, evidence_role FROM evidence_items
            WHERE evidence_item_id = $2 AND user_id = $3 AND evidence_source_snapshot_id = $4`,
            [created.rows[0]!.id, evidenceId, input.userId, input.sourceSnapshotId, input.sourceRevision]);
        }
      }
      await client.query(
        `INSERT INTO journal_model_run_attempts (
           model_run_attempt_id, generation_command_id, role, provider, model, config_version,
           role_policy_version, prompt_fingerprint, status, provider_completed_at, result_metadata, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9,
           jsonb_build_object('outcome', 'validated'), $9)
         ON CONFLICT (model_run_attempt_id) DO NOTHING`,
        [input.validationAttemptId, generationCommandId, input.validatorRole, input.validatorProvider,
          input.validatorModel, input.validatorConfigVersion, input.validatorPolicyVersion,
          input.validatorPromptFingerprint, now],
      );
      await client.query(
        `INSERT INTO journal_validation_results (journal_validation_result_id, journal_version_id, daily_session_id,
          source_revision, generation_command_id, model_run_attempt_id, programmatic_valid, model_valid,
          status, validator_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, 'validated', $8, $9)`,
        [createUuidV7(now), version.rows[0]!.journal_version_id, input.dailySessionId, input.sourceRevision,
          generationCommandId, input.validationAttemptId, input.modelValid, input.validatorVersion, now],
      );
      await client.query("UPDATE journals SET current_version_id = $1 WHERE journal_id = $2", [version.rows[0]!.journal_version_id, journal.rows[0]!.journal_id]);
      await client.query(
        `UPDATE daily_session_date_outcomes
         SET outcome = 'journal_available', computed_at = $3
         WHERE daily_session_id = $1 AND source_revision = $2
           AND outcome = 'eligible_queued'`,
        [input.dailySessionId, input.sourceRevision, now],
      );
      await client.query("COMMIT");
      return { outcome: "published" };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async recordWorkflowOutcome(input: NonNullable<JournalRepository["recordWorkflowOutcome"]> extends (arg: infer T) => Promise<void> ? T : never): Promise<void> {
    await this.pool.query(
      `INSERT INTO journal_workflow_outcomes (workflow_command_id, user_id, daily_session_id, source_revision,
        expected_data_epoch, outcome, reason, created_at)
       VALUES ($1,COALESCE($2::uuid,(SELECT user_id FROM daily_sessions WHERE daily_session_id = $3)),$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
       ON CONFLICT (workflow_command_id) DO UPDATE
         SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason
         WHERE journal_workflow_outcomes.outcome = 'retryable_failed'
           AND EXCLUDED.outcome IN ('needs_review', 'published')`,
      [input.workflowCommandId, input.userId, input.dailySessionId, input.sourceRevision, input.expectedDataEpoch, input.outcome, input.reason],
    );
  }

  public async recordValidationFailure(input: Parameters<NonNullable<JournalRepository["recordValidationFailure"]>>[0]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ user_id: string; status: string; data_epoch: string }>(
        `SELECT session.user_id, owner.status, owner.data_epoch::text
         FROM daily_sessions session INNER JOIN app_users owner ON owner.user_id = session.user_id
         WHERE session.daily_session_id = $1 AND session.source_revision = $2 FOR UPDATE`,
        [input.dailySessionId, input.sourceRevision],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active" || Number(ownerRow.data_epoch) !== input.expectedDataEpoch) {
        await client.query("ROLLBACK"); return;
      }
      if (input.generationKind !== "regeneration") {
        await client.query(
          `INSERT INTO journal_generation_commands (generation_command_id, user_id, daily_session_id, source_revision,
            generation_policy_version, expected_data_epoch, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, daily_session_id, source_revision, generation_policy_version)
           WHERE generation_kind = 'automatic' DO NOTHING`,
          [input.generationCommandId, ownerRow.user_id, input.dailySessionId, input.sourceRevision,
            input.generationPolicyVersion, input.expectedDataEpoch],
        );
      }
      const command = input.generationKind === "regeneration"
        ? await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE generation_command_id = $1 AND user_id = $2 AND daily_session_id = $3
             AND source_revision = $4 AND generation_policy_version = $5
             AND generation_kind = 'regeneration' AND action_execution_id = $6`,
          [input.generationCommandId, ownerRow.user_id, input.dailySessionId, input.sourceRevision,
            input.generationPolicyVersion, input.actionExecutionId ?? null],
        )
        : await client.query<{ generation_command_id: string }>(
          `SELECT generation_command_id FROM journal_generation_commands
           WHERE user_id = $1 AND daily_session_id = $2 AND source_revision = $3
             AND generation_policy_version = $4 AND generation_kind = 'automatic'`,
          [ownerRow.user_id, input.dailySessionId, input.sourceRevision, input.generationPolicyVersion],
        );
      const generationCommandId = command.rows[0]?.generation_command_id ?? input.generationCommandId;
      const attemptState = await client.query<{ generation_command_id: string; status: "started" | "completed" | "failed" }>(
        "SELECT generation_command_id, status FROM journal_model_run_attempts WHERE model_run_attempt_id = $1 FOR UPDATE",
        [input.modelRunAttemptId],
      );
      const attemptRow = attemptState.rows[0];
      if (!attemptRow || attemptRow.generation_command_id !== generationCommandId || attemptRow.status !== "started") {
        await client.query("ROLLBACK"); return;
      }
      await client.query(
        `INSERT INTO journal_model_run_attempts (model_run_attempt_id, generation_command_id, status, created_at)
         VALUES ($1, $2, 'failed', CURRENT_TIMESTAMP) ON CONFLICT (model_run_attempt_id) DO NOTHING`,
        [input.modelRunAttemptId, generationCommandId],
      );
      await client.query(
        `UPDATE journal_model_run_attempts SET status = 'failed', provider_completed_at = CURRENT_TIMESTAMP,
           result_metadata = jsonb_build_object('outcome', 'validation_failed', 'failure_code', $3::text)
         WHERE model_run_attempt_id = $1 AND generation_command_id = $2 AND status = 'started'`,
        [input.modelRunAttemptId, generationCommandId, input.failureCode],
      );
      const validationAttemptId = input.validationAttemptId;
      if (validationAttemptId && input.validatorRole && input.validatorProvider && input.validatorModel && input.validatorConfigVersion && input.validatorPolicyVersion && input.validatorPromptFingerprint) {
        await client.query(
          `INSERT INTO journal_model_run_attempts (
             model_run_attempt_id, generation_command_id, role, provider, model, config_version,
             role_policy_version, prompt_fingerprint, status, provider_completed_at, result_metadata, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', CURRENT_TIMESTAMP,
             jsonb_build_object('outcome', 'validation_failed', 'failure_code', $9::text), CURRENT_TIMESTAMP)
           ON CONFLICT (model_run_attempt_id) DO NOTHING`,
          [validationAttemptId, generationCommandId, input.validatorRole, input.validatorProvider,
            input.validatorModel, input.validatorConfigVersion, input.validatorPolicyVersion,
            input.validatorPromptFingerprint, input.failureCode],
        );
      }
      await client.query(
        `INSERT INTO journal_validation_results (journal_validation_result_id, journal_version_id, daily_session_id, source_revision,
           generation_command_id, model_run_attempt_id, programmatic_valid, model_valid, failure_code, status, validator_version, created_at)
         VALUES ($1, NULL, $2, $3, $4, $5, FALSE, FALSE, $6, 'needs_review', $7, CURRENT_TIMESTAMP)
         ON CONFLICT (daily_session_id, source_revision, generation_command_id, failure_code, status) DO NOTHING`,
        [createUuidV7(new Date()), input.dailySessionId, input.sourceRevision, generationCommandId,
          validationAttemptId ?? input.modelRunAttemptId, input.failureCode, input.validatorVersion],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async readCurrent(input: { dailySessionId: string; userId: string }): Promise<import("@sayhear/application").JournalDraft | null> {
    const result = await this.pool.query<{ journal_version_id: string; evidence_source_snapshot_id: string; extraction_policy_version: string; champion_config_version: string; champion_provider: string; champion_model: string; champion_snapshot: string; champion_provider_policy_version: string; source_revision: string; generation_command_id: string; model_run_attempt_id: string; validation_status: "validated" | "validation_failed" | "needs_review" | null; validation_failure_code: string | null; provider_role: string; provider: string; model: string; config_version: string; role_policy_version: string; prompt_fingerprint: string; provider_completed_at: Date | null; result_metadata: Record<string, unknown>; locale: string; statement_key: string; statement_text: string; epistemic_status: "supported_expression" | "inferred_observation"; evidence_item_id: string; source_event_id: string; source_revision_id: string; source_status: "final" | "corrected"; locator_type: JournalEvidenceReference["locatorType"]; locator_key: string; evidence_role: JournalEvidenceReference["role"] }>(
      `SELECT version.journal_version_id, version.evidence_source_snapshot_id, snapshot.extraction_policy_version,
         snapshot.champion_config_version, snapshot.champion_provider, snapshot.champion_model, snapshot.champion_snapshot, snapshot.champion_provider_policy_version,
         version.source_revision, version.generation_command_id, version.model_run_attempt_id,
         validation.status AS validation_status, validation.failure_code AS validation_failure_code,
         attempt.role AS provider_role, attempt.provider, attempt.model, attempt.config_version, attempt.role_policy_version, attempt.prompt_fingerprint, attempt.provider_completed_at, attempt.result_metadata,
         version.locale, statement.statement_key, statement.statement_text, statement.epistemic_status,
         link.evidence_item_id, evidence.source_event_id, evidence.source_revision_id, evidence.source_status,
         evidence.locator_type, evidence.locator_key, evidence.evidence_role
       FROM journals journal
       INNER JOIN journal_versions version ON version.journal_version_id = journal.current_version_id
       INNER JOIN evidence_source_snapshots snapshot ON snapshot.evidence_source_snapshot_id = version.evidence_source_snapshot_id
       INNER JOIN journal_statements statement ON statement.journal_version_id = version.journal_version_id
       INNER JOIN journal_statement_evidence_links link ON link.journal_statement_id = statement.journal_statement_id
       INNER JOIN evidence_items evidence ON evidence.evidence_item_id = link.evidence_item_id
         AND evidence.user_id = link.user_id
         AND evidence.evidence_source_snapshot_id = link.evidence_source_snapshot_id
       INNER JOIN conversation_event_revisions source ON source.conversation_event_revision_id = evidence.source_revision_id
       INNER JOIN app_users owner ON owner.user_id = journal.user_id
       LEFT JOIN journal_validation_results validation ON validation.journal_version_id = version.journal_version_id
       INNER JOIN journal_model_run_attempts attempt ON attempt.model_run_attempt_id = version.model_run_attempt_id
       WHERE journal.daily_session_id = $1
         AND journal.user_id = $2
         AND owner.status = 'active'
         AND evidence.status = 'active'
         AND source.content_purged_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM journal_statements version_statement
           INNER JOIN journal_statement_evidence_links version_link
             ON version_link.journal_statement_id = version_statement.journal_statement_id
           INNER JOIN evidence_items version_evidence
             ON version_evidence.evidence_item_id = version_link.evidence_item_id
           INNER JOIN conversation_event_revisions version_source
             ON version_source.conversation_event_revision_id = version_evidence.source_revision_id
           WHERE version_statement.journal_version_id = version.journal_version_id
             AND (version_evidence.status <> 'active' OR version_source.content_purged_at IS NOT NULL)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM journal_statement_evidence_links invalid_link
           INNER JOIN evidence_items invalid_evidence
             ON invalid_evidence.evidence_item_id = invalid_link.evidence_item_id
           INNER JOIN conversation_event_revisions invalid_source
             ON invalid_source.conversation_event_revision_id = invalid_evidence.source_revision_id
           WHERE invalid_link.journal_statement_id = statement.journal_statement_id
             AND (invalid_evidence.status <> 'active' OR invalid_source.content_purged_at IS NOT NULL)
         )
       ORDER BY statement.statement_index`, [input.dailySessionId, input.userId],
    );
    if (!result.rows[0]) return null;
    return {
      journalVersionId: result.rows[0].journal_version_id,
      sourceSnapshotId: result.rows[0].evidence_source_snapshot_id,
      extractionPolicyVersion: result.rows[0].extraction_policy_version,
      evidenceChampion: {
        configVersion: result.rows[0].champion_config_version,
        provider: result.rows[0].champion_provider,
        model: result.rows[0].champion_model,
        snapshot: result.rows[0].champion_snapshot,
        providerPolicyVersion: result.rows[0].champion_provider_policy_version,
      },
      sourceRevision: Number(result.rows[0].source_revision),
      generationCommandId: result.rows[0].generation_command_id,
      modelRunAttemptId: result.rows[0].model_run_attempt_id,
      validationStatus: result.rows[0].validation_status ?? "validated",
      validationFailureCode: result.rows[0].validation_failure_code,
      providerRole: result.rows[0].provider_role,
      provider: result.rows[0].provider,
      model: result.rows[0].model,
      configVersion: result.rows[0].config_version,
      rolePolicyVersion: result.rows[0].role_policy_version,
      promptFingerprint: result.rows[0].prompt_fingerprint,
      providerCompletedAt: result.rows[0].provider_completed_at?.toISOString() ?? null,
      resultMetadata: result.rows[0].result_metadata,
      locale: result.rows[0].locale,
      evidenceItems: [...new Map(result.rows.map((row) => [row.evidence_item_id, {
        id: row.evidence_item_id, sourceEventId: row.source_event_id, sourceRevisionId: row.source_revision_id,
        sourceActor: "user" as const, sourceStatus: row.source_status, locatorType: row.locator_type,
        locatorKey: row.locator_key, role: row.evidence_role,
      }])).values()],
      statements: [...new Map(result.rows.map((row) => [row.statement_key, row])).values()].map((row) => ({
        id: row.statement_key,
        text: row.statement_text,
        epistemicStatus: row.epistemic_status,
        evidenceItemIds: result.rows.filter((candidate) => candidate.statement_key === row.statement_key && candidate.evidence_item_id).map((candidate) => candidate.evidence_item_id!),
      })),
    };
  }

  public async readLatestCurrent(input: { userId: string }): Promise<import("@sayhear/application").CurrentJournal | null> {
    const session = await this.pool.query<{ daily_session_id: string; logical_date: string; activity_state: "active" | "quiescent" | "finalized"; source_revision: string; journal_source_revision: string }>(
      `SELECT journal.daily_session_id, daily_session.logical_date::text,
          daily_session.activity_state, daily_session.source_revision::text,
          version.source_revision::text AS journal_source_revision
       FROM journals journal
       INNER JOIN daily_sessions daily_session
         ON daily_session.daily_session_id = journal.daily_session_id
         AND daily_session.user_id = journal.user_id
       INNER JOIN journal_versions version ON version.journal_version_id = journal.current_version_id
       INNER JOIN app_users owner ON owner.user_id = journal.user_id
       WHERE journal.user_id = $1
         AND journal.current_version_id IS NOT NULL
         AND journal.deleted_at IS NULL
         AND owner.status = 'active'
       ORDER BY daily_session.logical_date DESC, journal.created_at DESC
       LIMIT 1`,
      [input.userId],
    );
    const row = session.rows[0];
    if (!row) return null;
    const journal = await this.readCurrent({
      dailySessionId: row.daily_session_id,
      userId: input.userId,
    });
    return journal
      ? {
          dailySessionId: row.daily_session_id,
          logicalDate: row.logical_date,
          state: Number(row.source_revision) === Number(row.journal_source_revision)
            ? "current"
            : row.activity_state === "quiescent" ? "updating" : "outdated",
          version: { locale: journal.locale, statements: journal.statements },
        }
      : null;
  }
}

function textAtLocator(sourceText: string, locatorType: JournalEvidenceReference["locatorType"], locatorKey: string): string | null {
  if (locatorType === "whole_revision") return sourceText;
  if (locatorType !== "text_span") return null;
  const match = /^(\d+):(\d+)$/.exec(locatorKey);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > sourceText.length) return null;
  const span = sourceText.slice(start, end).trim();
  return span || null;
}
