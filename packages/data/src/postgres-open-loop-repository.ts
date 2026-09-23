import type { Pool } from "pg";

import {
  asEvidenceItemId,
  asOpenLoopId,
  asOpenLoopVersionId,
  asUserId,
} from "@sayhear/domain";
import {
  isOpenLoopKind,
  selectFormationCandidates,
  type OpenLoopExtractionRepository,
  type OpenLoopKind,
  type OpenLoopTerminalStatus,
} from "@sayhear/application";

import { createUuidV7 } from "./uuid-v7";

export type OpenLoopFormationEffect = Readonly<{
  kind: OpenLoopKind;
  sourceEvidenceItemId: string;
  sourceEventRevisionId: string;
  sourceClaimVersionId: string | null;
  sourceEpisodeVersionId: string | null;
  canonicalClaimKey: string | null;
  localizedSummary: string | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  timePrecision: string;
  timezone: string | null;
  followupEligibleFromAt: string;
  expiresAt: string;
  expirySource: string;
  reuseOpenLoopId: string | null;
}>;

export type OpenLoopClosureEffect = Readonly<{
  targetOpenLoopId: string;
  terminalStatus: OpenLoopTerminalStatus;
  closureEventRevisionId: string;
  closureCommittedAt: string;
}>;

/**
 * PostgreSQL port for the 1A.3b C1 Open Loop lane (issue #204, SPEC 6).
 *
 * One User Event commits atomically in source-revision-fenced order:
 * source invalidation (handled by the caller via Evidence/Forget fences),
 * then closure / ambiguous suppression against the pre-transaction open
 * snapshot, then formation / dedupe against the updated state. A new Loop
 * formed by the same Event is never closed by it; a kind change always
 * creates another logical Loop. All valid effects and the run settlement
 * share one transaction; failure leaves no partial Loop/Version/link behind.
 */
export class PostgresOpenLoopRepository implements OpenLoopExtractionRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Per-Event extraction trigger scan (issue #207 layer 2b). Lists the
   * current final/corrected user revisions with no settled extraction run
   * for the policy version. Superseded revisions are never listed: only
   * the current revision of an Event carries extractable Evidence.
   */
  public async listEventsNeedingExtraction(input: Readonly<{
    policyVersion: string;
    limit: number;
  }>): Promise<
    readonly Readonly<{
      eventRevisionId: string;
      userId: ReturnType<typeof asUserId>;
      sourceRevision: number;
      expectedDataEpoch: number;
    }>[]
  > {
    const result = await this.pool.query<{
      event_revision_id: string;
      user_id: string;
      source_revision: string;
      data_epoch: string;
    }>(
      `SELECT revision.conversation_event_revision_id AS event_revision_id,
              revision.user_id AS user_id,
              revision.revision::text AS source_revision,
              owner.data_epoch::text AS data_epoch
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
         AND event.user_id = revision.user_id
       INNER JOIN app_users owner
         ON owner.user_id = revision.user_id
       WHERE event.actor = 'user'
         AND event.event_type = 'message'
         AND event.lifecycle_status = 'active'
         AND revision.transcript_status IN ('final', 'corrected')
         AND revision.content_purged_at IS NULL
         AND event.current_revision_id = revision.conversation_event_revision_id
         AND NOT EXISTS (
           SELECT 1 FROM open_loop_run_outcomes run
           WHERE run.source_event_revision_id = revision.conversation_event_revision_id
             AND run.policy_version = $1
             AND run.status = 'settled'
         )
       ORDER BY revision.created_at ASC
       LIMIT $2`,
      [input.policyVersion, input.limit],
    );
    return result.rows.map((row) => ({
      eventRevisionId: row.event_revision_id,
      userId: asUserId(row.user_id),
      sourceRevision: Number(row.source_revision),
      expectedDataEpoch: Number(row.data_epoch),
    }));
  }

  /**
   * Resolve the per-Event subject of an admitted extract attempt from the
   * generation command row (mirroring the narrative-validation attempt
   * context read). The model-role outbox carries the owner as its subject,
   * so the durable Workflow resolves the Event revision here. Role and
   * owner are fenced in the query; anything else reports not_found.
   */
  public async readAttemptEventRevision(input: Readonly<{
    userId: ReturnType<typeof asUserId>;
    generationCommandId: string;
  }>): Promise<
    | Readonly<{ outcome: "ready"; eventRevisionId: string }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const result = await this.pool.query<{ subject_id: string }>(
      `SELECT gc.subject_id
       FROM generation_commands gc
       WHERE gc.generation_command_id = $1
         AND gc.user_id = $2
         AND gc.model_role = 'open_loop.extract'
         AND gc.subject_type = 'conversation_event_revision'`,
      [input.generationCommandId, input.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return { outcome: "not_found" };
    }
    return { outcome: "ready", eventRevisionId: row.subject_id };
  }

  /**
   * Frozen per-Event extraction input. Returns stale when the revision is
   * gone, purged, superseded, or fenced, so a late attempt fails closed
   * without burning the workflow retry budget.
   */
  public async readExtractionSnapshot(input: Readonly<{
    eventRevisionId: string;
  }>): Promise<
    | Readonly<{
        outcome: "ready";
        snapshot: {
          userId: ReturnType<typeof asUserId>;
          eventRevisionId: string;
          sourceRevision: number;
          expectedDataEpoch: number;
          locale: string;
          timeZone: string;
          userText: string;
          evidenceCommittedAt: string;
          evidence: readonly {
            evidenceItemId: ReturnType<typeof asEvidenceItemId>;
            revisionId: string;
            locatorType: string;
            locatorKey: string;
            committedAt: string;
          }[];
          identityCandidates: readonly {
            openLoopId: ReturnType<typeof asOpenLoopId>;
            kind: OpenLoopKind;
            canonicalClaimKey: string | null;
            expectedStartAt: string | null;
            expectedEndAt: string | null;
          }[];
          currentOpenCount: number;
        };
      }>
    | Readonly<{ outcome: "stale" }>
  > {
    const event = await this.pool.query<{
      user_id: string;
      revision: string;
      data_epoch: string;
      locale: string;
      canonical_text: string;
      created_at: string;
      timezone_at_start: string;
      current_revision_id: string | null;
    }>(
      `SELECT revision.user_id AS user_id,
              revision.revision::text AS revision,
              owner.data_epoch::text AS data_epoch,
              revision.locale AS locale,
              revision.canonical_text AS canonical_text,
              revision.created_at::text AS created_at,
              session.timezone_at_start AS timezone_at_start,
              event.current_revision_id::text AS current_revision_id
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
         AND event.user_id = revision.user_id
       INNER JOIN daily_sessions session
         ON session.daily_session_id = event.daily_session_id
         AND session.user_id = event.user_id
       INNER JOIN app_users owner
         ON owner.user_id = revision.user_id
       WHERE revision.conversation_event_revision_id = $1
         AND event.actor = 'user'
         AND event.event_type = 'message'
         AND event.lifecycle_status = 'active'
         AND revision.transcript_status IN ('final', 'corrected')
         AND revision.content_purged_at IS NULL`,
      [input.eventRevisionId],
    );
    const row = event.rows[0];
    if (!row || row.current_revision_id !== input.eventRevisionId) {
      return { outcome: "stale" };
    }
    const evidence = await this.pool.query<{
      evidence_item_id: string;
      source_revision_id: string;
      locator_type: string;
      locator_key: string;
      created_at: string;
    }>(
      `SELECT evidence_item_id::text AS evidence_item_id,
              source_revision_id::text AS source_revision_id,
              locator_type,
              locator_key,
              created_at::text AS created_at
       FROM evidence_items
       WHERE source_revision_id = $1
         AND status = 'active'
       ORDER BY locator_key ASC`,
      [input.eventRevisionId],
    );
    const candidates = await this.pool.query<{
      open_loop_id: string;
      open_loop_kind: string;
      canonical_claim_key: string | null;
      expected_start_at: string | null;
      expected_end_at: string | null;
    }>(
      `SELECT l.open_loop_id::text AS open_loop_id,
              v.open_loop_kind AS open_loop_kind,
              v.canonical_claim_key AS canonical_claim_key,
              v.expected_start_at::text AS expected_start_at,
              v.expected_end_at::text AS expected_end_at
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       WHERE l.user_id = $1
         AND l.deleted_at IS NULL
         AND v.status = 'open'`,
      [row.user_id],
    );
    return {
      outcome: "ready",
      snapshot: {
        userId: asUserId(row.user_id),
        eventRevisionId: input.eventRevisionId,
        sourceRevision: Number(row.revision),
        expectedDataEpoch: Number(row.data_epoch),
        locale: row.locale,
        timeZone: row.timezone_at_start,
        userText: row.canonical_text,
        evidenceCommittedAt: row.created_at,
        evidence: evidence.rows.map((item) => ({
          evidenceItemId: asEvidenceItemId(item.evidence_item_id),
          revisionId: item.source_revision_id,
          locatorType: item.locator_type,
          locatorKey: item.locator_key,
          committedAt: item.created_at,
        })),
        identityCandidates: candidates.rows
          .filter((candidate) => isOpenLoopKind(candidate.open_loop_kind))
          .map((candidate) => ({
            openLoopId: asOpenLoopId(candidate.open_loop_id),
            kind: candidate.open_loop_kind as OpenLoopKind,
            canonicalClaimKey: candidate.canonical_claim_key,
            expectedStartAt: candidate.expected_start_at,
            expectedEndAt: candidate.expected_end_at,
          })),
        currentOpenCount: candidates.rows.length,
      },
    };
  }

  public async commitEventEffects(input: Readonly<{
    userId: string;
    sourceEventRevisionId: string;
    expectedDataEpoch: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    policyVersion: string;
    formations: readonly OpenLoopFormationEffect[];
    closures: readonly OpenLoopClosureEffect[];
    ambiguousSuppressedTargetIds: readonly string[];
    now: Date;
  }>): Promise<
    Readonly<
      | { outcome: "settled"; formed: number; closed: number; suppressed: number }
      | { outcome: "already_settled"; formed: number; closed: number; suppressed: number }
      | { outcome: "fenced"; reason: string }
    >
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ data_epoch: string }>(
        `SELECT data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (owner.rows.length === 0) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "owner_missing" };
      }
      if (Number(owner.rows[0]?.data_epoch) !== input.expectedDataEpoch) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "data_epoch" };
      }
      const existing = await client.query<{
        formed_count: number;
        closed_count: number;
        suppressed_count: number;
      }>(
        `SELECT formed_count, closed_count, suppressed_count
         FROM open_loop_run_outcomes
         WHERE user_id = $1 AND source_event_revision_id = $2 AND policy_version = $3`,
        [input.userId, input.sourceEventRevisionId, input.policyVersion],
      );
      if (existing.rows.length > 0) {
        await client.query("COMMIT");
        const row = existing.rows[0]!;
        return {
          outcome: "already_settled",
          formed: row.formed_count,
          closed: row.closed_count,
          suppressed: row.suppressed_count,
        };
      }
      // Pre-transaction snapshot for closure (new Loops below are invisible
      // to this Event's own closure resolver by construction). Expired rows
      // stay visible so a pre-expiry Event can still win its arbitration
      // against an already-materialized expiry; the per-target check below
      // enforces committed_at < expires_at.
      const snapshot = await client.query<{ open_loop_id: string }>(
        `SELECT l.open_loop_id
         FROM open_loops l
         INNER JOIN open_loop_versions v
           ON v.open_loop_version_id = l.current_version_id
         WHERE l.user_id = $1 AND v.status IN ('open', 'expired')`,
        [input.userId],
      );
      const closableBefore = new Set(
        snapshot.rows.map((row) => row.open_loop_id),
      );
      let formed = 0;
      let closed = 0;
      // Closure first: terminal Versions supersede the pre-transaction
      // snapshot. Same-Event formations below can never be closed here.
      for (const closure of input.closures) {
        if (!closableBefore.has(closure.targetOpenLoopId)) {
          continue;
        }
        const current = await client.query<{
          open_loop_version_id: string;
          revision: number;
          open_loop_kind: string;
          status: string;
          expires_at: string;
        }>(
          `SELECT v.open_loop_version_id, v.revision, v.open_loop_kind,
                  v.status, v.expires_at::text
           FROM open_loops l
           INNER JOIN open_loop_versions v
             ON v.open_loop_version_id = l.current_version_id
           WHERE l.open_loop_id = $1 AND l.user_id = $2
             AND v.status IN ('open', 'expired')
           FOR UPDATE OF l`,
          [closure.targetOpenLoopId, input.userId],
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          continue;
        }
        // Terminal arbitration on the authoritative User Event committed_at:
        // a pre-expiry Event wins even when the scanner already wrote
        // expired (the intermediate expired row is retained); boundary-equal
        // or later Events never rewrite expired. Occurred/resolved/canceled
        // never reopen, so only open/expired rows arrive here.
        if (currentRow.status === "expired") {
          const committed = new Date(closure.closureCommittedAt).getTime();
          const expiry = new Date(currentRow.expires_at).getTime();
          if (!(committed < expiry)) {
            continue;
          }
        }
        const versionId = createUuidV7(input.now);
        const contentExpiresAt = new Date(
          new Date(closure.closureCommittedAt).getTime() + 30 * 86_400_000,
        );
        await client.query(
          `INSERT INTO open_loop_versions (
             open_loop_version_id, open_loop_id, user_id, revision,
             open_loop_kind, source_evidence_item_id, source_event_revision_id,
             time_precision, timezone,
             followup_eligible_from_at, expires_at, expiry_source, status,
             closure_event_revision_id, policy_version, generation_command_id,
             model_run_attempt_id, supersedes_version_id,
             terminal_effective_at, terminal_processed_at, content_expires_at,
             created_at
           )
           SELECT $1, $2, $3, revision + 1,
             open_loop_kind, source_evidence_item_id, source_event_revision_id,
             time_precision, timezone,
             followup_eligible_from_at, expires_at, expiry_source, $4,
             $5, policy_version, $6, $7, open_loop_version_id,
             $8::timestamptz, $9::timestamptz, $10::timestamptz, $9::timestamptz
           FROM open_loop_versions WHERE open_loop_version_id = $11`,
          [
            versionId,
            closure.targetOpenLoopId,
            input.userId,
            closure.terminalStatus,
            closure.closureEventRevisionId,
            input.generationCommandId,
            input.modelRunAttemptId,
            closure.closureCommittedAt,
            input.now.toISOString(),
            contentExpiresAt.toISOString(),
            currentRow.open_loop_version_id,
          ],
        );
        await client.query(
          `UPDATE open_loops SET current_version_id = $1
           WHERE open_loop_id = $2 AND user_id = $3`,
          [versionId, closure.targetOpenLoopId, input.userId],
        );
        await client.query(
          `INSERT INTO open_loop_closure_audits (
             open_loop_closure_audit_id, user_id, source_event_revision_id,
             target_open_loop_id, proposed_status, resolver_policy_version,
             disposition, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'closed', $7)
           ON CONFLICT DO NOTHING`,
          [
            createUuidV7(input.now),
            input.userId,
            input.sourceEventRevisionId,
            closure.targetOpenLoopId,
            closure.terminalStatus,
            input.policyVersion,
            input.now,
          ],
        );
        closableBefore.delete(closure.targetOpenLoopId);
        closed += 1;
        // A unique close releases the co-suppressed non-targets grouped by
        // the same ambiguous event: later unique Evidence resolves the
        // identity, so the proven non-targets leave suppression. Targets
        // suppressed by other ambiguous events stay fenced.
        await client.query(
          `DELETE FROM open_loop_closure_audits release
           USING open_loop_closure_audits anchor
           WHERE release.disposition = 'ambiguous_suppressed'
             AND anchor.disposition = 'ambiguous_suppressed'
             AND anchor.target_open_loop_id = $1
             AND anchor.user_id = $2
             AND release.source_event_revision_id = anchor.source_event_revision_id
             AND release.target_open_loop_id <> $1
             AND release.user_id = $2`,
          [closure.targetOpenLoopId, input.userId],
        );
      }
      // Ambiguous closure suppresses every reasonable target atomically and
      // closes none. The audit is content-free; the read lane fences
      // suppressed targets until unique later Evidence resolves them.
      for (const targetId of input.ambiguousSuppressedTargetIds) {
        if (!closableBefore.has(targetId)) {
          continue;
        }
        await client.query(
          `INSERT INTO open_loop_closure_audits (
             open_loop_closure_audit_id, user_id, source_event_revision_id,
             target_open_loop_id, proposed_status, resolver_policy_version,
             disposition, created_at
           ) VALUES ($1, $2, $3, $4, 'ambiguous_closure', $5, 'ambiguous_suppressed', $6)
           ON CONFLICT DO NOTHING`,
          [
            createUuidV7(input.now),
            input.userId,
            input.sourceEventRevisionId,
            targetId,
            input.policyVersion,
            input.now,
          ],
        );
      }
      const suppressed = input.ambiguousSuppressedTargetIds.filter((targetId) =>
        snapshot.rows.some((row) => row.open_loop_id === targetId),
      ).length;
      // Formation last, against the updated state with freed capacity.
      // Deterministic capacity: at most 4 new Loops per Event and 128
      // current open per owner (suppressed included); closure frees slots
      // first; overflow selects by followup ASC, expiry ASC, locator ASC with
      // no model importance and never evicts existing state.
      const openCountRow = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM open_loops l
         INNER JOIN open_loop_versions v
           ON v.open_loop_version_id = l.current_version_id
         WHERE l.user_id = $1 AND v.status = 'open'`,
        [input.userId],
      );
      const admitted = selectFormationCandidates({
        candidates: input.formations.map((formation, proposalIndex) => ({
          proposalIndex,
          followupEligibleFromAt: formation.followupEligibleFromAt,
          expiresAt: formation.expiresAt,
          evidenceLocator: formation.sourceEvidenceItemId,
        })),
        currentOpenCount: Number(openCountRow.rows[0]?.count ?? 0),
        freedByClosureCount: closed,
      });
      const admittedIndexes = new Set(
        admitted.selected.map((candidate) => candidate.proposalIndex),
      );
      for (let index = 0; index < input.formations.length; index += 1) {
        const formation = input.formations[index]!;
        if (formation.reuseOpenLoopId) {
          continue;
        }
        if (!admittedIndexes.has(index)) {
          continue;
        }
        const loopId = createUuidV7(input.now);
        const versionId = createUuidV7(input.now);
        await client.query(
          `INSERT INTO open_loops (open_loop_id, user_id, open_loop_kind, current_version_id, created_at)
           VALUES ($1, $2, $3, NULL, $4)`,
          [loopId, input.userId, formation.kind, input.now],
        );
        await client.query(
          `INSERT INTO open_loop_versions (
             open_loop_version_id, open_loop_id, user_id, revision,
             open_loop_kind, source_evidence_item_id, source_event_revision_id,
             source_claim_version_id, source_episode_version_id,
             canonical_claim_key, localized_summary,
             expected_start_at, expected_end_at, time_precision, timezone,
             followup_eligible_from_at, expires_at, expiry_source, status,
             policy_version, generation_command_id, model_run_attempt_id,
             content_expires_at, created_at
           ) VALUES (
             $1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10,
             $11::timestamptz, $12::timestamptz, $13, $14,
             $15::timestamptz, $16::timestamptz, $17, 'open',
             $18, $19, $20,
             ($16::timestamptz + make_interval(days => 30)), $21
           )`,
          [
            versionId,
            loopId,
            input.userId,
            formation.kind,
            formation.sourceEvidenceItemId,
            formation.sourceEventRevisionId,
            formation.sourceClaimVersionId,
            formation.sourceEpisodeVersionId,
            formation.canonicalClaimKey,
            formation.localizedSummary,
            formation.expectedStartAt,
            formation.expectedEndAt,
            formation.timePrecision,
            formation.timezone,
            formation.followupEligibleFromAt,
            formation.expiresAt,
            formation.expirySource,
            input.policyVersion,
            input.generationCommandId,
            input.modelRunAttemptId,
            input.now,
          ],
        );
        await client.query(
          `UPDATE open_loops SET current_version_id = $1
           WHERE open_loop_id = $2 AND user_id = $3`,
          [versionId, loopId, input.userId],
        );
        formed += 1;
      }
      await client.query(
        `INSERT INTO open_loop_run_outcomes (
           open_loop_run_outcome_id, user_id, source_event_revision_id,
           policy_version, expected_data_epoch, generation_command_id,
           model_run_attempt_id, status, formed_count, closed_count,
           suppressed_count, skipped_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'settled', $8, $9, $10, $11, $12, $12)`,
        [
          createUuidV7(input.now),
          input.userId,
          input.sourceEventRevisionId,
          input.policyVersion,
          input.expectedDataEpoch,
          input.generationCommandId,
          input.modelRunAttemptId,
          formed,
          closed,
          suppressed,
          Math.max(0, input.formations.length - formed),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { outcome: "settled", formed, closed, suppressed };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures after the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent expiry scanner: read-path expiry is immediate
   * (`now >= expires_at` excluded); this pass only materializes immutable
   * history with the stable (loop, version, policy) identity. The terminal
   * effective time is the original `expires_at`; processed time is the actual
   * commit. The scanner creates no GenerationCommand or message.
   */
  public async expireDueLoops(input: Readonly<{
    now: Date;
    policyVersion: string;
    limit?: number;
  }>): Promise<Readonly<{ expired: number }>> {
    const limit = input.limit ?? 100;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        open_loop_id: string;
        open_loop_version_id: string;
        user_id: string;
        expires_at: string;
      }>(
        `SELECT l.open_loop_id, v.open_loop_version_id, l.user_id,
                v.expires_at::text
         FROM open_loops l
         INNER JOIN open_loop_versions v
           ON v.open_loop_version_id = l.current_version_id
         WHERE v.status = 'open' AND v.expires_at <= $1
         ORDER BY v.expires_at ASC, l.open_loop_id ASC
         LIMIT $2
         FOR UPDATE OF l SKIP LOCKED`,
        [input.now.toISOString(), limit],
      );
      let expired = 0;
      for (const row of due.rows) {
        const versionId = createUuidV7(input.now);
        const contentExpiresAt = new Date(
          new Date(row.expires_at).getTime() + 30 * 86_400_000,
        );
        const inserted = await client.query(
          `INSERT INTO open_loop_expiry_runs (
             open_loop_expiry_run_id, user_id, open_loop_id,
             expiring_version_id, policy_version,
             terminal_effective_at, terminal_processed_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $7::timestamptz)
           ON CONFLICT (open_loop_id, expiring_version_id, policy_version) DO NOTHING
           RETURNING open_loop_expiry_run_id`,
          [
            createUuidV7(input.now),
            row.user_id,
            row.open_loop_id,
            row.open_loop_version_id,
            input.policyVersion,
            row.expires_at,
            input.now.toISOString(),
          ],
        );
        if (inserted.rows.length === 0) {
          continue;
        }
        await client.query(
          `INSERT INTO open_loop_versions (
             open_loop_version_id, open_loop_id, user_id, revision,
             open_loop_kind, source_evidence_item_id, source_event_revision_id,
             time_precision, timezone,
             followup_eligible_from_at, expires_at, expiry_source, status,
             policy_version, generation_command_id, model_run_attempt_id,
             supersedes_version_id, terminal_effective_at,
             terminal_processed_at, content_expires_at, created_at
           )
           SELECT $1, $2, $3, revision + 1,
             open_loop_kind, source_evidence_item_id, source_event_revision_id,
             time_precision, timezone,
             followup_eligible_from_at, expires_at, expiry_source, 'expired',
             $4, generation_command_id, model_run_attempt_id,
             open_loop_version_id, expires_at, $5::timestamptz,
             $6::timestamptz, $5::timestamptz
           FROM open_loop_versions WHERE open_loop_version_id = $7`,
          [
            versionId,
            row.open_loop_id,
            row.user_id,
            input.policyVersion,
            input.now.toISOString(),
            contentExpiresAt.toISOString(),
            row.open_loop_version_id,
          ],
        );
        await client.query(
          `UPDATE open_loops SET current_version_id = $1
           WHERE open_loop_id = $2`,
          [versionId, row.open_loop_id],
        );
        expired += 1;
      }
      await client.query("COMMIT");
      return { expired };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures after the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Open lane read with the complete-watermark gate, source fences and the
   * 30-day summary grace enforced at read time. Suppressed targets stay
   * fenced until unique later Evidence resolves them; source deletion and
   * Full Purge take effect immediately through the joined Evidence status
   * and the purge sweeper.
   */
  public async readOpenLane(input: Readonly<{
    userId: string;
    now: Date;
    watermarkReadable: boolean;
  }>): Promise<
    readonly Readonly<{
      openLoopId: string;
      openLoopVersionId: string;
      kind: string;
      localizedSummary: string | null;
      expectedStartAt: string | null;
      expectedEndAt: string | null;
      timePrecision: string;
      timezone: string | null;
      expiresAt: string;
      evidenceAt: string;
      followupEligible: boolean;
      suppressed: boolean;
    }>[]
  > {
    if (!input.watermarkReadable) {
      return [];
    }
    const result = await this.pool.query<{
      open_loop_id: string;
      open_loop_version_id: string;
      open_loop_kind: string;
      localized_summary: string | null;
      expected_start_at: string | null;
      expected_end_at: string | null;
      time_precision: string;
      timezone: string | null;
      followup_eligible_from_at: string;
      expires_at: string;
      content_expires_at: string | null;
      evidence_at: string;
      suppressed: boolean;
    }>(
      `SELECT l.open_loop_id,
              v.open_loop_version_id,
              v.open_loop_kind,
              CASE
                WHEN v.content_expires_at IS NOT NULL
                  AND $2::timestamptz >= v.content_expires_at THEN NULL
                ELSE v.localized_summary
              END AS localized_summary,
              v.expected_start_at::text,
              v.expected_end_at::text,
              v.time_precision,
              v.timezone,
              v.followup_eligible_from_at::text,
              v.expires_at::text,
              v.content_expires_at::text,
              evidence.created_at::text AS evidence_at,
              EXISTS (
                SELECT 1 FROM open_loop_closure_audits audit
                WHERE audit.target_open_loop_id = l.open_loop_id
                  AND audit.disposition = 'ambiguous_suppressed'
              ) AS suppressed
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       INNER JOIN evidence_items evidence
         ON evidence.evidence_item_id = v.source_evidence_item_id
         AND evidence.status = 'active'
       WHERE l.user_id = $1
         AND l.deleted_at IS NULL
         AND v.status = 'open'
         AND v.content_purged_at IS NULL
         AND v.followup_eligible_from_at <= $2::timestamptz
         AND $2::timestamptz < v.expires_at`,
      [input.userId, input.now.toISOString()],
    );
    return result.rows.map((row) => ({
      openLoopId: asOpenLoopId(row.open_loop_id),
      openLoopVersionId: row.open_loop_version_id,
      kind: row.open_loop_kind,
      localizedSummary: row.localized_summary,
      expectedStartAt: row.expected_start_at,
      expectedEndAt: row.expected_end_at,
      timePrecision: row.time_precision,
      timezone: row.timezone,
      expiresAt: row.expires_at,
      evidenceAt: row.evidence_at,
      followupEligible: true,
      suppressed: row.suppressed,
    }));
  }

  public async countCurrentOpen(input: Readonly<{ userId: string }>): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       WHERE l.user_id = $1 AND v.status = 'open'`,
      [input.userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async readVersion(input: Readonly<{ openLoopId: string }>): Promise<Readonly<{
    status: string;
    revision: number;
    terminalEffectiveAt: string | null;
  }> | null> {
    const result = await this.pool.query<{
      status: string;
      revision: number;
      terminal_effective_at: string | null;
    }>(
      `SELECT v.status, v.revision, v.terminal_effective_at::text
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       WHERE l.open_loop_id = $1`,
      [input.openLoopId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      status: row.status,
      revision: row.revision,
      terminalEffectiveAt: row.terminal_effective_at,
    };
  }

  public async assertNoPartialWrite(input: Readonly<{
    userId: string;
    sourceEventRevisionId: string;
    policyVersion: string;
  }>): Promise<boolean> {
    const outcome = await this.pool.query(
      `SELECT 1 FROM open_loop_run_outcomes
       WHERE user_id = $1 AND source_event_revision_id = $2 AND policy_version = $3`,
      [input.userId, input.sourceEventRevisionId, input.policyVersion],
    );
    return outcome.rows.length > 0;
  }

  /**
   * Lane-watermark probe for proactive selection (issue #207 layer 2c). True
   * when any in-scope user event at or before the request sequence still
   * lacks a settled extraction run, in which case the open-loop lane reports
   * incomplete and selection fails closed instead of ranking a stale view.
   */
  public async hasUnsettledExtraction(input: Readonly<{
    userId: string;
    policyVersion: string;
    throughSequence: number;
  }>): Promise<boolean> {
    const result = await this.pool.query<{ found: string }>(
      `SELECT 1 AS found
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
         AND event.user_id = revision.user_id
       WHERE revision.user_id = $1
         AND event.actor = 'user'
         AND event.event_type = 'message'
         AND event.lifecycle_status = 'active'
         AND event.sequence_no <= $3
         AND revision.transcript_status IN ('final', 'corrected')
         AND revision.content_purged_at IS NULL
         AND event.current_revision_id = revision.conversation_event_revision_id
         AND NOT EXISTS (
           SELECT 1 FROM open_loop_run_outcomes run
           WHERE run.source_event_revision_id = revision.conversation_event_revision_id
             AND run.policy_version = $2
             AND run.status = 'settled'
         )
       LIMIT 1`,
      [input.userId, input.policyVersion, input.throughSequence],
    );
    return result.rows.length > 0;
  }

  /**
   * Formation lineage for proactive selection (issue #207 layer 2c).
   * Returns the forming event revision per loop plus the latest committed
   * proactive use time for least-recently-used ranking. Loops without a use
   * report null and rank as never-used per the v1 selection policy.
   */
  public async readLoopFormation(input: Readonly<{
    userId: string;
    openLoopIds: readonly string[];
  }>): Promise<
    Readonly<
      Record<string, { sourceEventRevisionId: string; lastUsedAt: string | null }>
    >
  > {
    if (input.openLoopIds.length === 0) return {};
    const result = await this.pool.query<{
      open_loop_id: string;
      source_event_revision_id: string;
      last_used_at: string | null;
    }>(
      `SELECT l.open_loop_id,
              v.source_event_revision_id::text,
              MAX(use.created_at)::text AS last_used_at
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       LEFT JOIN proactive_followup_uses use
         ON use.target_id = l.open_loop_id
         AND use.user_id = l.user_id
         AND use.target_kind = 'open_loop'
       WHERE l.user_id = $1
         AND l.open_loop_id = ANY($2::uuid[])
       GROUP BY l.open_loop_id, v.source_event_revision_id`,
      [input.userId, input.openLoopIds],
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.open_loop_id,
        {
          sourceEventRevisionId: row.source_event_revision_id,
          lastUsedAt: row.last_used_at,
        },
      ]),
    );
  }

  /**
   * Content-gated current summary for the segment provider request (issue
   * #207 layer 2c). Mirrors the readOpenLane gating: expired content,
   * purged content, and inactive sources yield null so the model renders a
   * generic expression without inventing facts.
   */
  public async readCurrentSummary(input: Readonly<{
    userId: string;
    openLoopId: string;
    now: Date;
  }>): Promise<string | null> {
    const result = await this.pool.query<{ localized_summary: string | null }>(
      `SELECT CASE
                WHEN v.content_expires_at IS NOT NULL
                  AND $3::timestamptz >= v.content_expires_at THEN NULL
                ELSE v.localized_summary
              END AS localized_summary
       FROM open_loops l
       INNER JOIN open_loop_versions v
         ON v.open_loop_version_id = l.current_version_id
       INNER JOIN evidence_items evidence
         ON evidence.evidence_item_id = v.source_evidence_item_id
         AND evidence.status = 'active'
       WHERE l.open_loop_id = $1
         AND l.user_id = $2
         AND l.deleted_at IS NULL
         AND v.status = 'open'
         AND v.content_purged_at IS NULL`,
      [input.openLoopId, input.userId, input.now.toISOString()],
    );
    return result.rows[0]?.localized_summary ?? null;
  }

  /**
   * Read the exact, current User Event Evidence that formed one selected
   * Open Loop. The text is transient Provider input; it is never written to
   * the loop, selection manifest, or use record. Corrections, Purge, or an
   * ambiguous multi-loop binding make this read fail closed.
   */
  public async readSourceEvidence(input: Readonly<{
    userId: string;
    openLoopId: string;
    openLoopVersionId: string;
    expectedSourceEventRevisionId: string;
  }>): Promise<Readonly<{
    eventRevisionId: string;
    revision: number;
    text: string;
  }> | null> {
    const result = await this.pool.query<{
      source_event_revision_id: string;
      source_revision: number;
      canonical_text: string;
      binding_count: string;
    }>(
      `SELECT revision.conversation_event_revision_id::text
                AS source_event_revision_id,
              revision.revision AS source_revision,
              revision.canonical_text,
              COUNT(*) OVER ()::text AS binding_count
       FROM open_loops loop
       INNER JOIN open_loop_versions version
         ON version.open_loop_version_id = loop.current_version_id
        AND version.open_loop_version_id = $3
       INNER JOIN evidence_items evidence
         ON evidence.evidence_item_id = version.source_evidence_item_id
        AND evidence.user_id = loop.user_id
        AND evidence.status = 'active'
        AND evidence.source_actor = 'user'
        AND evidence.source_revision_id = version.source_event_revision_id
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id =
            version.source_event_revision_id
        AND revision.user_id = loop.user_id
        AND revision.content_purged_at IS NULL
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
        AND event.user_id = loop.user_id
        AND event.actor = 'user'
        AND event.current_revision_id = revision.conversation_event_revision_id
       WHERE loop.user_id = $1
         AND loop.open_loop_id = $2
         AND loop.deleted_at IS NULL
         AND version.status = 'open'
         AND version.content_purged_at IS NULL
         AND version.source_event_revision_id = $4
         AND (
           SELECT COUNT(*)
           FROM open_loops other_loop
           INNER JOIN open_loop_versions other_version
             ON other_version.open_loop_version_id = other_loop.current_version_id
           WHERE other_loop.user_id = loop.user_id
             AND other_loop.deleted_at IS NULL
             AND other_version.status = 'open'
             AND other_version.source_event_revision_id = version.source_event_revision_id
             AND other_version.open_loop_kind = version.open_loop_kind
             AND other_version.expected_start_at IS NOT DISTINCT FROM version.expected_start_at
             AND other_version.expected_end_at IS NOT DISTINCT FROM version.expected_end_at
             AND other_version.time_precision = version.time_precision
             AND other_version.timezone IS NOT DISTINCT FROM version.timezone
         ) = 1`,
      [
        input.userId,
        input.openLoopId,
        input.openLoopVersionId,
        input.expectedSourceEventRevisionId,
      ],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      Number(row.binding_count) !== 1 ||
      !row.canonical_text.trim()
    ) {
      return null;
    }
    return {
      eventRevisionId: row.source_event_revision_id,
      revision: row.source_revision,
      text: row.canonical_text,
    };
  }
}
