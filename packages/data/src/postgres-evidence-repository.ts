import type { EvidenceChampion, EvidenceRepository, EvidenceSourceSnapshot } from "@sayhear/application";
import { asDailySessionId } from "@sayhear/domain";
import type { Pool } from "pg";
import { createUuidV7 } from "./uuid-v7";

type SnapshotRow = {
  evidence_source_snapshot_id: string;
  user_id: string;
  daily_session_id: string;
  source_revision: number;
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
  public constructor(private readonly pool: Pool) {}

  public async freezeUserEvidence(input: Parameters<EvidenceRepository["freezeUserEvidence"]>[0]): ReturnType<EvidenceRepository["freezeUserEvidence"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string; activity_state: string; source_revision: number;
      }>("SELECT user_id, activity_state, source_revision FROM daily_sessions WHERE daily_session_id = $1 FOR UPDATE", [input.dailySessionId]);
      const row = session.rows[0];
      if (!row) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      if (row.activity_state === "active") { await client.query("ROLLBACK"); return { outcome: "stale" }; }
      if (row.source_revision !== input.sourceRevision) { await client.query("ROLLBACK"); return { outcome: "stale" }; }
      const owner = await client.query<{ status: string; data_epoch: string }>("SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE", [row.user_id]);
      if (!owner.rows[0] || owner.rows[0].status !== "active" || Number(owner.rows[0].data_epoch) !== input.expectedDataEpoch) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      const snapshotId = createUuidV7(input.now);
      const snapshotResult = await client.query<SnapshotRow & { inserted: boolean }>(
        `INSERT INTO evidence_source_snapshots (
          evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
          extraction_policy_version, command_id, attempt_id, champion_config_version,
          champion_provider, champion_model, champion_snapshot, champion_provider_policy_version, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (daily_session_id, source_revision, extraction_policy_version)
        DO UPDATE SET evidence_source_snapshot_id = evidence_source_snapshots.evidence_source_snapshot_id
        RETURNING *, (xmax = 0) AS inserted`,
        [snapshotId, row.user_id, input.dailySessionId, input.sourceRevision, input.extractionPolicyVersion, input.commandId, input.attemptId, input.champion.configVersion, input.champion.provider, input.champion.model, input.champion.snapshot, input.champion.providerPolicyVersion, input.now],
      );
      const snapshot = snapshotResult.rows[0]!;
      const sourceRows = await client.query<{
        user_id: string; conversation_event_id: string; conversation_event_revision_id: string; transcript_status: "final" | "corrected";
      }>(`SELECT event.user_id, event.conversation_event_id, revision.conversation_event_revision_id, revision.transcript_status
        FROM conversation_events event
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = event.current_revision_id
          AND revision.conversation_event_id = event.conversation_event_id
          AND revision.user_id = event.user_id
        WHERE event.daily_session_id = $1 AND event.user_id = $2
          AND event.actor = 'user' AND event.lifecycle_status = 'active'
          AND revision.transcript_status IN ('final', 'corrected')
          AND revision.content_purged_at IS NULL`, [input.dailySessionId, row.user_id]);
      for (const source of sourceRows.rows) {
        await client.query(
        `INSERT INTO evidence_items (
          evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
          source_revision_id, source_actor, source_status, locator_type, locator_key,
          extraction_policy_version, evidence_role, created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'user', $6, 'whole_revision', $7, $8, 'factual_support', $9)
        ON CONFLICT (user_id, source_revision_id, locator_key, extraction_policy_version) DO NOTHING`,
        [createUuidV7(input.now), source.user_id, snapshot.evidence_source_snapshot_id, source.conversation_event_id, source.conversation_event_revision_id, source.transcript_status, `revision:${source.conversation_event_revision_id}`, input.extractionPolicyVersion, input.now],
        );
      }
      if (sourceRows.rows.length === 0) {
        await client.query("ROLLBACK");
        return { outcome: "not_eligible" };
      }
      await client.query(
        `INSERT INTO evidence_lineage (evidence_item_id, command_id, attempt_id, created_at)
         SELECT evidence_item_id, $2, $3, $4 FROM evidence_items
         WHERE evidence_source_snapshot_id = $1
         ON CONFLICT (evidence_item_id) DO NOTHING`,
        [snapshot.evidence_source_snapshot_id, input.commandId, input.attemptId, input.now],
      );
      const items = await client.query<any>(`SELECT evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id, source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version, evidence_role, status FROM evidence_items WHERE evidence_source_snapshot_id = $1 ORDER BY source_revision_id`, [snapshot.evidence_source_snapshot_id]);
      await client.query("COMMIT");
      return { outcome: "frozen", snapshot: toSnapshot(snapshot, items.rows) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async findEvidenceSnapshot(input: { dailySessionId: any; sourceRevision: number }): Promise<EvidenceSourceSnapshot | null> {
    const result = await this.pool.query<SnapshotRow>("SELECT * FROM evidence_source_snapshots WHERE daily_session_id = $1 AND source_revision = $2", [input.dailySessionId, input.sourceRevision]);
    const snapshot = result.rows[0];
    if (!snapshot) return null;
    const items = await this.pool.query<any>("SELECT evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id, source_revision_id, source_actor, source_status, locator_type, locator_key, extraction_policy_version, evidence_role, status FROM evidence_items WHERE evidence_source_snapshot_id = $1 ORDER BY source_revision_id", [snapshot.evidence_source_snapshot_id]);
    return toSnapshot(snapshot, items.rows);
  }
}

function toSnapshot(row: SnapshotRow, items: any[]): EvidenceSourceSnapshot {
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
