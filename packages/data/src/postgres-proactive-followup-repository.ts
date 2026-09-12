import {
  planProactiveFollowupCooldownRelease,
  planProactiveFollowupDisposition,
  planProactiveFollowupRelease,
  PROACTIVE_FOLLOWUP_COMMIT_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR,
  PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
  PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_STOP_SIGNALS,
  PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION,
  type ProactiveFollowupDispositionInput,
  type ProactiveFollowupReleaseInput,
  type ProactiveFollowupSelectionManifest,
  type ProactiveFollowupStateSnapshot,
  type ProactiveFollowupTargetKind,
  type ProactiveFollowupTextLocator,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";

type OwnerFenceInput = Readonly<{
  userId: string;
  expectedDataEpoch: number;
}>;

export type ProactiveFollowupTargetInput = Readonly<{
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
}>;

export type ProactiveFollowupReservationResult = Readonly<
  | ({ outcome: "reserved" | "already_reserved" } & ProactiveFollowupTargetInput & {
      reservationId: string;
    })
  | { outcome: "fenced"; reason: string }
>;

export type ProactiveFollowupUseCommitInput = Readonly<{
  userId: string;
  expectedDataEpoch: number;
  reservationId: string;
  mainGenerationCommandId: string;
  segmentGenerationCommandId: string;
  compiledContextId: string;
  promptUserEventRevisionId: string;
  promptUserEventSequence: number;
  assistantEventId: string;
  assistantEventRevisionId: string;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  expressionKind: "question" | "acknowledgment";
  finalTextLocator: ProactiveFollowupTextLocator;
  selectionPolicyVersion: string;
  promptPolicyVersion: string;
  policyBundleVersion: string;
  policyBundle: Readonly<Record<string, unknown>>;
  useId?: string;
  now: Date;
}>;

export type ProactiveFollowupUseCommitResult = Readonly<
  | { outcome: "committed" | "already_committed"; useId: string }
  | { outcome: "fenced"; reason: string }
>;

export type ProactiveFollowupDispositionResult = Readonly<
  | { outcome: "recorded" | "already_recorded"; stateVersionId: string | null }
  | { outcome: "fenced"; reason: string }
>;

type StateRow = Readonly<{
  state_id: string;
  state_version_id: string;
  target_kind: ProactiveFollowupTargetKind;
  target_id: string;
  target_version_id: string;
  eligibility_status: "eligible" | "suppressed";
  suppression_reason: ProactiveFollowupStateSnapshot["suppressionReason"];
  consecutive_soft_stop_count: number;
  suppressed_until_at: string | null;
  release_reason: ProactiveFollowupStateSnapshot["releaseReason"];
  trigger_user_event_revision_id: string | null;
  last_prompt_event_revision_id: string | null;
  last_response_event_revision_id: string | null;
  last_used_at: string | null;
}>;

type UseRow = Readonly<{
  proactive_followup_use_id: string;
  user_id: string;
  expected_data_epoch: string;
  daily_session_id: string;
  continuous_exchange_no: number;
  target_kind: ProactiveFollowupTargetKind;
  target_id: string;
  target_version_id: string;
  prompt_user_event_revision_id: string;
  prompt_user_event_sequence: string;
  prompt_user_event_id: string;
  prompt_user_event_created_at: Date;
  final_text_locator: unknown;
}>;

const MAX_SERIALIZATION_RETRIES = 3;

function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "40001" ||
      (error as { code?: unknown }).code === "40P01")
  );
}

async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (attempt === MAX_SERIALIZATION_RETRIES || !isRetryableTransactionError(error)) {
        throw error;
      }
    } finally {
      client.release();
    }
  }
  throw new Error("unreachable_transaction_retry_state");
}

async function ownerFence(
  client: PoolClient,
  input: OwnerFenceInput,
): Promise<string | null> {
  const result = await client.query<{ status: string; data_epoch: string }>(
    `SELECT status, data_epoch::text
     FROM app_users
     WHERE user_id = $1
     FOR UPDATE`,
    [input.userId],
  );
  const owner = result.rows[0];
  if (!owner) return "owner_missing";
  if (owner.status !== "active") return "owner_inactive";
  if (Number(owner.data_epoch) !== input.expectedDataEpoch) return "data_epoch";
  return null;
}

function targetKey(input: ProactiveFollowupTargetInput): readonly [string, string, string] {
  return [input.targetKind, input.targetId, input.targetVersionId];
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Expected JSON-serializable proactive metadata.");
  return encoded;
}

function sameTextLocator(
  stored: unknown,
  expected: ProactiveFollowupTextLocator,
): boolean {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return false;
  }
  const locator = stored as Record<string, unknown>;
  return (
    locator.kind === expected.kind &&
    locator.assistantEventRevisionId === expected.assistantEventRevisionId &&
    locator.segment === expected.segment &&
    locator.ordinal === expected.ordinal
  );
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

function numberField(value: unknown, key: string): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : null;
}

function mapState(row: StateRow): ProactiveFollowupStateSnapshot {
  return {
    stateId: row.state_id,
    stateVersionId: row.state_version_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetVersionId: row.target_version_id,
    eligibilityStatus: row.eligibility_status,
    suppressionReason: row.suppression_reason,
    consecutiveSoftStopCount: row.consecutive_soft_stop_count,
    suppressedUntilAt: row.suppressed_until_at,
    lastPromptEventRevisionId: row.last_prompt_event_revision_id,
    lastResponseEventRevisionId: row.last_response_event_revision_id,
    lastUsedAt: row.last_used_at,
    releaseReason: row.release_reason,
  };
}

async function loadState(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    forUpdate?: boolean;
  }>,
): Promise<ProactiveFollowupStateSnapshot | null> {
  const result = await client.query<StateRow>(
    `SELECT s.proactive_followup_state_id AS state_id,
            v.proactive_followup_state_version_id AS state_version_id,
            v.target_kind, v.target_id, v.target_version_id,
            v.eligibility_status, v.suppression_reason,
            v.consecutive_soft_stop_count, v.suppressed_until_at::text,
            v.release_reason, v.trigger_user_event_revision_id,
            v.last_prompt_event_revision_id, v.last_response_event_revision_id,
            v.last_used_at::text
     FROM proactive_followup_states s
     INNER JOIN proactive_followup_state_versions v
       ON v.proactive_followup_state_version_id = s.current_version_id
       AND v.proactive_followup_state_id = s.proactive_followup_state_id
       AND v.user_id = s.user_id
     WHERE s.user_id = $1 AND s.target_kind = $2 AND s.target_id = $3
     ${input.forUpdate ? "FOR UPDATE OF s" : ""}`,
    [input.userId, input.targetKind, input.targetId],
  );
  const row = result.rows[0];
  return row ? mapState(row) : null;
}

async function appendStateVersion(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    stateId: string;
    previousStateVersionId: string | null;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    eligibilityStatus: "eligible" | "suppressed";
    suppressionReason: ProactiveFollowupStateSnapshot["suppressionReason"];
    consecutiveSoftStopCount: number;
    suppressedUntilAt: string | null;
    releaseReason: ProactiveFollowupStateSnapshot["releaseReason"];
    triggerUserEventRevisionId: string | null;
    lastPromptEventRevisionId: string | null;
    lastResponseEventRevisionId: string | null;
    lastUsedAt: string | null;
    triggerExchangeNo: number | null;
    now: Date;
  }>,
): Promise<string> {
  const revision = await client.query<{ next_revision: number }>(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
     FROM proactive_followup_state_versions
     WHERE proactive_followup_state_id = $1 AND user_id = $2`,
    [input.stateId, input.userId],
  );
  const stateVersionId = createUuidV7(input.now);
  await client.query(
    `INSERT INTO proactive_followup_state_versions (
       proactive_followup_state_version_id, proactive_followup_state_id,
       user_id, revision, target_kind, target_id, target_version_id,
       eligibility_status, suppression_reason, consecutive_soft_stop_count,
       suppressed_until_at, release_reason, trigger_user_event_revision_id,
       last_prompt_event_revision_id, last_response_event_revision_id,
       last_used_at, trigger_exchange_no, policy_version, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      stateVersionId,
      input.stateId,
      input.userId,
      revision.rows[0]?.next_revision ?? 1,
      input.targetKind,
      input.targetId,
      input.targetVersionId,
      input.eligibilityStatus,
      input.suppressionReason,
      input.consecutiveSoftStopCount,
      input.suppressedUntilAt,
      input.releaseReason,
      input.triggerUserEventRevisionId,
      input.lastPromptEventRevisionId,
      input.lastResponseEventRevisionId,
      input.lastUsedAt,
      input.triggerExchangeNo,
      PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
      input.now,
    ],
  );
  const pointer = await client.query(
    `UPDATE proactive_followup_states
     SET current_version_id = $2
     WHERE proactive_followup_state_id = $1
       AND user_id = $3
       AND current_version_id IS NOT DISTINCT FROM $4`,
    [input.stateId, stateVersionId, input.userId, input.previousStateVersionId],
  );
  if (pointer.rowCount !== 1) {
    throw new Error("proactive_followup_state_pointer_cas_failed");
  }
  return stateVersionId;
}

async function targetIsCurrent(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    now: Date;
  }>,
): Promise<boolean> {
  if (input.targetKind === "open_loop") {
    const result = await client.query(
      `SELECT 1
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
         AND v.open_loop_version_id = $3
         AND v.user_id = l.user_id
       INNER JOIN evidence_items evidence
         ON evidence.evidence_item_id = v.source_evidence_item_id
         AND evidence.user_id = l.user_id
         AND evidence.status = 'active'
       WHERE l.user_id = $1 AND l.open_loop_id = $2
         AND l.deleted_at IS NULL
         AND v.status = 'open'
         AND v.content_purged_at IS NULL
         AND v.followup_eligible_from_at <= $4::timestamptz
         AND $4::timestamptz < v.expires_at`,
      [input.userId, input.targetId, input.targetVersionId, input.now.toISOString()],
    );
    return result.rows.length === 1;
  }
  const result = await client.query(
    `SELECT 1
     FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
       AND version.memory_claim_version_id = $3
       AND version.user_id = claim.user_id
     INNER JOIN entities subject_entity
       ON subject_entity.entity_id = claim.subject_entity_id
       AND subject_entity.user_id = claim.user_id
     INNER JOIN entity_versions subject_version
       ON subject_version.entity_version_id = subject_entity.current_version_id
       AND subject_version.user_id = claim.user_id
     INNER JOIN entity_versions subject_claim_version
       ON subject_claim_version.entity_version_id = version.subject_entity_version_id
       AND subject_claim_version.user_id = claim.user_id
     LEFT JOIN entities object_entity
       ON object_entity.entity_id = claim.object_entity_id
       AND object_entity.user_id = claim.user_id
     LEFT JOIN entity_versions object_version
       ON object_version.entity_version_id = object_entity.current_version_id
       AND object_version.user_id = claim.user_id
     LEFT JOIN entity_versions object_claim_version
       ON object_claim_version.entity_version_id = version.object_entity_version_id
       AND object_claim_version.user_id = claim.user_id
     WHERE claim.user_id = $1 AND claim.memory_claim_id = $2
       AND claim.deleted_at IS NULL AND claim.content_purged_at IS NULL
       AND version.status = 'active'
       AND version.epistemic_status <> 'contested'
       AND version.content_purged_at IS NULL
       AND subject_entity.deleted_at IS NULL
       AND subject_version.status = 'active'
       AND subject_version.content_purged_at IS NULL
       AND subject_claim_version.status = 'active'
       AND subject_claim_version.content_purged_at IS NULL
       AND (object_entity.entity_id IS NULL OR (
         object_entity.deleted_at IS NULL
         AND object_version.status IN ('active', 'unresolved')
         AND object_version.content_purged_at IS NULL
         AND object_claim_version.status IN ('active', 'unresolved')
         AND object_claim_version.content_purged_at IS NULL
       ))
       AND NOT EXISTS (
         SELECT 1
         FROM memory_forget_requests forget_request
         WHERE forget_request.user_id = claim.user_id
           AND forget_request.target_claim_id = claim.memory_claim_id
           AND forget_request.target_scope = 'whole_claim'
           AND forget_request.status = 'applied'
           AND NOT EXISTS (
             SELECT 1
             FROM memory_forget_reversals reversal
             WHERE reversal.memory_forget_request_id = forget_request.memory_forget_request_id
               AND reversal.user_id = forget_request.user_id
               AND reversal.status = 'active'
           )
       )
       AND EXISTS (
         SELECT 1
         FROM claim_evidence_links link
         INNER JOIN evidence_items evidence
           ON evidence.evidence_item_id = link.evidence_item_id
           AND evidence.user_id = claim.user_id
           AND evidence.status = 'active'
         WHERE link.memory_claim_version_id = version.memory_claim_version_id
           AND link.user_id = claim.user_id
           AND link.status = 'active'
           AND link.link_role IN ('support', 'subjective_report')
           AND NOT EXISTS (
             SELECT 1
             FROM memory_forget_evidence_exclusions exclusion
             WHERE exclusion.user_id = link.user_id
               AND exclusion.evidence_item_id = link.evidence_item_id
               AND exclusion.status = 'active'
               AND exclusion.exclusion_scope = 'whole_claim'
           )
       )`,
    [input.userId, input.targetId, input.targetVersionId],
  );
  return result.rows.length === 1;
}

async function loadUse(
  client: PoolClient,
  input: Readonly<{ userId: string; useId: string; forUpdate?: boolean }>,
): Promise<UseRow | null> {
  const result = await client.query<UseRow>(
    `SELECT proactive_use.proactive_followup_use_id,
            proactive_use.user_id,
            reservation.expected_data_epoch::text,
            proactive_use.daily_session_id,
            proactive_use.continuous_exchange_no,
            proactive_use.target_kind, proactive_use.target_id,
            proactive_use.target_version_id,
            proactive_use.prompt_user_event_revision_id,
            proactive_use.prompt_user_event_sequence,
            prompt_event.conversation_event_id AS prompt_user_event_id,
            prompt_event.created_at AS prompt_user_event_created_at,
            proactive_use.final_text_locator
     FROM proactive_followup_uses proactive_use
     INNER JOIN proactive_followup_reservations reservation
       ON reservation.proactive_followup_reservation_id =
          proactive_use.proactive_followup_reservation_id
       AND reservation.user_id = proactive_use.user_id
     INNER JOIN conversation_event_revisions prompt_revision
       ON prompt_revision.conversation_event_revision_id =
          proactive_use.prompt_user_event_revision_id
       AND prompt_revision.user_id = proactive_use.user_id
     INNER JOIN conversation_events prompt_event
       ON prompt_event.conversation_event_id = prompt_revision.conversation_event_id
       AND prompt_event.user_id = proactive_use.user_id
     WHERE proactive_use.proactive_followup_use_id = $1
       AND proactive_use.user_id = $2
     ${input.forUpdate ? "FOR UPDATE OF proactive_use, reservation" : ""}`,
    [input.useId, input.userId],
  );
  return result.rows[0] ?? null;
}

function useInput(
  input: Readonly<{
    userId: string;
    now: Date;
    signal: ProactiveFollowupDispositionInput["signal"];
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    currentUserEventRevisionId: string;
    currentUserEventSequence: number;
    currentUserEventExchangeNo: number;
    timeZone: string;
    use: UseRow;
    finalTextLocator: ProactiveFollowupTextLocator;
    state: ProactiveFollowupStateSnapshot | null;
  }>,
): ProactiveFollowupDispositionInput {
  return {
    userId: input.userId,
    now: input.now,
    timeZone: input.timeZone,
    signal: input.signal,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetVersionId: input.targetVersionId,
    currentUserEventRevisionId: input.currentUserEventRevisionId,
    currentUserEventSequence: input.currentUserEventSequence,
    currentUserEventExchangeNo: input.currentUserEventExchangeNo,
    use: {
      useId: input.use.proactive_followup_use_id,
      userId: input.use.user_id,
      targetKind: input.use.target_kind,
      targetId: input.use.target_id,
      targetVersionId: input.use.target_version_id,
      promptUserEventRevisionId: input.use.prompt_user_event_revision_id,
      promptUserEventSequence: Number(input.use.prompt_user_event_sequence),
      exchangeNo: input.use.continuous_exchange_no,
      finalTextLocator: input.finalTextLocator,
    },
    state: input.state,
  };
}

export class PostgresProactiveFollowupRepository {
  public constructor(private readonly pool: Pool) {}

  /** Read path materializes a due cooldown as an eligible state version. */
  public async readState(input: Readonly<{
    userId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    now: Date;
  }>): Promise<ProactiveFollowupStateSnapshot | null> {
    return inTransaction(this.pool, async (client) => {
      const owner = await client.query<{ status: string }>(
        `SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (owner.rows[0]?.status !== "active") return null;
      const current = await loadState(client, {
        ...input,
        forUpdate: true,
      });
      if (
        current?.eligibilityStatus === "suppressed" &&
        current.suppressedUntilAt !== null &&
        Date.parse(current.suppressedUntilAt) <= input.now.getTime()
      ) {
        const release = planProactiveFollowupCooldownRelease({
          now: input.now,
          state: current,
        });
        if (release.outcome === "released") {
          await appendStateVersion(client, {
            userId: input.userId,
            stateId: current.stateId,
            previousStateVersionId: current.stateVersionId,
            targetKind: current.targetKind,
            targetId: current.targetId,
            targetVersionId: current.targetVersionId,
            eligibilityStatus: "eligible",
            suppressionReason: null,
            consecutiveSoftStopCount: current.consecutiveSoftStopCount,
            suppressedUntilAt: null,
            releaseReason: "cooldown_elapsed",
            triggerUserEventRevisionId: null,
            lastPromptEventRevisionId: current.lastPromptEventRevisionId,
            lastResponseEventRevisionId: current.lastResponseEventRevisionId,
            lastUsedAt: current.lastUsedAt,
            triggerExchangeNo: null,
            now: input.now,
          });
          return loadState(client, input);
        }
      }
      return current;
    });
  }

  public async reserveSelection(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    dailySessionId: string;
    continuousExchangeNo: number;
    mainGenerationCommandId: string;
    target: ProactiveFollowupTargetInput;
    manifest: ProactiveFollowupSelectionManifest;
    now: Date;
  }>): Promise<ProactiveFollowupReservationResult> {
    return inTransaction(this.pool, async (client) => {
      const fence = await ownerFence(client, input);
      if (fence) return { outcome: "fenced", reason: fence };
      const selected = input.manifest.selectedTarget;
      const manifestCandidate = input.manifest.candidates.find(
        (candidate) =>
          candidate.targetKind === input.target.targetKind &&
          candidate.targetId === input.target.targetId &&
          candidate.targetVersionId === input.target.targetVersionId,
      );
      if (
        !Number.isFinite(input.now.getTime()) ||
        input.manifest.manifestVersion !== PROACTIVE_FOLLOWUP_MANIFEST_VERSION ||
        input.manifest.userId !== input.userId ||
        input.manifest.dailySessionId !== input.dailySessionId ||
        input.manifest.continuousExchangeNo !== input.continuousExchangeNo ||
        input.manifest.decision !== "selected" ||
        input.manifest.reservationId !== null ||
        input.manifest.reservationStatus !== "not_reserved" ||
        input.manifest.opportunityMode !== input.manifest.opportunity ||
        input.manifest.opportunityPolicyVersion !==
          PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION ||
        input.manifest.suppressionPolicyVersion !==
          PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION ||
        input.manifest.useSchemaVersion !== PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION ||
        input.manifest.expressionPromptVersion !== PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION ||
        input.manifest.expressionPolicyVersion !== PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION ||
        input.manifest.reasonCodeSchemaVersion !== PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION ||
        input.manifest.currentRequestRequiresFocus.value !== false ||
        !Number.isFinite(input.manifest.currentRequestRequiresFocus.confidence) ||
        input.manifest.currentRequestRequiresFocus.confidence <
          PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR ||
        input.manifest.currentRequestRequiresFocus.freshness !== "current" ||
        !input.manifest.currentRequestRequiresFocus.sourceRevisionIds.includes(
          input.manifest.currentUserEventRevisionId,
        ) ||
        !selected ||
        targetKey(selected).some(
          (value, index) => value !== targetKey(input.target)[index],
        ) ||
        !manifestCandidate ||
        !manifestCandidate.eligible ||
        manifestCandidate.rankTuple === null ||
        input.manifest.selectionPolicyVersion !==
          PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION ||
        input.manifest.policyBundleVersion !== PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION
      ) {
        return { outcome: "fenced", reason: "selection_manifest" };
      }
      const existing = await client.query<{
        proactive_followup_reservation_id: string;
        main_generation_command_id: string;
        target_kind: ProactiveFollowupTargetKind;
        target_id: string;
        target_version_id: string;
        expected_data_epoch: string;
      }>(
        `SELECT proactive_followup_reservation_id, main_generation_command_id,
                target_kind, target_id, target_version_id,
                expected_data_epoch::text
         FROM proactive_followup_reservations
         WHERE daily_session_id = $1 AND user_id = $2
           AND continuous_exchange_no = $3
           AND status IN ('active', 'committed')
         FOR UPDATE`,
        [input.dailySessionId, input.userId, input.continuousExchangeNo],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        return existingRow.expected_data_epoch === String(input.expectedDataEpoch) &&
          existingRow.main_generation_command_id === input.mainGenerationCommandId &&
          existingRow.target_kind === input.target.targetKind &&
          existingRow.target_id === input.target.targetId &&
          existingRow.target_version_id === input.target.targetVersionId
          ? {
              outcome: "already_reserved",
              reservationId: existingRow.proactive_followup_reservation_id,
              targetKind: existingRow.target_kind,
              targetId: existingRow.target_id,
              targetVersionId: existingRow.target_version_id,
            }
          : { outcome: "fenced", reason: "exchange_already_reserved" };
      }
      const mainCommand = await client.query<{
        expected_data_epoch: string;
        input_revision_id: string;
        daily_session_id: string;
        continuous_exchange_no: number;
        event_sequence_no: string;
        event_actor: string;
        event_lifecycle_status: string;
        event_current_revision_id: string | null;
        source_revision: string;
      }>(
        `SELECT command.expected_data_epoch::text, command.input_revision_id,
                turn.daily_session_id, turn.continuous_exchange_no,
                input_event.sequence_no::text AS event_sequence_no,
                input_event.actor AS event_actor,
                input_event.lifecycle_status AS event_lifecycle_status,
                input_event.current_revision_id AS event_current_revision_id,
                session.source_revision::text AS source_revision
         FROM generation_commands command
         INNER JOIN interaction_turns turn
           ON turn.interaction_turn_id = command.interaction_turn_id
           AND turn.user_id = command.user_id
         INNER JOIN daily_sessions session
           ON session.daily_session_id = turn.daily_session_id
           AND session.user_id = turn.user_id
         INNER JOIN conversation_events input_event
           ON input_event.conversation_event_id = command.subject_id
           AND input_event.user_id = command.user_id
         INNER JOIN conversation_event_revisions input_revision
           ON input_revision.conversation_event_revision_id = command.input_revision_id
           AND input_revision.conversation_event_id = input_event.conversation_event_id
           AND input_revision.user_id = input_event.user_id
           AND input_revision.content_purged_at IS NULL
         WHERE command.generation_command_id = $1
           AND command.user_id = $2
           AND command.subject_type = 'conversation_event'
           AND command.input_revision_kind = 'conversation_event_revision'
           AND input_event.actor = 'user'
           AND input_event.lifecycle_status = 'active'
           AND input_event.current_revision_id = command.input_revision_id`,
        [input.mainGenerationCommandId, input.userId],
      );
      const mainRow = mainCommand.rows[0];
      if (
        !mainRow ||
        mainRow.expected_data_epoch !== String(input.expectedDataEpoch) ||
        mainRow.input_revision_id !== input.manifest.currentUserEventRevisionId ||
        mainRow.daily_session_id !== input.dailySessionId ||
        mainRow.continuous_exchange_no !== input.continuousExchangeNo ||
        mainRow.event_sequence_no !== String(input.manifest.currentUserEventSequence) ||
        mainRow.event_current_revision_id !== input.manifest.currentUserEventRevisionId ||
        mainRow.source_revision !== String(input.manifest.currentSourceRevision)
      ) {
        return { outcome: "fenced", reason: "main_command_lineage" };
      }
      const state = await loadState(client, {
        userId: input.userId,
        targetKind: input.target.targetKind,
        targetId: input.target.targetId,
        forUpdate: true,
      });
      if (state?.eligibilityStatus === "suppressed") {
        if (
          state.suppressedUntilAt !== null &&
          Date.parse(state.suppressedUntilAt) <= input.now.getTime()
        ) {
          const release = planProactiveFollowupCooldownRelease({
            now: input.now,
            state,
          });
          if (release.outcome === "released") {
            await appendStateVersion(client, {
              userId: input.userId,
              stateId: state.stateId,
              previousStateVersionId: state.stateVersionId,
              targetKind: state.targetKind,
              targetId: state.targetId,
              targetVersionId: state.targetVersionId,
              eligibilityStatus: "eligible",
              suppressionReason: null,
              consecutiveSoftStopCount: state.consecutiveSoftStopCount,
              suppressedUntilAt: null,
              releaseReason: "cooldown_elapsed",
              triggerUserEventRevisionId: null,
              lastPromptEventRevisionId: state.lastPromptEventRevisionId,
              lastResponseEventRevisionId: state.lastResponseEventRevisionId,
              lastUsedAt: state.lastUsedAt,
              triggerExchangeNo: null,
              now: input.now,
            });
          } else {
            return { outcome: "fenced", reason: "target_suppressed" };
          }
        } else {
          return { outcome: "fenced", reason: "target_suppressed" };
        }
      }
      if (state && state.targetVersionId !== input.target.targetVersionId) {
        return { outcome: "fenced", reason: "state_version" };
      }
      if (!(await targetIsCurrent(client, { ...input.target, userId: input.userId, now: input.now }))) {
        return { outcome: "fenced", reason: "target_not_current" };
      }
      const reservationId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO proactive_followup_reservations (
           proactive_followup_reservation_id, user_id, daily_session_id,
           continuous_exchange_no, main_generation_command_id, target_kind,
           target_id, target_version_id, selection_manifest,
           selection_policy_version, status, expected_data_epoch, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'active',$11,$12)`,
        [
          reservationId,
          input.userId,
          input.dailySessionId,
          input.continuousExchangeNo,
          input.mainGenerationCommandId,
          input.target.targetKind,
          input.target.targetId,
          input.target.targetVersionId,
          json({
            ...input.manifest,
            reservationId,
            reservationStatus: "active",
          }),
          input.manifest.selectionPolicyVersion,
          input.expectedDataEpoch,
          input.now,
        ],
      );
      return {
        outcome: "reserved",
        reservationId,
        ...input.target,
      };
    });
  }

  public async bindSegmentCommand(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    reservationId: string;
    mainGenerationCommandId: string;
    segmentGenerationCommandId: string;
    now: Date;
  }>): Promise<Readonly<{ outcome: "bound" | "already_bound" | "fenced"; reason?: string }>> {
    return inTransaction(this.pool, async (client) => {
      const fence = await ownerFence(client, input);
      if (fence) return { outcome: "fenced", reason: fence };
      const command = await client.query<{ expected_data_epoch: string }>(
        `SELECT expected_data_epoch::text
         FROM generation_commands
         WHERE generation_command_id = $1 AND user_id = $2`,
        [input.segmentGenerationCommandId, input.userId],
      );
      if (
        command.rows.length !== 1 ||
        command.rows[0]?.expected_data_epoch !== String(input.expectedDataEpoch)
      ) {
        return { outcome: "fenced", reason: "segment_command_missing" };
      }
      const reservation = await client.query<{
        status: string;
        expected_data_epoch: string;
        main_generation_command_id: string;
        segment_generation_command_id: string | null;
      }>(
        `SELECT status, expected_data_epoch::text,
                main_generation_command_id, segment_generation_command_id
         FROM proactive_followup_reservations
         WHERE proactive_followup_reservation_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.reservationId, input.userId],
      );
      const row = reservation.rows[0];
      if (
        !row ||
        row.expected_data_epoch !== String(input.expectedDataEpoch) ||
        row.main_generation_command_id !== input.mainGenerationCommandId
      ) {
        return { outcome: "fenced", reason: "reservation_missing" };
      }
      if (row.segment_generation_command_id !== null) {
        return row.segment_generation_command_id === input.segmentGenerationCommandId
          ? { outcome: "already_bound" }
          : { outcome: "fenced", reason: "segment_command_already_bound" };
      }
      if (row.status !== "active") return { outcome: "fenced", reason: "reservation_terminal" };
      await client.query(
        `UPDATE proactive_followup_reservations
         SET segment_generation_command_id = $2
         WHERE proactive_followup_reservation_id = $1 AND user_id = $3
           AND status = 'active' AND segment_generation_command_id IS NULL`,
        [input.reservationId, input.segmentGenerationCommandId, input.userId],
      );
      return { outcome: "bound" };
    });
  }

  /**
   * Terminalize a Segment Command that was prepared but could not pass the
   * final display/use fence. The caller owns the transaction so the main
   * Assistant Event can be committed without the optional segment.
   */
  public async abandonSegmentWithin(
    client: PoolClient,
    input: Readonly<{
      userId: string;
      expectedDataEpoch: number;
      reservationId: string;
      mainGenerationCommandId: string;
      segmentGenerationCommandId: string;
      now: Date;
    }>,
  ): Promise<void> {
    const fence = await ownerFence(client, input);
    if (fence) return;
    await client.query(
      `UPDATE model_run_attempts
       SET status = 'failed', error_category = 'policy_blocked',
           completed_at = $1, recovery_status = 'terminal',
           recovery_claimed_at = NULL
       WHERE model_run_attempt_id IN (
         SELECT model_run_attempt_id
         FROM model_run_attempts
         WHERE generation_command_id = $2 AND user_id = $3
         ORDER BY attempt_no DESC
         LIMIT 1
       )
         AND status IN ('prepared', 'running')`,
      [input.now, input.segmentGenerationCommandId, input.userId],
    );
    await client.query(
      `UPDATE provider_egress_dispositions
       SET status = 'failed', error_category = 'policy_blocked', completed_at = $1
       WHERE model_run_attempt_id = (
         SELECT model_run_attempt_id
         FROM model_run_attempts
         WHERE generation_command_id = $2 AND user_id = $3
         ORDER BY attempt_no DESC
         LIMIT 1
       )
         AND user_id = $3 AND status IN ('dispatched', 'completed')`,
      [input.now, input.segmentGenerationCommandId, input.userId],
    );
    await client.query(
      `UPDATE generation_commands
       SET status = 'failed', recovery_status = 'terminal',
           recovery_checked_at = $1, next_recovery_at = NULL, settled_at = $1
       WHERE generation_command_id = $2 AND user_id = $3
         AND expected_data_epoch = $4
         AND status IN ('prepared', 'running')`,
      [
        input.now,
        input.segmentGenerationCommandId,
        input.userId,
        input.expectedDataEpoch,
      ],
    );
    await client.query(
      `UPDATE proactive_followup_reservations
       SET status = 'abandoned', terminal_at = $1,
           selection_manifest = jsonb_set(
             selection_manifest, '{reservationStatus}', '"abandoned"'::jsonb
           )
       WHERE proactive_followup_reservation_id = $2
         AND user_id = $3
         AND expected_data_epoch = $4
         AND main_generation_command_id = $5
         AND status = 'active'`,
      [
        input.now,
        input.reservationId,
        input.userId,
        input.expectedDataEpoch,
        input.mainGenerationCommandId,
      ],
    );
  }

  /**
   * Called by the response transaction after the Assistant Event revision is
   * inserted. It intentionally does not BEGIN/COMMIT: the caller owns the
   * transaction, so Event + use + usage marker + reservation transition can
   * commit or roll back together.
   */
  public async commitUseWithin(
    client: PoolClient,
    input: ProactiveFollowupUseCommitInput,
  ): Promise<ProactiveFollowupUseCommitResult> {
    const fence = await ownerFence(client, input);
    if (fence) return { outcome: "fenced", reason: fence };
    if (input.selectionPolicyVersion !== PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION) {
      return { outcome: "fenced", reason: "selection_policy_version" };
    }
    if (
      !["question", "acknowledgment"].includes(input.expressionKind) ||
      input.promptPolicyVersion !== PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION ||
      input.policyBundleVersion !== PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION ||
      input.finalTextLocator.kind !== "assistant_event_revision" ||
      input.finalTextLocator.segment !== "proactive_followup" ||
      input.finalTextLocator.ordinal !== 0 ||
      input.finalTextLocator.assistantEventRevisionId !== input.assistantEventRevisionId
    ) {
      return { outcome: "fenced", reason: "use_metadata" };
    }
    const reservation = await client.query<{
      status: string;
      expected_data_epoch: string;
      daily_session_id: string;
      continuous_exchange_no: number;
      main_generation_command_id: string;
      segment_generation_command_id: string | null;
      target_kind: ProactiveFollowupTargetKind;
      target_id: string;
      target_version_id: string;
      committed_use_id: string | null;
      selection_manifest: unknown;
    }>(
      `SELECT status, expected_data_epoch::text, daily_session_id,
              continuous_exchange_no,
              main_generation_command_id, segment_generation_command_id,
              target_kind, target_id, target_version_id, committed_use_id,
              selection_manifest
       FROM proactive_followup_reservations
       WHERE proactive_followup_reservation_id = $1 AND user_id = $2
       FOR UPDATE`,
      [input.reservationId, input.userId],
    );
    const reservationRow = reservation.rows[0];
    if (!reservationRow) return { outcome: "fenced", reason: "reservation_missing" };
    if (
      reservationRow.expected_data_epoch !== String(input.expectedDataEpoch) ||
      reservationRow.main_generation_command_id !== input.mainGenerationCommandId ||
      reservationRow.target_kind !== input.targetKind ||
      reservationRow.target_id !== input.targetId ||
      reservationRow.target_version_id !== input.targetVersionId ||
      (reservationRow.segment_generation_command_id !== null &&
        reservationRow.segment_generation_command_id !== input.segmentGenerationCommandId)
    ) {
      return { outcome: "fenced", reason: "reservation_identity" };
    }
    const manifest = reservationRow.selection_manifest;
    const manifestStatus = stringField(manifest, "reservationStatus");
    const manifestMatchesCommit =
      stringField(manifest, "manifestVersion") === PROACTIVE_FOLLOWUP_MANIFEST_VERSION &&
      stringField(manifest, "reservationId") === input.reservationId &&
      stringField(manifest, "policyBundleVersion") === input.policyBundleVersion &&
      stringField(manifest, "opportunityPolicyVersion") ===
        PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION &&
      stringField(manifest, "selectionPolicyVersion") === input.selectionPolicyVersion &&
      stringField(manifest, "suppressionPolicyVersion") ===
        PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION &&
      stringField(manifest, "useSchemaVersion") === PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION &&
      stringField(manifest, "expressionPromptVersion") === input.promptPolicyVersion &&
      stringField(manifest, "expressionPolicyVersion") ===
        PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION &&
      stringField(manifest, "reasonCodeSchemaVersion") ===
        PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION &&
      stringField(manifest, "currentUserEventRevisionId") ===
        input.promptUserEventRevisionId &&
      numberField(manifest, "currentUserEventSequence") === input.promptUserEventSequence &&
      ((reservationRow.status === "active" && manifestStatus === "active") ||
        (reservationRow.status === "committed" && manifestStatus === "committed"));
    if (!manifestMatchesCommit) {
      return { outcome: "fenced", reason: "manifest_lineage" };
    }
    if (reservationRow.status === "committed" && reservationRow.committed_use_id) {
      return { outcome: "already_committed", useId: reservationRow.committed_use_id };
    }
    if (reservationRow.status !== "active") return { outcome: "fenced", reason: "reservation_terminal" };
    if (!(await targetIsCurrent(client, { ...input, now: input.now }))) {
      return { outcome: "fenced", reason: "target_not_current" };
    }
    const prompt = await client.query<{
      daily_session_id: string;
      sequence_no: string;
      actor: string;
      lifecycle_status: string;
    }>(
      `SELECT event.daily_session_id, event.sequence_no::text, event.actor,
              event.lifecycle_status
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
         AND event.user_id = revision.user_id
       WHERE revision.conversation_event_revision_id = $1
         AND revision.user_id = $2
         AND revision.content_purged_at IS NULL
         AND event.current_revision_id = revision.conversation_event_revision_id`,
      [input.promptUserEventRevisionId, input.userId],
    );
    const promptRow = prompt.rows[0];
    if (
      !promptRow ||
      promptRow.actor !== "user" ||
      promptRow.lifecycle_status !== "active" ||
      promptRow.sequence_no !== String(input.promptUserEventSequence) ||
      promptRow.daily_session_id !== reservationRow.daily_session_id
    ) {
      return { outcome: "fenced", reason: "prompt_event" };
    }
    const assistant = await client.query<{
      daily_session_id: string;
      sequence_no: string;
      generation_command_id: string | null;
      current_revision_id: string | null;
      actor: string;
      lifecycle_status: string;
    }>(
      `SELECT event.daily_session_id, event.sequence_no::text,
              event.generation_command_id, event.current_revision_id,
              event.actor, event.lifecycle_status
       FROM conversation_events event
       WHERE event.conversation_event_id = $1 AND event.user_id = $2`,
      [input.assistantEventId, input.userId],
    );
    const assistantRow = assistant.rows[0];
    if (
      !assistantRow ||
      assistantRow.actor !== "assistant" ||
      assistantRow.lifecycle_status !== "active" ||
      assistantRow.daily_session_id !== reservationRow.daily_session_id ||
      Number(assistantRow.sequence_no) <= input.promptUserEventSequence ||
      assistantRow.generation_command_id !== input.mainGenerationCommandId ||
      assistantRow.current_revision_id !== input.assistantEventRevisionId
    ) {
      return { outcome: "fenced", reason: "assistant_event" };
    }
    const assistantRevision = await client.query(
      `SELECT 1 FROM conversation_event_revisions
       WHERE conversation_event_revision_id = $1
         AND conversation_event_id = $2 AND user_id = $3
         AND content_purged_at IS NULL
         AND created_by = 'provider'
         AND transcript_status = 'final'`,
      [input.assistantEventRevisionId, input.assistantEventId, input.userId],
    );
    if (assistantRevision.rows.length !== 1) {
      return { outcome: "fenced", reason: "assistant_revision" };
    }
    const commandRefs = await client.query(
      `SELECT 1
       FROM generation_commands main_command
       INNER JOIN generation_commands segment_command
         ON segment_command.generation_command_id = $2
         AND segment_command.user_id = main_command.user_id
       INNER JOIN compiled_contexts context
         ON context.compiled_context_id = $3
         AND context.user_id = main_command.user_id
         AND context.generation_command_id = segment_command.generation_command_id
       WHERE main_command.generation_command_id = $1
         AND main_command.user_id = $4
         AND main_command.generation_command_id <> segment_command.generation_command_id
         AND main_command.status = 'succeeded'
         AND segment_command.status = 'succeeded'
         AND main_command.expected_data_epoch = $5
         AND segment_command.expected_data_epoch = $5`,
      [
        input.mainGenerationCommandId,
        input.segmentGenerationCommandId,
        input.compiledContextId,
        input.userId,
        input.expectedDataEpoch,
      ],
    );
    if (commandRefs.rows.length !== 1) return { outcome: "fenced", reason: "lineage" };
    if (reservationRow.segment_generation_command_id === null) {
      const bound = await client.query(
        `UPDATE proactive_followup_reservations
         SET segment_generation_command_id = $2
         WHERE proactive_followup_reservation_id = $1 AND user_id = $3
           AND status = 'active' AND segment_generation_command_id IS NULL`,
        [input.reservationId, input.segmentGenerationCommandId, input.userId],
      );
      if (bound.rowCount !== 1) {
        return { outcome: "fenced", reason: "segment_command_binding" };
      }
    }
    const useId = input.useId ?? createUuidV7(input.now);
    await client.query(
      `INSERT INTO proactive_followup_uses (
         proactive_followup_use_id, user_id, proactive_followup_reservation_id,
         daily_session_id, continuous_exchange_no, main_generation_command_id,
         segment_generation_command_id, compiled_context_id,
         prompt_user_event_revision_id, prompt_user_event_sequence,
         assistant_event_id, assistant_event_revision_id, target_kind, target_id,
         target_version_id, expression_kind, final_text_locator,
         selection_policy_version, prompt_policy_version, policy_bundle, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb,$21)`,
      [
        useId,
        input.userId,
        input.reservationId,
        reservationRow.daily_session_id,
        reservationRow.continuous_exchange_no,
        input.mainGenerationCommandId,
        input.segmentGenerationCommandId,
        input.compiledContextId,
        input.promptUserEventRevisionId,
        input.promptUserEventSequence,
        input.assistantEventId,
        input.assistantEventRevisionId,
        input.targetKind,
        input.targetId,
        input.targetVersionId,
        input.expressionKind,
        json(input.finalTextLocator),
        input.selectionPolicyVersion,
        input.promptPolicyVersion,
        json({
          ...input.policyBundle,
          policyBundleVersion: input.policyBundleVersion,
          commitPolicyVersion: PROACTIVE_FOLLOWUP_COMMIT_POLICY_VERSION,
        }),
        input.now,
      ],
    );
    await client.query(
      `UPDATE proactive_followup_reservations
       SET status = 'committed', committed_use_id = $2, terminal_at = $3,
           selection_manifest = jsonb_set(
             selection_manifest, '{reservationStatus}', '"committed"'::jsonb
           )
       WHERE proactive_followup_reservation_id = $1 AND user_id = $4
         AND status = 'active'`,
      [input.reservationId, useId, input.now, input.userId],
    );
    return { outcome: "committed", useId };
  }

  public async commitUse(input: ProactiveFollowupUseCommitInput): Promise<ProactiveFollowupUseCommitResult> {
    return inTransaction(this.pool, (client) => this.commitUseWithin(client, input));
  }

  public async recordDisposition(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    useId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    triggerUserEventRevisionId: string;
    triggerUserEventSequence: number;
    signal: ProactiveFollowupDispositionInput["signal"];
    finalTextLocator: ProactiveFollowupTextLocator;
    timeZone: string;
    now: Date;
  }>): Promise<ProactiveFollowupDispositionResult> {
    return inTransaction(this.pool, async (client) => {
      const fence = await ownerFence(client, input);
      if (fence) return { outcome: "fenced", reason: fence };
      if (!(PROACTIVE_FOLLOWUP_STOP_SIGNALS as readonly string[]).includes(input.signal)) {
        return { outcome: "fenced", reason: "disposition_signal" };
      }
      const use = await loadUse(client, { userId: input.userId, useId: input.useId, forUpdate: true });
      if (!use) return { outcome: "fenced", reason: "use_missing" };
      if (use.expected_data_epoch !== String(input.expectedDataEpoch)) {
        return { outcome: "fenced", reason: "data_epoch" };
      }
      const existing = await client.query<{
        state_version_id: string | null;
        target_kind: ProactiveFollowupTargetKind;
        target_id: string;
        target_version_id: string;
        signal: string;
        final_text_locator: unknown;
      }>(
        `SELECT state_version_id, target_kind, target_id, target_version_id,
                signal, final_text_locator
         FROM proactive_followup_dispositions
         WHERE proactive_followup_use_id = $1
           AND trigger_user_event_revision_id = $2 AND user_id = $3`,
        [input.useId, input.triggerUserEventRevisionId, input.userId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return row.target_kind === input.targetKind &&
          row.target_id === input.targetId &&
          row.target_version_id === input.targetVersionId &&
          row.signal === input.signal &&
          sameTextLocator(row.final_text_locator, input.finalTextLocator)
          ? { outcome: "already_recorded", stateVersionId: row.state_version_id }
          : { outcome: "fenced", reason: "disposition_identity" };
      }
      if (
        use.target_kind !== input.targetKind ||
        use.target_id !== input.targetId ||
        use.target_version_id !== input.targetVersionId ||
        !sameTextLocator(use.final_text_locator, input.finalTextLocator)
      ) {
        return { outcome: "fenced", reason: "use_identity" };
      }
      const trigger = await client.query<{
        daily_session_id: string;
        continuous_exchange_no: number;
        conversation_event_id: string;
        created_at: Date;
        sequence_no: string;
        actor: string;
        lifecycle_status: string;
      }>(
        `SELECT event.daily_session_id, turn.continuous_exchange_no,
                event.conversation_event_id, event.created_at,
                event.sequence_no::text, event.actor, event.lifecycle_status
         FROM conversation_event_revisions revision
         INNER JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
           AND event.user_id = revision.user_id
         INNER JOIN interaction_turns turn
           ON turn.interaction_turn_id = event.interaction_turn_id
           AND turn.daily_session_id = event.daily_session_id
           AND turn.user_id = event.user_id
         WHERE revision.conversation_event_revision_id = $1
           AND revision.user_id = $2
           AND revision.content_purged_at IS NULL
           AND event.current_revision_id = revision.conversation_event_revision_id`,
        [input.triggerUserEventRevisionId, input.userId],
      );
      const triggerRow = trigger.rows[0];
      if (
        !triggerRow ||
        triggerRow.actor !== "user" ||
        triggerRow.lifecycle_status !== "active" ||
        triggerRow.sequence_no !== String(input.triggerUserEventSequence) ||
        (triggerRow.daily_session_id === use.daily_session_id
          ? Number(triggerRow.sequence_no) <= Number(use.prompt_user_event_sequence)
          : triggerRow.created_at.getTime() < use.prompt_user_event_created_at.getTime() ||
            (triggerRow.created_at.getTime() === use.prompt_user_event_created_at.getTime() &&
              triggerRow.conversation_event_id <= use.prompt_user_event_id))
      ) {
        return { outcome: "fenced", reason: "trigger_event" };
      }
      const earlierUserEvent = await client.query(
        `SELECT 1
         FROM conversation_events earlier_event
         INNER JOIN interaction_turns earlier_turn
           ON earlier_turn.interaction_turn_id = earlier_event.interaction_turn_id
           AND earlier_turn.daily_session_id = earlier_event.daily_session_id
           AND earlier_turn.user_id = earlier_event.user_id
         INNER JOIN conversation_event_revisions earlier_revision
           ON earlier_revision.conversation_event_revision_id = earlier_event.current_revision_id
           AND earlier_revision.conversation_event_id = earlier_event.conversation_event_id
           AND earlier_revision.user_id = earlier_event.user_id
         WHERE earlier_event.user_id = $1
           AND earlier_event.actor = 'user'
           AND earlier_event.lifecycle_status = 'active'
           AND earlier_revision.content_purged_at IS NULL
           AND (
             (
               earlier_event.daily_session_id = $2::uuid
               AND earlier_event.sequence_no > $3::bigint
             )
             OR (
               earlier_event.daily_session_id <> $2::uuid
               AND (
                 earlier_event.created_at > $4::timestamptz
                 OR (
                   earlier_event.created_at = $4::timestamptz
                   AND earlier_event.conversation_event_id > $5::uuid
                 )
               )
             )
           )
           AND (
             (
               earlier_event.daily_session_id = $6::uuid
               AND earlier_event.sequence_no < $7::bigint
             )
             OR (
               earlier_event.daily_session_id <> $6::uuid
               AND (
                 earlier_event.created_at < $8::timestamptz
                 OR (
                   earlier_event.created_at = $8::timestamptz
                   AND earlier_event.conversation_event_id < $9::uuid
                 )
               )
             )
           )
         LIMIT 1`,
        [
          input.userId,
          use.daily_session_id,
          use.prompt_user_event_sequence,
          use.prompt_user_event_created_at,
          use.prompt_user_event_id,
          triggerRow.daily_session_id,
          input.triggerUserEventSequence,
          triggerRow.created_at,
          triggerRow.conversation_event_id,
        ],
      );
      if (earlierUserEvent.rows.length !== 0) {
        return { outcome: "fenced", reason: "trigger_event_not_next" };
      }
      if (!(await targetIsCurrent(client, {
        userId: input.userId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        targetVersionId: input.targetVersionId,
        now: input.now,
      }))) {
        return { outcome: "fenced", reason: "target_not_current" };
      }
      const currentState = await loadState(client, {
        userId: input.userId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        forUpdate: true,
      });
      let plan;
      try {
        plan = planProactiveFollowupDisposition(
          useInput({
            userId: input.userId,
            now: input.now,
            signal: input.signal,
            targetKind: input.targetKind,
            targetId: input.targetId,
            targetVersionId: input.targetVersionId,
            currentUserEventRevisionId: input.triggerUserEventRevisionId,
            currentUserEventSequence: input.triggerUserEventSequence,
            currentUserEventExchangeNo: triggerRow.continuous_exchange_no,
            timeZone: input.timeZone,
            use,
            finalTextLocator: input.finalTextLocator,
            state: currentState,
          }),
        );
      } catch {
        return { outcome: "fenced", reason: "disposition_policy" };
      }
      let stateVersionId: string | null = null;
      if (plan.outcome === "suppressed") {
        const stateId = currentState?.stateId ?? createUuidV7(input.now);
        if (!currentState) {
          await client.query(
            `INSERT INTO proactive_followup_states (
               proactive_followup_state_id, user_id, target_kind, target_id, created_at
             ) VALUES ($1,$2,$3,$4,$5)`,
            [stateId, input.userId, input.targetKind, input.targetId, input.now],
          );
        }
        stateVersionId = await appendStateVersion(client, {
          userId: input.userId,
          stateId,
          previousStateVersionId: currentState?.stateVersionId ?? null,
          targetKind: input.targetKind,
          targetId: input.targetId,
          targetVersionId: input.targetVersionId,
          eligibilityStatus: "suppressed",
          suppressionReason: plan.suppressionReason,
          consecutiveSoftStopCount:
            plan.state?.consecutiveSoftStopCount ??
            ((currentState?.consecutiveSoftStopCount ?? 0) + 1),
          suppressedUntilAt: plan.suppressionUntilAt,
          releaseReason: null,
          triggerUserEventRevisionId: input.triggerUserEventRevisionId,
          lastPromptEventRevisionId: use.prompt_user_event_revision_id,
          lastResponseEventRevisionId: input.triggerUserEventRevisionId,
          lastUsedAt: input.now.toISOString(),
          triggerExchangeNo: triggerRow.continuous_exchange_no,
          now: input.now,
        });
      }
      await client.query(
        `INSERT INTO proactive_followup_dispositions (
           proactive_followup_disposition_id, user_id,
           proactive_followup_use_id, target_kind, target_id, target_version_id,
           trigger_user_event_revision_id, trigger_user_event_sequence, signal,
           final_text_locator, outcome, state_version_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [
          createUuidV7(input.now),
          input.userId,
          input.useId,
          input.targetKind,
          input.targetId,
          input.targetVersionId,
          input.triggerUserEventRevisionId,
          input.triggerUserEventSequence,
          input.signal,
          json(input.finalTextLocator),
          plan.outcome,
          stateVersionId,
          input.now,
        ],
      );
      return { outcome: "recorded", stateVersionId };
    });
  }

  public async releaseTarget(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    release: ProactiveFollowupReleaseInput;
  }>): Promise<Readonly<{ outcome: "released" | "unchanged" | "fenced"; reason: string }>> {
    return inTransaction(this.pool, async (client) => {
      const fence = await ownerFence(client, input);
      if (fence) return { outcome: "fenced", reason: fence };
      const current = await loadState(client, {
        userId: input.userId,
        targetKind: input.release.targetKind,
        targetId: input.release.targetId,
        forUpdate: true,
      });
      if (!current) return { outcome: "fenced", reason: "state_missing" };
      const release = planProactiveFollowupRelease({
        ...input.release,
        state: current,
      });
      if (release.outcome === "rejected") return { outcome: "fenced", reason: release.reason };
      if (release.outcome === "unchanged") return { outcome: "unchanged", reason: release.reason };
      const event = await client.query<{ sequence_no: string; actor: string; lifecycle_status: string }>(
        `SELECT event.sequence_no::text, event.actor, event.lifecycle_status
         FROM conversation_event_revisions revision
         INNER JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
           AND event.user_id = revision.user_id
         WHERE revision.conversation_event_revision_id = $1
           AND revision.user_id = $2
           AND revision.content_purged_at IS NULL
           AND event.current_revision_id = revision.conversation_event_revision_id`,
        [input.release.currentUserEventRevisionId, input.userId],
      );
      const eventRow = event.rows[0];
      if (
        !eventRow || eventRow.actor !== "user" || eventRow.lifecycle_status !== "active" ||
        eventRow.sequence_no !== String(input.release.currentUserEventSequence)
      ) return { outcome: "fenced", reason: "release_event" };
      if (!(await targetIsCurrent(client, {
        userId: input.userId,
        targetKind: input.release.targetKind,
        targetId: input.release.targetId,
        targetVersionId: input.release.targetVersionId,
        now: input.release.now,
      }))) return { outcome: "fenced", reason: "target_not_current" };
      await appendStateVersion(client, {
        userId: input.userId,
        stateId: current.stateId,
        previousStateVersionId: current.stateVersionId,
        targetKind: input.release.targetKind,
        targetId: input.release.targetId,
        targetVersionId: input.release.targetVersionId,
        eligibilityStatus: "eligible",
        suppressionReason: null,
        consecutiveSoftStopCount: release.state.consecutiveSoftStopCount,
        suppressedUntilAt: null,
        releaseReason: input.release.reason,
        triggerUserEventRevisionId: input.release.currentUserEventRevisionId,
        lastPromptEventRevisionId: current.lastPromptEventRevisionId,
        lastResponseEventRevisionId: current.lastResponseEventRevisionId,
        lastUsedAt: current.lastUsedAt,
        triggerExchangeNo: null,
        now: input.release.now,
      });
      return { outcome: "released", reason: release.reason };
    });
  }

  /** Recovery only settles terminal segment commands; it never guesses from age. */
  public async reconcileTerminalReservations(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    now: Date;
    limit?: number;
  }>): Promise<number> {
    return inTransaction(this.pool, async (client) => {
      const fence = await ownerFence(client, input);
      if (fence) return 0;
      const result = await client.query<{ proactive_followup_reservation_id: string }>(
        `SELECT reservation.proactive_followup_reservation_id
         FROM proactive_followup_reservations reservation
         INNER JOIN generation_commands segment
           ON segment.generation_command_id = reservation.segment_generation_command_id
           AND segment.user_id = reservation.user_id
         WHERE reservation.user_id = $1 AND reservation.status = 'active'
           AND segment.status IN ('succeeded', 'failed', 'interrupted')
         ORDER BY reservation.created_at
         LIMIT $2
         FOR UPDATE OF reservation SKIP LOCKED`,
        [input.userId, input.limit ?? 100],
      );
      for (const row of result.rows) {
        await client.query(
          `UPDATE proactive_followup_reservations
           SET status = 'abandoned', terminal_at = $2,
               selection_manifest = jsonb_set(
                 selection_manifest, '{reservationStatus}', '"abandoned"'::jsonb
               )
           WHERE proactive_followup_reservation_id = $1 AND user_id = $3
             AND status = 'active'`,
          [row.proactive_followup_reservation_id, input.now, input.userId],
        );
      }
      return result.rows.length;
    });
  }
}
