import type {
  RollingSummaryRepository,
  RollingSummaryCommand,
  RollingSummaryContent,
  RollingSummarySource,
} from "@sayhear/application";
import { asConversationEventRevisionId, asDailySessionId, asUserId } from "@sayhear/domain";
import type { Pool } from "pg";
import { lockActiveOwnerEpoch } from "./postgres-owner-epoch-fence";
import { createUuidV7 } from "./uuid-v7";

export class PostgresRollingSummaryRepository implements RollingSummaryRepository {
  public constructor(private readonly pool: Pool) {}
  public async queueEligible(input: Parameters<RollingSummaryRepository["queueEligible"]>[0]): Promise<number> {
    const client = await this.pool.connect(); let queued = 0;
    try { await client.query("BEGIN");
      const policy = await client.query<{ minimum_uncovered_event_count: number; minimum_uncovered_token_count: number }>(
        `SELECT minimum_uncovered_event_count, minimum_uncovered_token_count
         FROM rolling_summary_policies WHERE policy_version = $1`, [input.policyVersion],
      );
      const policyRow = policy.rows[0];
      if (!policyRow) throw new Error("Rolling Summary policy is unavailable.");
      const invalidated = await client.query<{ daily_session_id: string }>(`SELECT current.daily_session_id
        FROM current_rolling_summaries current
        INNER JOIN rolling_summary_versions version ON version.rolling_summary_version_id = current.rolling_summary_version_id
        INNER JOIN rolling_summary_commands command ON command.rolling_summary_command_id = version.rolling_summary_command_id
        INNER JOIN daily_sessions session ON session.daily_session_id = current.daily_session_id
        WHERE EXISTS (
          SELECT 1 FROM rolling_summary_command_source_refs ref
          LEFT JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
          LEFT JOIN conversation_events event ON event.conversation_event_id = revision.conversation_event_id
          WHERE ref.rolling_summary_command_id = command.rolling_summary_command_id
            AND (revision.content_purged_at IS NOT NULL OR event.lifecycle_status <> 'active' OR event.current_revision_id <> ref.conversation_event_revision_id)
        ) FOR UPDATE OF current, session`);
      for (const row of invalidated.rows) {
        await client.query(`UPDATE rolling_summary_commands SET status = 'stale'
          WHERE daily_session_id = $1 AND status IN ('created', 'running')`, [row.daily_session_id]);
        await client.query(`DELETE FROM current_rolling_summaries WHERE daily_session_id = $1`, [row.daily_session_id]);
      }
      const sessions = await client.query<{ daily_session_id:string; user_id:string; source_revision:string; dialogue_revision:string; covered:string; coverage_start:string; covered_through:string; uncovered_count:string; uncovered_tokens:string }>(`
        SELECT session.daily_session_id, session.user_id, session.source_revision::text, session.dialogue_revision::text,
          COALESCE(current.covered_through_sequence_no, 0)::text AS covered,
          MIN(event.sequence_no)::text AS coverage_start, MAX(event.sequence_no)::text AS covered_through,
          COUNT(*) FILTER (WHERE event.sequence_no > COALESCE(current.covered_through_sequence_no, 0))::text AS uncovered_count,
          COALESCE(SUM(GREATEST(1, CEIL(CHAR_LENGTH(revision.canonical_text) / 4.0))) FILTER (WHERE event.sequence_no > COALESCE(current.covered_through_sequence_no, 0)), 0)::text AS uncovered_tokens
        FROM daily_sessions session
        INNER JOIN app_users owner ON owner.user_id = session.user_id AND owner.status = 'active'
        LEFT JOIN current_rolling_summaries current ON current.daily_session_id = session.daily_session_id
        INNER JOIN conversation_events event ON event.daily_session_id = session.daily_session_id AND event.user_id = session.user_id AND event.lifecycle_status = 'active' AND event.actor IN ('user','assistant')
        INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = event.current_revision_id AND revision.user_id = event.user_id AND revision.content_purged_at IS NULL
        WHERE (event.actor = 'user' OR EXISTS (SELECT 1 FROM generation_commands command WHERE command.generation_command_id = event.generation_command_id AND command.status = 'succeeded' AND command.authoritative_result_id = revision.conversation_event_revision_id))
        GROUP BY session.daily_session_id, session.user_id, session.source_revision, session.dialogue_revision, current.covered_through_sequence_no
        HAVING COUNT(*) FILTER (WHERE event.sequence_no > COALESCE(current.covered_through_sequence_no, 0)) > $1
          OR COALESCE(SUM(GREATEST(1, CEIL(CHAR_LENGTH(revision.canonical_text) / 4.0))) FILTER (WHERE event.sequence_no > COALESCE(current.covered_through_sequence_no, 0)), 0) > $2
      `, [policyRow.minimum_uncovered_event_count, policyRow.minimum_uncovered_token_count]);
      for (const session of sessions.rows) {
        const expectedDataEpoch = await lockActiveOwnerEpoch(client, session.user_id);
        if (expectedDataEpoch === null) continue;
        const locked = await client.query(`SELECT daily_session_id FROM daily_sessions WHERE daily_session_id = $1 AND user_id = $2 FOR UPDATE`, [session.daily_session_id, session.user_id]);
        if (locked.rowCount !== 1) continue;
        // Every replacement Summary is self-contained: it re-freezes all valid
        // contiguous source Events from sequence 1, while only *new* Events
        // determine whether compaction is due.
        const id = createUuidV7(input.now); const start = Number(session.coverage_start); const end = Number(session.covered_through);
        const inserted = await client.query<{ rolling_summary_command_id:string }>(`
          INSERT INTO rolling_summary_commands (rolling_summary_command_id,user_id,daily_session_id,expected_data_epoch,source_revision,dialogue_revision,coverage_start_sequence_no,covered_through_sequence_no,policy_version,minimum_uncovered_event_count,minimum_uncovered_token_count,prompt_version,model_config_version,status,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'created',$14)
          ON CONFLICT (daily_session_id,source_revision,coverage_start_sequence_no,covered_through_sequence_no,policy_version) DO NOTHING RETURNING rolling_summary_command_id
        `,[id,session.user_id,session.daily_session_id,expectedDataEpoch,session.source_revision,session.dialogue_revision,start,end,input.policyVersion,policyRow.minimum_uncovered_event_count,policyRow.minimum_uncovered_token_count,input.promptVersion,input.modelConfigVersion,input.now]);
        if (inserted.rowCount !== 1) continue;
        await client.query(`INSERT INTO rolling_summary_command_source_refs (rolling_summary_command_id,conversation_event_revision_id,sequence_no)
          SELECT $1, revision.conversation_event_revision_id, event.sequence_no
          FROM conversation_events event
          INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = event.current_revision_id AND revision.user_id = event.user_id
          WHERE event.daily_session_id = $2 AND event.user_id = $3
            AND event.sequence_no BETWEEN $4 AND $5
            AND event.lifecycle_status = 'active' AND revision.content_purged_at IS NULL
            AND event.actor IN ('user', 'assistant')
            AND (event.actor = 'user' OR EXISTS (
              SELECT 1 FROM generation_commands command
              WHERE command.generation_command_id = event.generation_command_id
                AND command.status = 'succeeded'
                AND command.authoritative_result_id = revision.conversation_event_revision_id
            ))
          ORDER BY event.sequence_no`,[id,session.daily_session_id,session.user_id,start,end]);
        await client.query(`INSERT INTO workflow_commands (workflow_command_id,command_type,subject_type,subject_id,source_revision,policy_version,expected_data_epoch,status,created_at) VALUES ($1,'rolling_summary','daily_session',$2,$3,$4,$5,'created',$6)`,[id,session.daily_session_id,session.source_revision,input.policyVersion,expectedDataEpoch,input.now]);
        await client.query(`INSERT INTO outbox_events (outbox_event_id,workflow_command_id,aggregate_type,aggregate_id,aggregate_revision,event_type,status,next_attempt_at,attempt_count,payload,created_at) VALUES ($1,$2,'daily_session',$3,$4,'rolling_summary_requested','pending',$5,0,$6::jsonb,$5)`,[createUuidV7(input.now),id,session.daily_session_id,session.source_revision,input.now,JSON.stringify({workflowCommandId:id,subjectId:session.daily_session_id,sourceRevision:Number(session.source_revision),policyVersion:input.policyVersion,expectedDataEpoch:expectedDataEpoch,eventType:'rolling_summary_requested',status:'pending'})]);
        queued += 1;
      } await client.query("COMMIT"); return queued;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  public async reconcile(input: { now: Date; maximumClaimAgeMs: number }): Promise<void> {
    await this.pool.query(`UPDATE rolling_summary_commands
      SET status = 'failed', last_error_code = 'summary_result_unknown'
      WHERE status = 'running' AND claimed_at <= $1`, [new Date(input.now.getTime() - input.maximumClaimAgeMs)]);
  }
  public async loadCommand(input: { commandId: string; now: Date }): Promise<{ command: RollingSummaryCommand; sources: readonly RollingSummarySource[] } | null> {
    const command = await this.pool.query<any>(`UPDATE rolling_summary_commands SET status = 'running', claimed_at = $2 WHERE rolling_summary_command_id=$1 AND status = 'created' RETURNING *`,[input.commandId, input.now]); const row=command.rows[0]; if(!row)return null;
    const refs=await this.pool.query<any>(`SELECT ref.sequence_no, revision.conversation_event_revision_id, event.actor, revision.canonical_text
      FROM rolling_summary_command_source_refs ref
      INNER JOIN rolling_summary_commands frozen ON frozen.rolling_summary_command_id = ref.rolling_summary_command_id
      INNER JOIN app_users owner ON owner.user_id = frozen.user_id AND owner.status = 'active' AND owner.data_epoch = frozen.expected_data_epoch
      INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = ref.conversation_event_revision_id AND revision.content_purged_at IS NULL
      INNER JOIN conversation_events event ON event.conversation_event_id = revision.conversation_event_id AND event.current_revision_id = ref.conversation_event_revision_id AND event.lifecycle_status = 'active' AND event.daily_session_id = frozen.daily_session_id AND event.user_id = frozen.user_id
      WHERE ref.rolling_summary_command_id=$1 ORDER BY ref.sequence_no`,[input.commandId]);
    return { command: { id:row.rolling_summary_command_id,userId:asUserId(row.user_id),dailySessionId:asDailySessionId(row.daily_session_id),expectedDataEpoch:Number(row.expected_data_epoch),sourceRevision:Number(row.source_revision),dialogueRevision:Number(row.dialogue_revision),coverageStart:Number(row.coverage_start_sequence_no),coveredThrough:Number(row.covered_through_sequence_no),policyVersion:row.policy_version,minimumUncoveredEventCount:Number(row.minimum_uncovered_event_count),minimumUncoveredTokenCount:Number(row.minimum_uncovered_token_count),promptVersion:row.prompt_version,modelConfigVersion:row.model_config_version }, sources: refs.rows.map((r:any)=>({revisionId:asConversationEventRevisionId(r.conversation_event_revision_id),sequence:Number(r.sequence_no),actor:r.actor,text:r.canonical_text})) };
  }
  public async publish(input: { command: RollingSummaryCommand; content: RollingSummaryContent; now: Date }): Promise<"published" | "stale"> {
    const client=await this.pool.connect(); try { await client.query("BEGIN");
      const session = await client.query<{ source_revision: string }>(`SELECT source_revision FROM daily_sessions
        WHERE daily_session_id = $1 AND user_id = $2 FOR UPDATE`, [input.command.dailySessionId, input.command.userId]);
      const sources = await client.query<any>(`SELECT ref.sequence_no, event.sequence_no AS event_sequence_no,
          owner.status AS owner_status, owner.data_epoch, event.lifecycle_status,
          event.current_revision_id, revision.conversation_event_revision_id,
          revision.content_purged_at,
          CASE WHEN event.actor = 'user' THEN TRUE ELSE EXISTS (
            SELECT 1 FROM generation_commands command
            WHERE command.generation_command_id = event.generation_command_id
              AND command.status = 'succeeded'
              AND command.authoritative_result_id = revision.conversation_event_revision_id
          ) END AS authoritative
        FROM rolling_summary_command_source_refs ref
        INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
        INNER JOIN conversation_events event ON event.conversation_event_id = revision.conversation_event_id
        INNER JOIN app_users owner ON owner.user_id = event.user_id
        WHERE ref.rolling_summary_command_id = $1
        FOR UPDATE OF owner, event, revision`, [input.command.id]);
      const valid = session.rowCount === 1 && sources.rows.length === input.command.coveredThrough - input.command.coverageStart + 1 && sources.rows.every((source: any) =>
        Number(source.sequence_no) === Number(source.event_sequence_no) &&
        source.owner_status === 'active' && Number(source.data_epoch) === input.command.expectedDataEpoch &&
        source.lifecycle_status === 'active' && source.current_revision_id === source.conversation_event_revision_id &&
        source.content_purged_at === null && source.authoritative === true,
      );
      const current = await client.query<{ covered_through_sequence_no: string }>(`SELECT covered_through_sequence_no FROM current_rolling_summaries WHERE daily_session_id = $1 FOR UPDATE`, [input.command.dailySessionId]);
      const previousCoverage = current.rows[0] ? Number(current.rows[0].covered_through_sequence_no) : 0;
      // A full replacement starts at sequence 1. The alternate tail form is
      // retained only for a future incremental policy and cannot jump a gap.
      const advancesContiguously = input.command.coveredThrough > previousCoverage &&
        (input.command.coverageStart === 1 || input.command.coverageStart === previousCoverage + 1);
      if(!valid || !advancesContiguously){await client.query(`UPDATE rolling_summary_commands SET status='stale' WHERE rolling_summary_command_id=$1`,[input.command.id]);await client.query("COMMIT");return 'stale';}
      const version=await client.query<{version:string}>(`SELECT COALESCE((SELECT MAX(version_no) FROM rolling_summary_versions WHERE daily_session_id=$1),0)+1 version`,[input.command.dailySessionId]); const versionId=createUuidV7(input.now);
      await client.query(`INSERT INTO rolling_summary_versions (rolling_summary_version_id,rolling_summary_command_id,user_id,daily_session_id,version_no,covered_through_sequence_no,content,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[versionId,input.command.id,input.command.userId,input.command.dailySessionId,version.rows[0]!.version,input.command.coveredThrough,JSON.stringify(input.content),input.now]);
      const pointer = current.rowCount === 0
        ? await client.query(`INSERT INTO current_rolling_summaries (daily_session_id,rolling_summary_version_id,user_id,covered_through_sequence_no,updated_at) VALUES ($1,$2,$3,$4,$5)`,[input.command.dailySessionId,versionId,input.command.userId,input.command.coveredThrough,input.now])
        : await client.query(`UPDATE current_rolling_summaries SET rolling_summary_version_id=$2,user_id=$3,covered_through_sequence_no=$4,updated_at=$5 WHERE daily_session_id=$1 AND covered_through_sequence_no=$6`,[input.command.dailySessionId,versionId,input.command.userId,input.command.coveredThrough,input.now,previousCoverage]);
      await client.query(`UPDATE rolling_summary_commands SET status=$2 WHERE rolling_summary_command_id=$1`,[input.command.id,pointer.rowCount===1?'published':'stale']); await client.query("COMMIT");return pointer.rowCount===1?'published':'stale';
    } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  public async fail(input:{commandId:string;errorCode:string}):Promise<void>{await this.pool.query(`UPDATE rolling_summary_commands SET status='failed',last_error_code=$2 WHERE rolling_summary_command_id=$1 AND status IN ('created','running')`,[input.commandId,input.errorCode]);}
  public async stale(input: { commandId: string }): Promise<void> {
    await this.pool.query(
      `UPDATE rolling_summary_commands SET status = 'stale' WHERE rolling_summary_command_id = $1 AND status IN ('created', 'running')`,
      [input.commandId],
    );
  }
}
