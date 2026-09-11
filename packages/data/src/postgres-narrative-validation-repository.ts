import type {
  GenerationCommandId,
  ModelRunAttemptId,
  NarrativeValidatorRequestId,
  NarrativeValidatorResultId,
  UserId,
} from "@sayhear/domain";
import {
  asGenerationCommandId,
  asModelRunAttemptId,
  asNarrativeValidatorRequestId,
  asNarrativeValidatorResultId,
  asUserId,
} from "@sayhear/domain";
import type {
  NarrativeArtifactKind,
  NarrativeAttemptContext,
  NarrativeFinding,
  NarrativeValidationCoverage,
  NarrativeValidationRecord,
  NarrativeValidationRepository,
  NarrativeValidationRequest,
  NarrativeValidationResult,
  NarrativeValidationResultRecord,
} from "@sayhear/application";
import { NARRATIVE_VALIDATION_CONTENT_EXPIRY_DAYS } from "@sayhear/application";
import { createUuidV7 } from "./uuid-v7";
import { modelRoleAttemptIsRunning } from "./postgres-model-role-attempt-fence";
import type { Pool } from "pg";

type RequestRow = Readonly<{
  narrative_validator_request_id: string;
  user_id: string;
  artifact_kind: string;
  draft_ref: string;
  draft_locale: string | null;
  draft_text: string | null;
  generator_manifest: unknown;
  source_manifest: unknown;
  planned_coverage: unknown;
  request_fingerprint: string;
  validation_policy_version: string;
  prompt_version: string;
  schema_version: string;
  created_at: Date;
  content_purged_at: Date | null;
}>;

type ResultRow = Readonly<{
  narrative_validator_result_id: string;
  narrative_validator_request_id: string;
  user_id: string;
  artifact_kind: string;
  generation_command_id: string;
  model_run_attempt_id: string;
  verdict: string;
  blocking_findings: unknown;
  advisory_findings: unknown;
  coverage: unknown;
  validation_policy_version: string;
  schema_version: string;
  prompt_version: string;
  created_at: Date;
  content_purged_at: Date | null;
}>;

function jsonValue<T>(value: unknown, field: string): T {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Narrative validator ${field} is not a JSON object.`);
  }
  return value as T;
}

function findingsValue(value: unknown): readonly NarrativeFinding[] {
  if (!Array.isArray(value)) {
    throw new Error("Narrative validator findings are not a JSON array.");
  }
  return value as NarrativeFinding[];
}

function coverageValue(value: unknown): NarrativeValidationCoverage {
  const coverage = jsonValue<Record<string, unknown>>(value, "coverage");
  if (
    !Array.isArray(coverage.coveredKeys) ||
    !Array.isArray(coverage.uncoveredPlannedKeys)
  ) {
    throw new Error("Narrative validator coverage is malformed.");
  }
  return {
    coveredKeys: coverage.coveredKeys as string[],
    uncoveredPlannedKeys: coverage.uncoveredPlannedKeys as string[],
  };
}

function requestRecordFromRow(row: RequestRow): NarrativeValidationRecord {
  if (row.draft_text === null) {
    throw new Error("Narrative validator request content is purged.");
  }
  return {
    narrativeValidatorRequestId: asNarrativeValidatorRequestId(
      row.narrative_validator_request_id,
    ),
    userId: asUserId(row.user_id),
    artifactKind: row.artifact_kind as NarrativeArtifactKind,
    draftRef: row.draft_ref,
    requestFingerprint: row.request_fingerprint,
    validationPolicyVersion: row.validation_policy_version,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    frozenRequest: {
      userId: asUserId(row.user_id),
      artifactKind: row.artifact_kind as NarrativeArtifactKind,
      draftRef: row.draft_ref,
      draftLocale: row.draft_locale,
      draftText: row.draft_text,
      generatorManifest: jsonValue<
        NarrativeValidationRequest["generatorManifest"]
      >(row.generator_manifest, "generator_manifest"),
      sourceEntries: jsonValue<
        NarrativeValidationRequest["sourceEntries"]
      >(row.source_manifest, "source_manifest"),
      plannedCoverageKeys: jsonValue<
        NarrativeValidationRequest["plannedCoverageKeys"]
      >(row.planned_coverage, "planned_coverage"),
      validationPolicyVersion: row.validation_policy_version,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
    },
    createdAt: row.created_at,
    contentPurgedAt: row.content_purged_at,
  };
}

function resultRecordFromRow(row: ResultRow): NarrativeValidationResultRecord {
  if (row.blocking_findings === null || row.advisory_findings === null) {
    throw new Error("Narrative validator result content is purged.");
  }
  return {
    narrativeValidatorResultId: asNarrativeValidatorResultId(
      row.narrative_validator_result_id,
    ),
    narrativeValidatorRequestId: asNarrativeValidatorRequestId(
      row.narrative_validator_request_id,
    ),
    userId: asUserId(row.user_id),
    generationCommandId: asGenerationCommandId(row.generation_command_id),
    modelRunAttemptId: asModelRunAttemptId(row.model_run_attempt_id),
    result: {
      outcome: row.verdict as NarrativeValidationResult["outcome"],
      artifactKind: row.artifact_kind as NarrativeArtifactKind,
      blockingFindings: findingsValue(row.blocking_findings),
      advisoryFindings: findingsValue(row.advisory_findings),
      coverage: coverageValue(row.coverage),
      validationPolicyVersion: row.validation_policy_version,
      schemaVersion: row.schema_version,
      promptVersion: row.prompt_version,
    },
    createdAt: row.created_at,
    contentPurgedAt: row.content_purged_at,
  };
}

function artifactKindForSubjectType(subjectType: string): string | null {
  if (subjectType === "bio_version") return "bio";
  if (subjectType === "reflection") return "reflection";
  return null;
}

export class PostgresNarrativeValidationRepository
  implements NarrativeValidationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async submitRequest(input: {
    userId: UserId;
    request: NarrativeValidationRequest;
    requestFingerprint: string;
    expectedDataEpoch: number;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "created"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "reused"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "owner_missing" }>
    | Readonly<{ outcome: "data_epoch"; expectedDataEpoch: number }>
    | Readonly<{ outcome: "intent_conflict" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string; data_epoch: string }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        await client.query("ROLLBACK");
        return { outcome: "owner_missing" };
      }
      if (Number(ownerRow.data_epoch) !== input.expectedDataEpoch) {
        await client.query("ROLLBACK");
        return {
          outcome: "data_epoch",
          expectedDataEpoch: input.expectedDataEpoch,
        };
      }

      const inserted = await client.query<{ inserted: boolean }>(
        `INSERT INTO narrative_validator_requests (
           narrative_validator_request_id, user_id, artifact_kind, draft_ref,
           draft_locale, draft_text, generator_manifest, source_manifest,
           planned_coverage, request_fingerprint, validation_policy_version,
           prompt_version, schema_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                    $10, $11, $12, $13, $14)
         ON CONFLICT (user_id, artifact_kind, draft_ref) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [
          createUuidV7(input.now),
          input.userId,
          input.request.artifactKind,
          input.request.draftRef,
          input.request.draftLocale,
          input.request.draftText,
          JSON.stringify(input.request.generatorManifest),
          JSON.stringify(input.request.sourceEntries),
          JSON.stringify(input.request.plannedCoverageKeys),
          input.requestFingerprint,
          input.request.validationPolicyVersion,
          input.request.promptVersion,
          input.request.schemaVersion,
          input.now,
        ],
      );
      const insertedNew = inserted.rows[0]?.inserted === true;

      const existing = await client.query<RequestRow>(
        `SELECT narrative_validator_request_id, user_id, artifact_kind,
                draft_ref, draft_locale, draft_text, generator_manifest,
                source_manifest, planned_coverage, request_fingerprint,
                validation_policy_version, prompt_version, schema_version,
                created_at, content_purged_at
         FROM narrative_validator_requests
         WHERE user_id = $1 AND artifact_kind = $2 AND draft_ref = $3`,
        [input.userId, input.request.artifactKind, input.request.draftRef],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { outcome: "owner_missing" };
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        // A different frozen intent already owns this draft locator: a
        // terminal intent conflict, not an epoch/stale fence (AC-4 typed
        // failures). Revalidation requires a new draft revision.
        await client.query("ROLLBACK");
        return { outcome: "intent_conflict" };
      }
      await client.query("COMMIT");
      const record = requestRecordFromRow(row);
      return insertedNew
        ? { outcome: "created", request: record }
        : { outcome: "reused", request: record };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readAttemptContext(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }): Promise<NarrativeAttemptContext> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<{
        user_id: string;
        subject_type: string;
        subject_id: string;
        expected_data_epoch: string;
      }>(
        `SELECT gc.user_id, gc.subject_type, gc.subject_id,
                gc.expected_data_epoch::text
         FROM generation_commands gc
         WHERE gc.generation_command_id = $1
           AND gc.model_role = 'narrative.validate'`,
        [input.generationCommandId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const attempt = await client.query<{ status: string; attempt_no: number }>(
        `SELECT status, attempt_no FROM model_run_attempts
         WHERE model_run_attempt_id = $1
           AND generation_command_id = $2`,
        [input.modelRunAttemptId, input.generationCommandId],
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow || attemptRow.status !== "prepared") {
        await client.query("COMMIT");
        return { outcome: "settled" };
      }
      const artifactKind = artifactKindForSubjectType(commandRow.subject_type);
      if (!artifactKind) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const request = await client.query<RequestRow>(
        `SELECT narrative_validator_request_id, user_id, artifact_kind,
                draft_ref, draft_locale, draft_text, generator_manifest,
                source_manifest, planned_coverage, request_fingerprint,
                validation_policy_version, prompt_version, schema_version,
                created_at, content_purged_at
         FROM narrative_validator_requests
         WHERE narrative_validator_request_id = $2
           AND artifact_kind = $1
           AND user_id = $3`,
        [artifactKind, commandRow.subject_id, commandRow.user_id],
      );
      const requestRow = request.rows[0];
      if (!requestRow || requestRow.content_purged_at !== null) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      await client.query("COMMIT");
      return {
        outcome: "evaluated",
        narrativeValidatorRequestId: asNarrativeValidatorRequestId(
          requestRow.narrative_validator_request_id,
        ),
        request: requestRecordFromRow(requestRow).frozenRequest,
        expectedDataEpoch: Number(commandRow.expected_data_epoch),
        attemptNo: attemptRow.attempt_no,
        attemptStatus: "prepared",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async commitResult(input: {
    narrativeValidatorRequestId: NarrativeValidatorRequestId;
    userId: UserId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    result: NarrativeValidationResult;
  }): Promise<
    | Readonly<{ outcome: "committed"; resultId: NarrativeValidatorResultId }>
    | Readonly<{ outcome: "already_committed" }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await modelRoleAttemptIsRunning(client, input))) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "attempt_settled" };
      }
      const request = await client.query<{ user_id: string; content_purged_at: Date | null }>(
        `SELECT user_id, content_purged_at
         FROM narrative_validator_requests
         WHERE narrative_validator_request_id = $1 FOR UPDATE`,
        [input.narrativeValidatorRequestId],
      );
      const requestRow = request.rows[0];
      if (!requestRow) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "request_missing" };
      }
      if (requestRow.user_id !== input.userId) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "owner" };
      }
      const owner = await client.query<{ status: string; data_epoch: string }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [requestRow.user_id],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "owner" };
      }
      // The active rollout pin is re-verified at the commit fence: a pin
      // revoked between the provider call and this commit fails closed
      // (ADR-0131/ADR-0132 source/owner/epoch/pin fences).
      const activePin = await client.query<{ rollout_pin: string }>(
        `SELECT rollout_pin FROM model_role_rollout_pins
         WHERE role = 'narrative.validate' AND status = 'active'
         ORDER BY activated_at DESC LIMIT 1`,
      );
      if (!activePin.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "rollout_pin" };
      }

      const existing = await client.query<{ narrative_validator_result_id: string }>(
        `SELECT narrative_validator_result_id FROM narrative_validator_results
         WHERE narrative_validator_request_id = $1`,
        [input.narrativeValidatorRequestId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { outcome: "already_committed" };
      }

      const resultId = asNarrativeValidatorResultId(createUuidV7(new Date()));
      await client.query(
        `INSERT INTO narrative_validator_results (
           narrative_validator_result_id, narrative_validator_request_id,
           user_id, generation_command_id, model_run_attempt_id, verdict,
           blocking_findings, advisory_findings, coverage,
           validation_policy_version, schema_version, prompt_version,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                    $10, $11, $12, $13)`,
        [
          resultId,
          input.narrativeValidatorRequestId,
          requestRow.user_id,
          input.generationCommandId,
          input.modelRunAttemptId,
          input.result.outcome,
          JSON.stringify(input.result.blockingFindings),
          JSON.stringify(input.result.advisoryFindings),
          JSON.stringify(input.result.coverage),
          input.result.validationPolicyVersion,
          input.result.schemaVersion,
          input.result.promptVersion,
          new Date(),
        ],
      );
      await client.query("COMMIT");
      return { outcome: "committed", resultId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readResult(input: {
    userId: UserId;
    artifactKind: NarrativeArtifactKind;
    draftRef: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "ok"; result: NarrativeValidationResultRecord }>
    | Readonly<{ outcome: "incomplete" }>
    | Readonly<{ outcome: "content_expired" }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const request = await client.query<RequestRow>(
        `SELECT narrative_validator_request_id, user_id, artifact_kind,
                draft_ref, draft_locale, draft_text, generator_manifest,
                source_manifest, planned_coverage, request_fingerprint,
                validation_policy_version, prompt_version, schema_version,
                created_at, content_purged_at
         FROM narrative_validator_requests
         WHERE user_id = $1 AND artifact_kind = $2 AND draft_ref = $3`,
        [input.userId, input.artifactKind, input.draftRef],
      );
      const requestRow = request.rows[0];
      if (!requestRow) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const expiryCutoff = new Date(
        input.now.getTime() -
          NARRATIVE_VALIDATION_CONTENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      );
      if (
        requestRow.content_purged_at !== null ||
        requestRow.created_at < expiryCutoff
      ) {
        // The retention deadline is enforced on the read path; it never
        // waits for the maintenance sweeper (ADR-0130).
        await client.query("COMMIT");
        return { outcome: "content_expired" };
      }
      const result = await client.query<ResultRow>(
        `SELECT result.narrative_validator_result_id,
                result.narrative_validator_request_id,
                result.user_id, request.artifact_kind,
                result.generation_command_id, result.model_run_attempt_id,
                result.verdict, result.blocking_findings,
                result.advisory_findings, result.coverage,
                result.validation_policy_version, result.schema_version,
                result.prompt_version, result.created_at,
                result.content_purged_at
         FROM narrative_validator_results result
         INNER JOIN narrative_validator_requests request
           ON request.narrative_validator_request_id =
                result.narrative_validator_request_id
         WHERE result.narrative_validator_request_id = $1`,
        [requestRow.narrative_validator_request_id],
      );
      const resultRow = result.rows[0];
      if (!resultRow) {
        // The frozen request exists but no validator command has completed:
        // the typed "validator not finished" outcome (ADR-0132).
        await client.query("COMMIT");
        return { outcome: "incomplete" };
      }
      await client.query("COMMIT");
      return { outcome: "ok", result: resultRecordFromRow(resultRow) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async purgeExpiredContent(input: {
    now: Date;
    limit: number;
  }): Promise<number> {
    const cutoff = new Date(
      input.now.getTime() -
        NARRATIVE_VALIDATION_CONTENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requests = await client.query<{ id: string }>(
        `SELECT narrative_validator_request_id AS id
         FROM narrative_validator_requests
         WHERE created_at < $1 AND content_purged_at IS NULL
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE`,
        [cutoff, input.limit],
      );
      let purged = 0;
      for (const row of requests.rows) {
        await client.query(
          `UPDATE narrative_validator_requests
           SET draft_text = NULL, generator_manifest = NULL,
               source_manifest = NULL, planned_coverage = NULL,
               content_purged_at = $2
           WHERE narrative_validator_request_id = $1`,
          [row.id, input.now],
        );
        await client.query(
          `UPDATE narrative_validator_results
           SET blocking_findings = NULL, advisory_findings = NULL,
               coverage = NULL, content_purged_at = $2
           WHERE narrative_validator_request_id = $1
             AND content_purged_at IS NULL`,
          [row.id, input.now],
        );
        purged += 1;
      }
      await client.query("COMMIT");
      return purged;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readRequest(input: {
    userId: UserId;
    artifactKind: NarrativeArtifactKind;
    draftRef: string;
  }): Promise<
    | Readonly<{ outcome: "ok"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<RequestRow>(
        `SELECT narrative_validator_request_id, user_id, artifact_kind,
                draft_ref, draft_locale, draft_text, generator_manifest,
                source_manifest, planned_coverage, request_fingerprint,
                validation_policy_version, prompt_version, schema_version,
                created_at, content_purged_at
         FROM narrative_validator_requests
         WHERE user_id = $1 AND artifact_kind = $2 AND draft_ref = $3`,
        [input.userId, input.artifactKind, input.draftRef],
      );
      const row = request.rows[0];
      if (!row || row.content_purged_at !== null) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      await client.query("COMMIT");
      return { outcome: "ok", request: requestRecordFromRow(row) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
