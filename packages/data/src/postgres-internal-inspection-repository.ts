import type {
  CompiledContextDegradedReason,
  CompiledContextSection,
  ContextPolicyVersions,
  GenerationInspectionMetadata,
  InternalInspectionRepository,
  RecentContextInspection,
  RetrievalCandidateInspection,
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asCompiledContextId,
  asGenerationCommandId,
  asModelRunAttemptId,
  decodeRecentContextReference,
  RECENT_CONTEXT_SECTION_KEY,
  RecentContextReferenceError,
  validateSafetyPostureContent,
  type CurrentSafetyPosture,
  type HistoryRecallInspection,
  type HistoryExperienceSearchPlan,
  type HistoryQueryPlan,
  type MemorySectionKey,
  type SafetyPostureContent,
} from "@sayhear/application";

import { loadDialogueStateForContext } from "./postgres-dialogue-state-repository";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";

type GenerationMetadataRow = Readonly<{
  generation_stage: string;
  attempt_status: string;
  checked_at: Date;
  command_status: string;
  completed_at: Date | null;
  context_compiler_version: string;
  context_degraded_reason: CompiledContextDegradedReason;
  context_daily_session_id: string;
  context_dialogue_revision: string;
  context_expected_data_epoch: string;
  context_id: string;
  context_integrity_algorithm: "hmac-sha256";
  context_integrity_key_version: string;
  context_locale: string;
  context_policy_versions: ContextPolicyVersions;
  context_referenced_events: Array<{
    actor: "user" | "assistant";
    dailySessionId: string | null;
    estimatedTokens: number;
    expressedAt: string | null;
    occurredAt: string | null;
    revisionId: string;
    section:
      | "committed_raw_events"
      | "current_user_input"
      | "recent_conversation_context"
      | "history_recall_context";
    selectionOrder: number | null;
    selectionReason: string | null;
    sequence: number;
  }>;
  context_retrieval_manifest: GenerationInspectionMetadata["compiledContext"]["retrievalManifest"];
  context_section_budgets: { committedRawEvents: number };
  context_sections: CompiledContextSection[];
  context_source_revision: string;
  context_total_tokens: string;
  consent_policy_version: string | null;
  conversation_action_catalog_version: string;
  cost_micros: string | null;
  dispatch_latency_ms: string;
  dispatched_at: Date | null;
  disposition: string;
  freshness_policy: string;
  generation_command_id: string;
  harness_policy_version: string;
  input_revision_id: string;
  input_tokens: string | null;
  model: string;
  model_run_attempt_id: string;
  output_tokens: string | null;
  provider: string;
  provider_latency_ms: string | null;
  provider_policy_version: string;
  provider_request_id: string | null;
  recovery_attempts: Array<{
    attemptNo: number;
    completedAt: string | null;
    createdAt: string;
    errorCategory: string | null;
    firstTokenAt: string | null;
    id: string;
    providerCompletedAt: string | null;
    recoveryClaimedAt: string | null;
    recoveryStatus: string;
    retryNotBefore: string | null;
    retryOfModelRunAttemptId: string | null;
    startedAt: string | null;
    status: string;
  }>;
  recovery_checked_at: Date | null;
  recovery_policy_version: string;
  recovery_status: string;
  next_recovery_at: Date | null;
  role: string;
}>;

type SensitiveAccessTargetRow = Readonly<{
  daily_session_id: string;
}>;

type SensitiveAccessGrantRow = Readonly<{
  capability_status: string;
  step_up_authenticated_at: Date | null;
}>;

export class PostgresInternalInspectionRepository
  implements InternalInspectionRepository
{
  public async authorizeSensitiveInspection(
    input: Parameters<InternalInspectionRepository["authorizeSensitiveInspection"]>[0],
  ): ReturnType<InternalInspectionRepository["authorizeSensitiveInspection"]> {
    const result = await this.pool.query<SensitiveAccessGrantRow>(
      `SELECT diagnostic_grant.status AS capability_status, diagnostic_grant.step_up_authenticated_at
       FROM auth_sessions session
       INNER JOIN internal_diagnostic_access_grants diagnostic_grant
         ON diagnostic_grant.session_token_hash = session.session_token_hash
        AND diagnostic_grant.capability = $3
       WHERE session.user_id = $1 AND session.session_token_hash = decode($2, 'hex')
         AND session.expires_at > $4`,
      [input.userId, input.authSessionId, input.capability, input.now],
    );
    const reason = sensitiveAccessDenialReason({
      capabilityStatus: result.rows[0]?.capability_status ?? null,
      now: input.now,
      stepUpAuthenticatedAt: result.rows[0]?.step_up_authenticated_at ?? null,
      stepUpMaxAgeMs: input.stepUpMaxAgeMs,
    });
    return reason ? { outcome: "denied", reason } : { outcome: "allowed" };
  }
  public constructor(private readonly pool: Pool) {}

  public async findGenerationMetadata(
    input: Parameters<
      InternalInspectionRepository["findGenerationMetadata"]
    >[0],
  ): Promise<GenerationInspectionMetadata | null> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await client.query<GenerationMetadataRow>(
      `
        SELECT
          command.generation_command_id,
          command.input_revision_id,
          command.freshness_policy,
          command.consent_policy_version,
          command.harness_policy_version,
          command.conversation_action_catalog_version,
          command.generation_stage,
          command.status AS command_status,
          command.recovery_policy_version,
          command.recovery_status,
          command.recovery_checked_at,
          command.next_recovery_at,
          command.expected_data_epoch AS context_expected_data_epoch,
          context.compiled_context_id AS context_id,
          context.compiler_version AS context_compiler_version,
          turn.daily_session_id AS context_daily_session_id,
          context.dialogue_revision AS context_dialogue_revision,
          context.source_revision AS context_source_revision,
          context.locale AS context_locale,
          context.policy_versions AS context_policy_versions,
          context.section_budgets AS context_section_budgets,
          context.sections AS context_sections,
          context.retrieval_manifest AS context_retrieval_manifest,
          context.total_tokens AS context_total_tokens,
          context.degraded_reason AS context_degraded_reason,
          context.integrity_algorithm AS context_integrity_algorithm,
          context.integrity_key_version AS context_integrity_key_version,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'actor', ref.actor,
                  'dailySessionId', ref.daily_session_id,
                  'estimatedTokens', ref.estimated_tokens,
                  'expressedAt', ref.expressed_at,
                  'occurredAt', ref.occurred_at,
                  'revisionId', ref.conversation_event_revision_id,
                  'section', ref.section,
                  'selectionOrder', ref.selection_order,
                  'selectionReason', ref.selection_reason,
                  'sequence', ref.sequence_no
                )
                ORDER BY ref.ordinal
              )
              FROM compiled_context_revision_refs ref
              WHERE ref.compiled_context_id =
                context.compiled_context_id
                AND ref.user_id = context.user_id
            ),
            '[]'::jsonb
          ) AS context_referenced_events,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', lineage.model_run_attempt_id,
                  'attemptNo', lineage.attempt_no,
                  'status', lineage.status,
                  'recoveryStatus', lineage.recovery_status,
                  'retryOfModelRunAttemptId',
                    lineage.retry_of_model_run_attempt_id,
                  'createdAt', lineage.created_at,
                  'startedAt', lineage.started_at,
                  'firstTokenAt', lineage.first_token_at,
                  'providerCompletedAt', lineage.provider_completed_at,
                  'completedAt', lineage.completed_at,
                  'retryNotBefore', lineage.retry_not_before,
                  'recoveryClaimedAt', lineage.recovery_claimed_at,
                  'errorCategory', lineage.error_category
                )
                ORDER BY lineage.attempt_no
              )
              FROM model_run_attempts lineage
              WHERE lineage.generation_command_id =
                command.generation_command_id
                AND lineage.user_id = command.user_id
            ),
            '[]'::jsonb
          ) AS recovery_attempts,
          attempt.model_run_attempt_id,
          attempt.provider,
          attempt.model,
          attempt.provider_request_id,
          attempt.input_tokens::text,
          attempt.output_tokens::text,
          attempt.cost_micros::text,
          attempt.status AS attempt_status,
          egress.role,
          egress.provider_policy_version,
          egress.status AS disposition,
          egress.checked_at,
          egress.dispatched_at,
          egress.completed_at,
          ROUND(
            EXTRACT(EPOCH FROM (egress.checked_at - command.created_at))
            * 1000
          )::bigint::text AS dispatch_latency_ms,
          CASE
            WHEN attempt.started_at IS NULL OR attempt.completed_at IS NULL
              THEN NULL
            ELSE ROUND(
              EXTRACT(EPOCH FROM (
                attempt.completed_at - attempt.started_at
              )) * 1000
            )::bigint::text
          END AS provider_latency_ms
        FROM active_internal_owner owner
        INNER JOIN generation_commands command
          ON command.user_id = owner.user_id
        INNER JOIN interaction_turns turn
          ON turn.interaction_turn_id = command.interaction_turn_id
          AND turn.user_id = command.user_id
        INNER JOIN compiled_contexts context
          ON context.compiled_context_id = command.compiled_context_id
          AND context.generation_command_id =
            command.generation_command_id
          AND context.user_id = command.user_id
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id = command.generation_command_id
          AND attempt.user_id = command.user_id
        INNER JOIN provider_egress_dispositions egress
          ON egress.model_run_attempt_id = attempt.model_run_attempt_id
          AND egress.user_id = attempt.user_id
        WHERE owner.user_id = $1
          AND command.generation_command_id = $2
        ORDER BY attempt.attempt_no DESC
        LIMIT 1
      `,
      [input.userId, input.generationCommandId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const dialogueStateSectionCompiled = row.context_sections.some(
        (section) => section.key === "dialogue_state",
      );
      const dialogueState = dialogueStateSectionCompiled
        ? await loadDialogueStateForContext(client, {
            dailySessionId: row.context_daily_session_id,
            dialogueRevision: Number(row.context_dialogue_revision),
            expectedDataEpoch: Number(row.context_expected_data_epoch),
            sourceRevision: Number(row.context_source_revision),
          })
        : { dialogueState: null, failure: false };
      const safetyPosture = await loadSafetyPostureForInspection(client, {
        dailySessionId: row.context_daily_session_id,
        expectedDataEpoch: Number(row.context_expected_data_epoch),
        sourceRevision: Number(row.context_source_revision),
        userId: input.userId,
      });
      const retrievalCandidates =
        row.context_retrieval_manifest === null
          ? []
          : await loadRetrievalCandidates(client, {
              retrievalRunId:
                row.context_retrieval_manifest.retrieval_run_id,
              userId: input.userId,
            });
      const recentContext = await loadRecentContextInspection(client, {
        policyVersions: row.context_policy_versions,
        referencedEvents: row.context_referenced_events,
        sections: row.context_sections,
      });
      const historyRecall = await loadHistoryRecallInspection(client, {
        commandId: input.generationCommandId,
        userId: input.userId,
      });
      await client.query("COMMIT");
      return {
        attemptStatus: row.attempt_status,
        checkedAt: row.checked_at,
        commandStatus: row.command_status,
        compiledContext: {
          compilerVersion: row.context_compiler_version,
          degradedReason: row.context_degraded_reason,
          dialogueState: dialogueState.dialogueState,
          dialogueRevision: Number(row.context_dialogue_revision),
          id: asCompiledContextId(row.context_id),
          integrity: {
            algorithm: row.context_integrity_algorithm,
            keyVersion: row.context_integrity_key_version,
          },
          locale: row.context_locale,
          policyVersions: row.context_policy_versions,
          recentContext,
          referencedEvents: row.context_referenced_events.map((event) => ({
            actor: event.actor,
            dailySessionId: event.dailySessionId,
            estimatedTokens: event.estimatedTokens,
            expressedAt: normalizeInstant(event.expressedAt),
            occurredAt: normalizeInstant(event.occurredAt),
            revisionId: asConversationEventRevisionId(event.revisionId),
            section: event.section,
            selectionOrder: event.selectionOrder,
            selectionReason: event.selectionReason,
            sequence: event.sequence,
          })),
          sectionBudgets: row.context_section_budgets,
          sections: row.context_sections.map(
            ({ contentHmac: _contentHmac, ...section }) => section,
          ),
          retrievalManifest: row.context_retrieval_manifest,
          safetyPosture: {
            posture: safetyPosture,
            state: safetyPosture?.content.state ?? "default",
          },
          sourceRevision: Number(row.context_source_revision),
          totalTokens: Number(row.context_total_tokens),
        },
        completedAt: row.completed_at,
        consentPolicyVersion: row.consent_policy_version,
        conversationActionCatalogVersion:
          row.conversation_action_catalog_version,
        costMicros: optionalNumber(row.cost_micros),
        dispatchLatencyMs: Number(row.dispatch_latency_ms),
        dispatchedAt: row.dispatched_at,
        disposition: row.disposition,
        freshnessPolicy: row.freshness_policy,
        generationCommandId: asGenerationCommandId(
          row.generation_command_id,
        ),
        generationStage: row.generation_stage,
        harnessPolicyVersion: row.harness_policy_version,
        historyRecall,
        inputTokens: optionalNumber(row.input_tokens),
        model: row.model,
        modelRunAttemptId: asModelRunAttemptId(
          row.model_run_attempt_id,
        ),
        outputTokens: optionalNumber(row.output_tokens),
        provider: row.provider,
        providerLatencyMs: optionalNumber(row.provider_latency_ms),
        providerPolicyVersion: row.provider_policy_version,
        providerRequestId: row.provider_request_id,
        recovery: {
          attempts: row.recovery_attempts.map((attempt) => ({
            attemptNo: attempt.attemptNo,
            completedAt: optionalDate(attempt.completedAt),
            createdAt: new Date(attempt.createdAt),
            errorCategory: attempt.errorCategory,
            firstTokenAt: optionalDate(attempt.firstTokenAt),
            id: asModelRunAttemptId(attempt.id),
            providerCompletedAt: optionalDate(attempt.providerCompletedAt),
            recoveryClaimedAt: optionalDate(attempt.recoveryClaimedAt),
            recoveryStatus: attempt.recoveryStatus,
            retryNotBefore: optionalDate(attempt.retryNotBefore),
            retryOfModelRunAttemptId: attempt.retryOfModelRunAttemptId
              ? asModelRunAttemptId(attempt.retryOfModelRunAttemptId)
              : null,
            startedAt: optionalDate(attempt.startedAt),
            status: attempt.status,
          })),
          checkedAt: row.recovery_checked_at,
          nextRecoveryAt: row.next_recovery_at,
          policyVersion: row.recovery_policy_version,
          status: row.recovery_status,
        },
        role: row.role,
        retrievalCandidates,
        sourceRevisionId: asConversationEventRevisionId(
          row.input_revision_id,
        ),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async inspectConversationContent(
    input: Parameters<
      InternalInspectionRepository["inspectConversationContent"]
    >[0],
  ): ReturnType<InternalInspectionRepository["inspectConversationContent"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const grant = await client.query<SensitiveAccessGrantRow>(
        `
          SELECT
            diagnostic_grant.status AS capability_status,
            diagnostic_grant.step_up_authenticated_at
          FROM active_internal_owner owner
          INNER JOIN auth_sessions session
            ON session.user_id = owner.user_id
            AND session.session_token_hash = decode($2, 'hex')
            AND session.expires_at > $4
          INNER JOIN internal_diagnostic_access_grants diagnostic_grant
            ON diagnostic_grant.session_token_hash =
              session.session_token_hash
            AND diagnostic_grant.capability = $3
          WHERE owner.user_id = $1
          FOR UPDATE OF session, diagnostic_grant
        `,
        [input.userId, input.authSessionId, input.capability, input.now],
      );
      const denialReason = sensitiveAccessDenialReason({
        capabilityStatus: grant.rows[0]?.capability_status ?? null,
        now: input.now,
        stepUpAuthenticatedAt:
          grant.rows[0]?.step_up_authenticated_at ?? null,
        stepUpMaxAgeMs: input.stepUpMaxAgeMs,
      });
      if (denialReason) {
        await insertSensitiveAccessAudit(client, {
          ...input,
          disposition: "denied",
          reason: denialReason,
        });
        await client.query("COMMIT");
        return { outcome: "denied", reason: denialReason };
      }

      const target = await client.query<SensitiveAccessTargetRow>(
        `
          SELECT turn.daily_session_id
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          WHERE command.user_id = $1
            AND command.generation_command_id = $2
          FOR UPDATE OF command, turn
        `,
        [input.userId, input.generationCommandId],
      );
      const row = target.rows[0];
      if (!row) {
        await insertSensitiveAccessAudit(client, {
          ...input,
          disposition: "denied",
          reason: "target_not_found",
        });
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }

      const content = await client.query<{
        actor: "assistant" | "system" | "user";
        revision_id: string;
        text: string;
      }>(
        `
          SELECT
            event.actor,
            revision.conversation_event_revision_id AS revision_id,
            revision.canonical_text AS text
          FROM conversation_events event
          INNER JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id =
              event.current_revision_id
            AND revision.user_id = event.user_id
          WHERE event.user_id = $1
            AND event.daily_session_id = $2
            AND event.lifecycle_status = 'active'
            AND revision.content_purged_at IS NULL
          ORDER BY event.sequence_no
        `,
        [input.userId, row.daily_session_id],
      );
      await insertSensitiveAccessAudit(client, {
        ...input,
        disposition: "allowed",
        reason: "authorized",
      });
      await client.query("COMMIT");
      return {
        content: {
          events: content.rows.map((event) => ({
            actor: event.actor,
            revisionId: asConversationEventRevisionId(
              event.revision_id,
            ),
            text: event.text,
          })),
          generationCommandId: input.generationCommandId,
        },
        outcome: "allowed",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

type RetrievalCandidateRow = Readonly<{
  claim_retrieval_projection_id: string;
  final_rank: number | null;
  matched_fields: readonly string[];
  matched_terms: readonly string[];
  memory_claim_version_id: string;
  rank_components: RetrievalCandidateInspection["rankComponents"];
  rejection_reason_codes: readonly string[];
  retrieval_lane: RetrievalCandidateInspection["lane"];
  selected_section: MemorySectionKey | null;
  selection_reason_codes: readonly string[];
  trust_fence_results: RetrievalCandidateInspection["trustFenceResults"];
}>;

/**
 * #122: the retrieval panel's candidate funnel — the run-ledger rows joined
 * by the manifest's pinned retrieval_run_id (the funnel and the manifest
 * describe the same run by construction), read-only, with the recorded
 * reasons verbatim. Ordered by final rank with unranked (fenced-out) rows
 * last.
 */
async function loadRetrievalCandidates(
  client: PoolClient,
  input: { retrievalRunId: string; userId: string },
): Promise<readonly RetrievalCandidateInspection[]> {
  const result = await client.query<RetrievalCandidateRow>(
    `
      SELECT
        candidate.claim_retrieval_projection_id::text,
        candidate.final_rank,
        candidate.matched_fields,
        candidate.matched_terms,
        candidate.memory_claim_version_id::text,
        candidate.rank_components,
        candidate.rejection_reason_codes,
        candidate.retrieval_lane,
        candidate.selected_section,
        candidate.selection_reason_codes,
        candidate.trust_fence_results
      FROM retrieval_run_candidates candidate
      WHERE candidate.user_id = $2
        AND candidate.retrieval_run_id = $1
      ORDER BY candidate.final_rank ASC NULLS LAST,
        candidate.retrieval_lane
    `,
    [input.retrievalRunId, input.userId],
  );
  return result.rows.map((row) => ({
    claimVersionId: row.memory_claim_version_id,
    finalRank: row.final_rank === null ? null : Number(row.final_rank),
    lane: row.retrieval_lane,
    matchedFields: row.matched_fields,
    matchedTerms: row.matched_terms,
    rankComponents: row.rank_components,
    rejectionReasonCodes: row.rejection_reason_codes,
    retrievalProjectionId: row.claim_retrieval_projection_id,
    selectedSection: row.selected_section,
    selectionReasonCodes: row.selection_reason_codes,
    trustFenceResults: row.trust_fence_results,
  }));
}

async function loadSafetyPostureForInspection(
  client: PoolClient,
  input: {
    dailySessionId: string;
    expectedDataEpoch: number;
    sourceRevision: number;
    userId: string;
  },
): Promise<CurrentSafetyPosture | null> {
  const result = await client.query<{
    content: SafetyPostureContent;
    policy_version: string;
    safety_posture_id: string;
    source_revision: string;
    version_no: string;
  }>(
    `
      SELECT
        version.content,
        version.policy_version,
        version.safety_posture_id,
        version.source_revision,
        version.version_no
      FROM safety_postures version
      INNER JOIN app_users owner
        ON owner.user_id = version.user_id
        AND owner.status = 'active'
        AND owner.data_epoch = $4
      WHERE version.daily_session_id = $1
        AND version.user_id = $2
        AND version.source_revision <= $3
      ORDER BY version.source_revision DESC, version.version_no DESC
      LIMIT 1
    `,
    [
      input.dailySessionId,
      input.userId,
      input.sourceRevision,
      input.expectedDataEpoch,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    validateSafetyPostureContent(row.content);
  } catch {
    return null;
  }
  return {
    content: row.content,
    id: row.safety_posture_id,
    policyVersion: row.policy_version,
    sourceRevision: Number(row.source_revision),
    versionNo: Number(row.version_no),
  };
}

const EMPTY_RECENT_BUDGETS = {
  maxCandidateBytes: 0,
  maxCandidateRows: 0,
  maxContextTokens: 0,
  maxSingleEventTokens: 0,
  readTimeoutMs: 0,
} as const;

const EMPTY_RECENT_COUNTS = {
  candidateBytes: 0,
  candidateRows: 0,
  selectedCount: 0,
  truncated: false,
} as const;

const EMPTY_RECENT_CUTOFF = {
  currentInputRevisionId: null,
  currentInputSequence: null,
  dailySessionId: null,
  expressedAt: "",
} as const;

function normalizeInstant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * #295: decode the already-stored recent-source reference server-side and
 * merge it with the per-ref provenance columns. It never re-reads message
 * bodies and never re-derives a selection — a malformed / unknown-version
 * reference renders an explicit unreadable state instead of fabricated values.
 */
async function loadRecentContextInspection(
  client: PoolClient,
  input: {
    policyVersions: ContextPolicyVersions;
    referencedEvents: GenerationMetadataRow["context_referenced_events"];
    sections: readonly CompiledContextSection[];
  },
): Promise<RecentContextInspection | null> {
  const section = input.sections.find(
    (candidate) => candidate.key === RECENT_CONTEXT_SECTION_KEY,
  );
  if (!section) return null;
  const authorizationPolicyVersion =
    input.policyVersions.recentContextPolicyVersion ?? null;
  let authorizationStatus: RecentContextInspection["authorizationStatus"];
  if (authorizationPolicyVersion === null) {
    authorizationStatus = "absent";
  } else {
    const status = await client.query<{ status: "active" | "revoked" }>(
      `SELECT status FROM recent_context_policies WHERE policy_version = $1`,
      [authorizationPolicyVersion],
    );
    authorizationStatus = status.rows[0]?.status ?? "unrecognized";
  }
  const refByRevision = new Map(
    input.referencedEvents
      .filter((ref) => ref.section === RECENT_CONTEXT_SECTION_KEY)
      .map((ref) => [ref.revisionId, ref] as const),
  );
  let decoded: ReturnType<typeof decodeRecentContextReference>;
  try {
    decoded = decodeRecentContextReference(section.reference);
  } catch (error) {
    return {
      authorizationPolicyVersion,
      authorizationStatus,
      budgetTokens: 0,
      budgets: EMPTY_RECENT_BUDGETS,
      counts: EMPTY_RECENT_COUNTS,
      cutoff: EMPTY_RECENT_CUTOFF,
      excludedRevisionIds: [],
      failure: null,
      omitted: [],
      perDate: [],
      policyVersion: "",
      readLatencyMs: null,
      referenceVersion: 0,
      selected: [],
      selectorVersion: "",
      timezone: "",
      unreadableReason:
        error instanceof RecentContextReferenceError
          ? error.message
          : "recent_context_unreadable",
      windowDays: 0,
      windowEndLocalDate: "",
      windowStartLocalDate: "",
    };
  }
  return {
    authorizationPolicyVersion,
    authorizationStatus,
    budgetTokens: decoded.budgetTokens,
    budgets: decoded.budgets,
    counts: decoded.counts,
    cutoff: decoded.cutoff,
    excludedRevisionIds: decoded.excludedRevisionIds,
    failure: decoded.failure,
    omitted: decoded.omitted,
    perDate: decoded.perDate,
    policyVersion: decoded.policyVersion,
    readLatencyMs: decoded.readLatencyMs,
    // The actual encoded wire version, so a v3 reference read by a v4 decoder
    // is shown as v3 rather than silently relabeled.
    referenceVersion: decoded.wireVersion,
    selected: decoded.selected.map((ref) => {
      const stored = refByRevision.get(ref.revisionId);
      return {
        actor: ref.actor,
        dailySessionId: ref.dailySessionId,
        estimatedTokens: stored?.estimatedTokens ?? null,
        expressedAt: ref.expressedAt,
        occurredAt: ref.occurredAt,
        revisionId: ref.revisionId,
        selectionOrder: ref.selectionOrder,
        selectionReason: ref.selectionReason,
        sequence: stored?.sequence ?? null,
      };
    }),
    selectorVersion: decoded.selectorVersion,
    timezone: decoded.timezone,
    unreadableReason: null,
    windowDays: decoded.windowDays,
    windowEndLocalDate: decoded.windowEndLocalDate,
    windowStartLocalDate: decoded.windowStartLocalDate,
  };
}

function optionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function optionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function sensitiveAccessDenialReason(input: {
  capabilityStatus: string | null;
  now: Date;
  stepUpAuthenticatedAt: Date | null;
  stepUpMaxAgeMs: number;
}): "elevated_capability_required" | "recent_step_up_required" | null {
  if (input.capabilityStatus !== "active") {
    return "elevated_capability_required";
  }
  const stepUpAt = input.stepUpAuthenticatedAt?.getTime();
  const now = input.now.getTime();
  if (
    stepUpAt === undefined ||
    stepUpAt > now ||
    stepUpAt < now - input.stepUpMaxAgeMs
  ) {
    return "recent_step_up_required";
  }
  return null;
}

async function insertSensitiveAccessAudit(
  client: PoolClient,
  input: {
    capability: "conversation_content:read";
    disposition: "allowed" | "denied";
    generationCommandId: Parameters<
      InternalInspectionRepository["inspectConversationContent"]
    >[0]["generationCommandId"];
    now: Date;
    policyVersion: string;
    reason:
      | "authorized"
      | "elevated_capability_required"
      | "recent_step_up_required"
      | "target_not_found";
    userId: Parameters<
      InternalInspectionRepository["inspectConversationContent"]
    >[0]["userId"];
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO sensitive_access_audits (
        sensitive_access_audit_id,
        user_id,
        capability,
        target_type,
        target_id,
        disposition,
        reason,
        policy_version,
        accessed_at
      )
      VALUES (
        $1, $2, $3, 'generation_command', $4, $5, $6, $7, $8
      )
    `,
    [
      createUuidV7(input.now),
      input.userId,
      input.capability,
      input.generationCommandId,
      input.disposition,
      input.reason,
      input.policyVersion,
      input.now,
    ],
  );
}

/**
 * Content-free account of a controlled history review, readable from either
 * end (the Decision command or the History Answer command). Owner scoped.
 */
function inspectablePlan(
  stored: HistoryQueryPlan | HistoryExperienceSearchPlan | null,
): HistoryRecallInspection["plan"] {
  if (stored === null) return null;
  if ("kind" in stored && stored.kind === "search_experience") {
    return {
      endDate: stored.endDate,
      kind: "search_experience",
      personGroups: stored.groups.filter((group) => group.role === "person").length,
      searchPolicyVersion: stored.searchPolicyVersion,
      startDate: stored.startDate,
      termGroups: stored.groups.filter((group) => group.role === "term").length,
      timezone: stored.timezone,
      variants: stored.groups.reduce((total, group) => total + group.variants.length, 0),
    };
  }
  return stored as HistoryQueryPlan;
}

async function loadHistoryRecallInspection(
  client: PoolClient,
  input: { commandId: string; userId: string },
): Promise<HistoryRecallInspection | null> {
  const result = await client.query<{
    answer_command_id: string;
    coverage: HistoryRecallInspection["coverage"];
    decision_command_id: string;
    failure_code: string | null;
    item_refs: Array<{
      actor: "user" | "assistant";
      expressedAt: string;
      group?: number;
      revisionId: string;
      role?: "match" | "context";
    }>;
    plan: { plan: HistoryQueryPlan | HistoryExperienceSearchPlan | null };
    policy_version: string;
    status: HistoryRecallInspection["status"];
  }>(
    `SELECT decision_command_id::text, answer_command_id::text, policy_version,
            status, failure_code, plan, coverage, item_refs
     FROM history_recall_results
     WHERE user_id = $1
       AND (decision_command_id = $2 OR answer_command_id = $2)`,
    [input.userId, input.commandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    answerCommandId: row.answer_command_id,
    coverage: row.coverage,
    decisionCommandId: row.decision_command_id,
    failureCode: row.failure_code,
    // The search clues are private text: only their counts are inspectable.
    plan: inspectablePlan(row.plan.plan),
    policyVersion: row.policy_version,
    role: row.answer_command_id === input.commandId ? "answer" : "decision",
    sources: row.item_refs.map((ref) => ({
      actor: ref.actor,
      expressedAt: ref.expressedAt,
      ...(ref.group === undefined ? {} : { group: ref.group }),
      revisionId: ref.revisionId,
      ...(ref.role === undefined ? {} : { role: ref.role }),
    })),
    status: row.status,
  };
}
