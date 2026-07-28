import type {
  GenerationInspectionMetadata,
  InternalInspectionRepository,
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asGenerationCommandId,
  asModelRunAttemptId,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";

type GenerationMetadataRow = Readonly<{
  attempt_status: string;
  checked_at: Date;
  command_status: string;
  completed_at: Date | null;
  consent_policy_version: string | null;
  cost_micros: string | null;
  dispatch_latency_ms: string;
  dispatched_at: Date | null;
  disposition: string;
  freshness_policy: string;
  generation_command_id: string;
  input_revision_id: string;
  input_tokens: string | null;
  model: string;
  model_run_attempt_id: string;
  output_tokens: string | null;
  provider: string;
  provider_latency_ms: string | null;
  provider_policy_version: string;
  provider_request_id: string | null;
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
  public constructor(private readonly pool: Pool) {}

  public async findGenerationMetadata(
    input: Parameters<
      InternalInspectionRepository["findGenerationMetadata"]
    >[0],
  ): Promise<GenerationInspectionMetadata | null> {
    const result = await this.pool.query<GenerationMetadataRow>(
      `
        SELECT
          command.generation_command_id,
          command.input_revision_id,
          command.freshness_policy,
          command.consent_policy_version,
          command.status AS command_status,
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
      return null;
    }
    return {
      attemptStatus: row.attempt_status,
      checkedAt: row.checked_at,
      commandStatus: row.command_status,
      completedAt: row.completed_at,
      consentPolicyVersion: row.consent_policy_version,
      costMicros: optionalNumber(row.cost_micros),
      dispatchLatencyMs: Number(row.dispatch_latency_ms),
      dispatchedAt: row.dispatched_at,
      disposition: row.disposition,
      freshnessPolicy: row.freshness_policy,
      generationCommandId: asGenerationCommandId(
        row.generation_command_id,
      ),
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
      role: row.role,
      sourceRevisionId: asConversationEventRevisionId(
        row.input_revision_id,
      ),
    };
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

function optionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
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
