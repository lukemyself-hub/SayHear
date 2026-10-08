import type { Pool } from "pg";

import type {
  RecentContextControlReason,
  RecentContextSourceItem,
  RecentContextSourcePort,
  RecentContextSourceRequest,
  RecentContextSourceSnapshot,
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asInteractionTurnId,
} from "@sayhear/domain";

type CandidateRow = Readonly<{
  actor: "user" | "assistant";
  daily_session_id: string;
  exclusion: { controlId: string; reason: string } | null;
  expressed_at: Date;
  interaction_turn_id: string;
  revision_id: string;
  sequence_no: string;
  text: string;
}>;

const SUPPORTED_CONTROL_REASONS: readonly RecentContextControlReason[] = [
  "correction_association",
  "forget_association",
];

function toControlReason(value: string): RecentContextControlReason | null {
  return SUPPORTED_CONTROL_REASONS.includes(value as RecentContextControlReason)
    ? (value as RecentContextControlReason)
    : null;
}

/**
 * Real PostgreSQL recent-source adapter (issue #293).
 *
 * It reads only final / corrected, non-purged Conversation Event Revisions in
 * the frozen seven-local-day window up to the admitted-command cutoff, and
 * associates each row with the existing explicit Correction / Forget records
 * through `claim_evidence_links` / `evidence_items` (whole-Claim and
 * relationship-Qualifier scope). It performs no semantic matching and never
 * copies message bodies into any frozen manifest.
 *
 * Composition wires this into the Context Compiler in #294; the query and
 * control mapping are exercised here so the ADR-0149 source contract is
 * verifiable against real trust-action data.
 */
export class PostgresRecentContextSource implements RecentContextSourcePort {
  public constructor(private readonly pool: Pool) {}

  public async loadRecentContextSource(
    request: RecentContextSourceRequest,
  ): Promise<RecentContextSourceSnapshot> {
    const base = {
      candidateBytes: 0,
      candidateRows: 0,
      failure: null,
      items: [] as readonly RecentContextSourceItem[],
      policyVersion: request.policyVersion,
      selectorVersion: request.selectorVersion,
      timezone: request.timezone,
      truncated: false,
      windowEndLocalDate: request.windowEndLocalDate,
      windowStartLocalDate: request.windowStartLocalDate,
    };
    try {
      return await this.load(request, base);
    } catch (error) {
      return {
        ...base,
        failure: {
          code: "source_read_failed",
          detail: error instanceof Error ? error.message : null,
        },
      };
    }
  }

  private async load(
    request: RecentContextSourceRequest,
    base: Omit<RecentContextSourceSnapshot, "failure"> & {
      failure: RecentContextSourceSnapshot["failure"];
    },
  ): Promise<RecentContextSourceSnapshot> {
    const owner = await this.pool.query<{
      data_epoch: string;
      status: string;
    }>(
      `SELECT data_epoch, status FROM app_users WHERE user_id = $1`,
      [request.userId],
    );
    const ownerRow = owner.rows[0];
    if (!ownerRow || ownerRow.status !== "active") {
      return { ...base, failure: { code: "owner_inactive", detail: null } };
    }
    if (Number(ownerRow.data_epoch) !== request.expectedDataEpoch) {
      return {
        ...base,
        failure: { code: "expected_data_epoch_mismatch", detail: null },
      };
    }

    const result = await this.pool.query<CandidateRow>(
      `
        SELECT
          event.daily_session_id::text AS daily_session_id,
          event.interaction_turn_id::text AS interaction_turn_id,
          event.sequence_no::text AS sequence_no,
          event.actor,
          revision.conversation_event_revision_id::text AS revision_id,
          revision.canonical_text AS text,
          event.created_at AS expressed_at,
          COALESCE(
            (
              SELECT jsonb_build_object(
                'controlId', exclusion.memory_forget_request_id::text,
                'reason', 'forget_association'
              )
              FROM evidence_items item
              INNER JOIN memory_forget_evidence_exclusions exclusion
                ON exclusion.evidence_item_id = item.evidence_item_id
               AND exclusion.user_id = item.user_id
              WHERE item.user_id = event.user_id
                AND item.source_revision_id =
                  revision.conversation_event_revision_id
                AND item.status = 'active'
                AND exclusion.status = 'active'
              ORDER BY exclusion.created_at
              LIMIT 1
            ),
            (
              SELECT jsonb_build_object(
                'controlId', correction.memory_claim_correction_id::text,
                'reason', 'correction_association'
              )
              FROM claim_evidence_links link
              INNER JOIN evidence_items item
                ON item.evidence_item_id = link.evidence_item_id
               AND item.user_id = link.user_id
              INNER JOIN memory_claim_corrections correction
                ON correction.deactivated_claim_version_id =
                  link.memory_claim_version_id
               AND correction.user_id = link.user_id
              WHERE link.user_id = event.user_id
                AND link.status = 'active'
                AND item.source_revision_id =
                  revision.conversation_event_revision_id
              ORDER BY correction.created_at
              LIMIT 1
            )
          ) AS exclusion
        FROM conversation_events event
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = event.current_revision_id
         AND revision.user_id = event.user_id
        WHERE event.user_id = $1
          AND event.actor IN ('user', 'assistant')
          AND event.lifecycle_status = 'active'
          AND revision.content_purged_at IS NULL
          AND revision.transcript_status IN ('final', 'corrected')
          AND (event.created_at AT TIME ZONE $2)::date
            BETWEEN $3::date AND $4::date
          AND event.created_at <= $5::timestamptz
          AND NOT (
            revision.conversation_event_revision_id = ANY($6::uuid[])
          )
        ORDER BY event.created_at, event.daily_session_id, event.sequence_no
        LIMIT $7
      `,
      [
        request.userId,
        request.timezone,
        request.windowStartLocalDate,
        request.windowEndLocalDate,
        request.cutoff.expressedAt,
        request.excludeRevisionIds,
        request.budgets.maxCandidateRows,
      ],
    );

    let candidateBytes = 0;
    const items: RecentContextSourceItem[] = result.rows.map((row) => {
      candidateBytes += Buffer.byteLength(row.text, "utf8");
      const controlReason =
        row.exclusion === null
          ? null
          : toControlReason(row.exclusion.reason);
      return {
        actor: row.actor,
        dailySessionId: asDailySessionId(row.daily_session_id),
        exclusion:
          row.exclusion === null || controlReason === null
            ? null
            : { controlId: row.exclusion.controlId, reason: controlReason },
        expressedAt: row.expressed_at.toISOString(),
        interactionTurnId: asInteractionTurnId(row.interaction_turn_id),
        occurredAt: null,
        revisionId: asConversationEventRevisionId(row.revision_id),
        sequence: Number(row.sequence_no),
        text: row.text,
      };
    });

    return {
      ...base,
      candidateBytes,
      candidateRows: items.length,
      items,
      truncated: items.length >= request.budgets.maxCandidateRows,
    };
  }
}
