import type { EvidenceChampion, EvidenceExtractionProvider, EvidenceRepository, EvidenceSourceSnapshot } from "@sayhear/application";
import { asDailySessionId, type DailySessionId } from "@sayhear/domain";
import type { Pool } from "pg";
import { lockActiveOwnerEpoch } from "./postgres-owner-epoch-fence";
import { createUuidV7 } from "./uuid-v7";

type SnapshotRow = {
  evidence_source_snapshot_id: string;
  user_id: string;
  daily_session_id: string;
  source_revision: string;
  extraction_policy_version: string;
  command_id: string;
  attempt_id: string;
  champion_config_version: string;
  champion_provider: "openai" | "deepseek";
  champion_model: string;
  champion_snapshot: string;
  champion_provider_policy_version: string;
};

export class PostgresEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly pool: Pool, private readonly extractor: EvidenceExtractionProvider) {}

  public async freezeUserEvidence(input: Parameters<EvidenceRepository["freezeUserEvidence"]>[0]): ReturnType<EvidenceRepository["freezeUserEvidence"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string; activity_state: string; source_revision: string;
      }>("SELECT user_id, activity_state, source_revision FROM daily_sessions WHERE daily_session_id = $1 FOR UPDATE", [input.dailySessionId]);
      const row = session.rows[0];
      if (!row) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      if (row.activity_state === "active") { await client.query("ROLLBACK"); return { outcome: "stale" }; }
      if (Number(row.source_revision) !== input.sourceRevision) { await client.query("ROLLBACK"); return { outcome: "stale" }; }
      const ownerEpoch = await lockActiveOwnerEpoch(client, row.user_id);
      if (ownerEpoch === null || ownerEpoch !== input.expectedDataEpoch) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      const snapshotId = createUuidV7(input.now);
      const snapshotResult = await client.query<SnapshotRow & { inserted: boolean }>(
        `INSERT INTO evidence_source_snapshots (
          evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
          extraction_policy_version, command_id, attempt_id, champion_config_version,
          champion_provider, champion_model, champion_snapshot, champion_provider_policy_version, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (daily_session_id, source_revision, extraction_policy_version)
        DO NOTHING
        RETURNING *, (xmax = 0) AS inserted`,
        [snapshotId, row.user_id, input.dailySessionId, input.sourceRevision, input.extractionPolicyVersion, input.commandId, input.attemptId, input.champion.configVersion, input.champion.provider, input.champion.model, input.champion.snapshot, input.champion.providerPolicyVersion, input.now],
      );
      let snapshot = snapshotResult.rows[0];
      if (!snapshot) {
        const existing = await client.query<SnapshotRow>(
          `SELECT * FROM evidence_source_snapshots
           WHERE daily_session_id = $1 AND source_revision = $2
             AND extraction_policy_version = $3 FOR UPDATE`,
          [input.dailySessionId, input.sourceRevision, input.extractionPolicyVersion],
        );
        snapshot = { ...existing.rows[0]!, inserted: false };
      }
      await client.query(
        `INSERT INTO evidence_model_run_attempts (
           evidence_model_run_attempt_id, evidence_source_snapshot_id, role, provider, model,
           config_version, extraction_policy_version, prompt_fingerprint, status, created_at
         ) VALUES ($1, $2, 'evidence.extract', $3, $4, $5, $6, $7, 'started', $8)
         ON CONFLICT DO NOTHING`,
        [input.attemptId, snapshot.evidence_source_snapshot_id, input.champion.provider, input.champion.model,
          input.champion.configVersion, input.extractionPolicyVersion, input.champion.snapshot, input.now],
      );
      const sourceRows = await client.query<{
        user_id: string; conversation_event_id: string; conversation_event_revision_id: string; transcript_status: "final" | "corrected"; canonical_text: string; locale: string;
      }>(`SELECT event.user_id, event.conversation_event_id, revision.conversation_event_revision_id, revision.transcript_status,
          revision.canonical_text, revision.locale
        FROM conversation_events event
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = event.current_revision_id
          AND revision.conversation_event_id = event.conversation_event_id
          AND revision.user_id = event.user_id
        WHERE event.daily_session_id = $1 AND event.user_id = $2
          AND event.actor = 'user' AND event.lifecycle_status = 'active'
          AND revision.transcript_status IN ('final', 'corrected')
          AND revision.content_purged_at IS NULL`, [input.dailySessionId, row.user_id]);
      const sources = sourceRows.rows;
      // Provider evidence extraction is network-bound: one DeepSeek/OpenAI
      // round-trip per source, ~20s each from production (Vercel), against a
      // 60s function ceiling (Vercel Hobby). A serial pass exceeded the timeout
      // on every replay, so sources are extracted concurrently (incident
      // 2026-08-18, category=timeout). Even concurrently, a single slow source
      // that hits the provider deadline must not fail the whole freeze: each
      // source settles independently and the successful extractions are kept.
      const extractedChunks = await Promise.allSettled(
        sources.map((source) => this.extractor.extract({ locale: source.locale, sourceText: source.canonical_text })),
      );
      let insertedSources = 0;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;
        const settled = extractedChunks[i]!;
        if (settled.status === "rejected") {
          // Runtime log only (never Workflow history): a transient provider
          // failure on one source is not a reason to discard the rest.
          console.error(
            "[evidence-freeze] source extraction failed:",
            settled.reason instanceof Error ? `${settled.reason.name}: ${settled.reason.message}` : String(settled.reason),
          );
          continue;
        }
        const extracted = settled.value;
        if (extracted.length === 0) continue;
        insertedSources++;
        for (const locator of extracted) await client.query(
        `INSERT INTO evidence_items (
          evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
          source_revision_id, source_actor, source_status, locator_type, locator_key,
          extraction_policy_version, evidence_role, created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8, $9, $10, $11)
        ON CONFLICT (user_id, source_revision_id, locator_key, extraction_policy_version) DO NOTHING`,
        [createUuidV7(input.now), source.user_id, snapshot.evidence_source_snapshot_id, source.conversation_event_id, source.conversation_event_revision_id, source.transcript_status, locator.locatorType, locator.locatorKey, input.extractionPolicyVersion, locator.role, input.now],
        );
      }
      if (sourceRows.rows.length === 0) {
        await client.query("ROLLBACK");
        return { outcome: "not_eligible" };
      }
      if (insertedSources === 0) {
        // Every source failed or produced no usable locators — a provider-level
        // outage, not a valid but empty transcript. Fail so the workflow records
        // retryable_failed and the recovery scan can retry later.
        throw new Error("Evidence extraction failed for every source.");
      }
      await client.query(
        `INSERT INTO evidence_lineage (evidence_item_id, command_id, attempt_id, created_at)
         SELECT evidence_item_id, $2, $3, $4 FROM evidence_items
         WHERE evidence_source_snapshot_id = $1
         ON CONFLICT (evidence_item_id) DO NOTHING`,
        [snapshot.evidence_source_snapshot_id, input.commandId, input.attemptId, input.now],
      );
      const items = await client.query<EvidenceItemRow>(`SELECT evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id, source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version, evidence_role, status FROM evidence_items WHERE evidence_source_snapshot_id = $1 ORDER BY source_revision_id`, [snapshot.evidence_source_snapshot_id]);
      await client.query(
        `UPDATE evidence_model_run_attempts
         SET status = 'completed', provider_completed_at = $2,
             result_metadata = jsonb_build_object('evidence_item_count', $3::int)
         WHERE evidence_model_run_attempt_id = $1 AND status = 'started'`,
        [input.attemptId, input.now, items.rows.length],
      );
      await client.query("COMMIT");
      return { outcome: "frozen", snapshot: toSnapshot(snapshot, items.rows) };
    } catch (error) {
      await client.query("ROLLBACK");
      await this.pool.query(
        `INSERT INTO evidence_model_run_attempts (
           evidence_model_run_attempt_id, evidence_source_snapshot_id, role, provider, model,
           config_version, extraction_policy_version, prompt_fingerprint, status,
           result_metadata, provider_completed_at, created_at
         ) VALUES ($1, NULL, 'evidence.extract', $2, $3, $4, $5, $6, 'failed',
           jsonb_build_object('failure_code', $7::text), $8, $8)
         ON CONFLICT (evidence_model_run_attempt_id) DO NOTHING`,
        [input.attemptId, input.champion.provider, input.champion.model,
          input.champion.configVersion, input.extractionPolicyVersion, input.champion.snapshot,
          "evidence_extraction_failed", input.now],
      );
      throw error;
    } finally { client.release(); }
  }

  public async findEvidenceSnapshot(input: { dailySessionId: DailySessionId; sourceRevision: number }): Promise<EvidenceSourceSnapshot | null> {
    const result = await this.pool.query<SnapshotRow>("SELECT * FROM evidence_source_snapshots WHERE daily_session_id = $1 AND source_revision = $2", [input.dailySessionId, input.sourceRevision]);
    const snapshot = result.rows[0];
    if (!snapshot) return null;
    const items = await this.pool.query<EvidenceItemRow>("SELECT evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id, source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version, evidence_role, status FROM evidence_items WHERE evidence_source_snapshot_id = $1 ORDER BY source_revision_id", [snapshot.evidence_source_snapshot_id]);
    return toSnapshot(snapshot, items.rows);
  }
}

type EvidenceItemRow = {
  evidence_item_id: string; user_id: string; evidence_source_snapshot_id: string;
  source_event_id: string; source_revision_id: string; source_actor: "user";
  source_status: "final" | "corrected"; locator_type: EvidenceSourceSnapshot["evidenceItems"][number]["locatorType"];
  locator_key: string; extraction_policy_version: string;
  evidence_role: EvidenceSourceSnapshot["evidenceItems"][number]["role"]; status: "active";
};

function toSnapshot(row: SnapshotRow, items: EvidenceItemRow[]): EvidenceSourceSnapshot {
  return {
    id: row.evidence_source_snapshot_id,
    dailySessionId: asDailySessionId(row.daily_session_id),
    userId: row.user_id,
    sourceRevision: Number(row.source_revision),
    extractionPolicyVersion: row.extraction_policy_version,
    commandId: row.command_id,
    attemptId: row.attempt_id,
    champion: {
      configVersion: row.champion_config_version,
      model: row.champion_model,
      provider: row.champion_provider,
      snapshot: row.champion_snapshot,
      providerPolicyVersion: row.champion_provider_policy_version,
    } satisfies EvidenceChampion,
    evidenceItems: items.map((item) => ({ id: item.evidence_item_id, userId: item.user_id, sourceSnapshotId: item.evidence_source_snapshot_id, sourceRevisionId: item.source_revision_id, sourceEventId: item.source_event_id, sourceActor: "user", sourceStatus: item.source_status, locatorType: item.locator_type, locatorKey: item.locator_key, extractionPolicyVersion: item.extraction_policy_version, role: item.evidence_role, status: "active" })),
  };
}
