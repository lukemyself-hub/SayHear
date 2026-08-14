import type {
  CurrentDialogueState,
  DialogueStateCommand,
  DialogueStateContent,
  DialogueStatePolicy,
  DialogueStateRepository,
  DialogueStateSource,
} from "@sayhear/application";
import { validateDialogueStateContent } from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asUserId,
} from "@sayhear/domain";
import type { Pool } from "pg";

import { createUuidV7 } from "./uuid-v7";

type DialogueStateCommandRow = Readonly<{
  claim_id: string;
  coverage_through_sequence_no: string;
  daily_session_id: string;
  dialogue_revision: string;
  expected_data_epoch: string;
  model_config_version: string;
  policy_version: string;
  prompt_version: string;
  source_revision: string;
  user_id: string;
  dialogue_state_command_id: string;
}>;

export class PostgresDialogueStateRepository implements DialogueStateRepository {
  public constructor(private readonly pool: Pool) {}

  public async queueEligible(
    input: Parameters<DialogueStateRepository["queueEligible"]>[0],
  ): Promise<number> {
    const client = await this.pool.connect();
    let queued = 0;
    try {
      await client.query("BEGIN");
      const policy = await client.query(
        `SELECT 1 FROM dialogue_state_policies
         WHERE policy_version = $1 AND prompt_version = $2 AND model_config_version = $3`,
        [input.policy.policyVersion, input.policy.promptVersion, input.policy.modelConfigVersion],
      );
      if (policy.rowCount !== 1) {
        throw new Error("DialogueState policy is unavailable or has drifted.");
      }

      await client.query(
        `UPDATE dialogue_state_commands command
         SET status = 'stale'
         WHERE command.status IN ('created', 'running', 'published')
           AND EXISTS (
             SELECT 1
             FROM dialogue_state_command_source_refs ref
             LEFT JOIN conversation_event_revisions revision
               ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
             LEFT JOIN conversation_events event
               ON event.conversation_event_id = revision.conversation_event_id
             WHERE ref.dialogue_state_command_id = command.dialogue_state_command_id
               AND (revision.content_purged_at IS NOT NULL
               OR event.lifecycle_status <> 'active'
               OR revision.conversation_event_revision_id IS NULL
               OR revision.transcript_status NOT IN ('final', 'corrected')
               OR event.current_revision_id <> ref.conversation_event_revision_id
               OR (event.actor = 'assistant' AND NOT EXISTS (
                 SELECT 1 FROM generation_commands response
                 WHERE response.generation_command_id = event.generation_command_id
                   AND response.status = 'succeeded'
                   AND response.authoritative_result_id = ref.conversation_event_revision_id
               )))
           )
           OR EXISTS (
             SELECT 1 FROM app_users owner
             WHERE owner.user_id = command.user_id
               AND (owner.status <> 'active'
                 OR owner.data_epoch <> command.expected_data_epoch)
           )`,
      );
      await client.query(
        `DELETE FROM current_dialogue_states current_state
         WHERE EXISTS (
           SELECT 1
           FROM dialogue_state_versions version
           INNER JOIN dialogue_state_commands command
             ON command.dialogue_state_command_id = version.dialogue_state_command_id
           INNER JOIN app_users owner
             ON owner.user_id = version.user_id
           INNER JOIN dialogue_state_command_source_refs ref
             ON ref.dialogue_state_command_id = version.dialogue_state_command_id
           LEFT JOIN conversation_event_revisions revision
             ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
           LEFT JOIN conversation_events event
             ON event.conversation_event_id = revision.conversation_event_id
         WHERE version.dialogue_state_version_id = current_state.dialogue_state_version_id
             AND (revision.content_purged_at IS NOT NULL
             OR owner.data_epoch <> command.expected_data_epoch
             OR owner.status <> 'active'
             OR event.lifecycle_status <> 'active'
             OR revision.conversation_event_revision_id IS NULL
             OR revision.transcript_status NOT IN ('final', 'corrected')
             OR event.current_revision_id <> ref.conversation_event_revision_id
             OR (event.actor = 'assistant' AND NOT EXISTS (
               SELECT 1 FROM generation_commands response
               WHERE response.generation_command_id = event.generation_command_id
                 AND response.status = 'succeeded'
                 AND response.authoritative_result_id = ref.conversation_event_revision_id
             )))
         )`,
      );

      const sessions = await client.query<{
        daily_session_id: string;
        dialogue_revision: string;
        source_revision: string;
        user_id: string;
      }>(
        `SELECT session.daily_session_id, session.user_id,
            session.source_revision::text, session.dialogue_revision::text
         FROM daily_sessions session
         INNER JOIN app_users owner
           ON owner.user_id = session.user_id
          AND owner.status = 'active'
          AND owner.data_epoch = $1
         ORDER BY session.updated_at, session.daily_session_id`,
        [input.expectedDataEpoch],
      );

      for (const session of sessions.rows) {
        const locked = await client.query<{
          daily_session_id: string;
          dialogue_revision: string;
          source_revision: string;
          user_id: string;
        }>(
          `SELECT daily_session_id, dialogue_revision::text, source_revision::text, user_id
           FROM daily_sessions
           WHERE daily_session_id = $1 AND user_id = $2 FOR UPDATE`,
          [session.daily_session_id, session.user_id],
        );
        if (locked.rowCount !== 1) continue;
        const freshSession = locked.rows[0]!;
        const sources = await readValidSources(client, {
          dailySessionId: freshSession.daily_session_id,
          userId: freshSession.user_id,
        });
        const coverage = sources.at(-1)?.sequence ?? 0;
        if (coverage === 0) continue;
        const current = await client.query<{
          covered_through_sequence_no: string;
          dialogue_revision: string;
          source_revision: string;
        }>(
          `SELECT source_revision, dialogue_revision, covered_through_sequence_no
           FROM current_dialogue_states
           WHERE daily_session_id = $1`,
          [freshSession.daily_session_id],
        );
        const currentRow = current.rows[0];
        if (
          currentRow &&
          (Number(currentRow.source_revision) > Number(freshSession.source_revision) ||
            (Number(currentRow.source_revision) === Number(freshSession.source_revision) &&
              Number(currentRow.dialogue_revision) > Number(freshSession.dialogue_revision)) ||
            (Number(currentRow.source_revision) === Number(freshSession.source_revision) &&
              Number(currentRow.dialogue_revision) === Number(freshSession.dialogue_revision) &&
              Number(currentRow.covered_through_sequence_no) >= coverage))
        ) {
          continue;
        }

        const commandId = createUuidV7(input.now);
        const inserted = await client.query<{ dialogue_state_command_id: string }>(
          `INSERT INTO dialogue_state_commands (
             dialogue_state_command_id, user_id, daily_session_id,
             expected_data_epoch, source_revision, dialogue_revision,
             coverage_through_sequence_no, coverage_key, policy_version, prompt_version,
             model_config_version, status, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'created', $11)
           ON CONFLICT (
             daily_session_id, source_revision, dialogue_revision,
             expected_data_epoch, policy_version, coverage_key
           )
           DO NOTHING
           RETURNING dialogue_state_command_id`,
          [
            commandId,
            freshSession.user_id,
            freshSession.daily_session_id,
            input.expectedDataEpoch,
            Number(freshSession.source_revision),
            Number(freshSession.dialogue_revision),
            coverage,
            input.policy.policyVersion,
            input.policy.promptVersion,
            input.policy.modelConfigVersion,
            input.now,
          ],
        );
        let insertedCommandId = inserted.rows[0]?.dialogue_state_command_id;
        if (!insertedCommandId) {
          const recovered = await client.query<{ dialogue_state_command_id: string }>(
            `UPDATE dialogue_state_commands
             SET status = 'created', claimed_at = NULL, claim_id = NULL,
                 last_error_code = NULL
             WHERE daily_session_id = $1
               AND source_revision = $2
               AND dialogue_revision = $3
             AND expected_data_epoch = $4
             AND policy_version = $5
             AND coverage_key = $6
               AND status = 'failed'
               AND last_error_code = 'dialogue_state_result_unknown'
             RETURNING dialogue_state_command_id`,
            [
              freshSession.daily_session_id,
              Number(freshSession.source_revision),
              Number(freshSession.dialogue_revision),
              input.expectedDataEpoch,
              input.policy.policyVersion,
              coverage,
            ],
          );
          insertedCommandId = recovered.rows[0]?.dialogue_state_command_id;
          if (!insertedCommandId) continue;
          await client.query(
            `UPDATE outbox_events
             SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                 workflow_receipt_id = NULL, next_attempt_at = $2
             WHERE workflow_command_id = $1
               AND event_type = 'dialogue_state_requested'`,
            [insertedCommandId, input.now],
          );
          queued += 1;
          continue;
        }
        for (const source of sources) {
          await client.query(
            `INSERT INTO dialogue_state_command_source_refs (
               dialogue_state_command_id, conversation_event_revision_id, sequence_no
             ) VALUES ($1, $2, $3)`,
            [insertedCommandId, source.revisionId, source.sequence],
          );
        }
        await client.query(
          `INSERT INTO workflow_commands (
             workflow_command_id, command_type, subject_type, subject_id,
             source_revision, policy_version, expected_data_epoch,
             coverage_through_sequence_no, status, created_at
           ) VALUES ($1, 'dialogue_state', 'daily_session', $2, $3, $4, $5, $6, 'created', $7)`,
          [
            insertedCommandId,
            freshSession.daily_session_id,
            Number(freshSession.source_revision),
            input.policy.policyVersion,
            input.expectedDataEpoch,
            coverage,
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO outbox_events (
             outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
             aggregate_revision, aggregate_data_epoch, aggregate_coverage,
             event_type, status,
             next_attempt_at, attempt_count, payload, created_at
           ) VALUES ($1, $2, 'daily_session', $3, $4,
             $5, $6, 'dialogue_state_requested', 'pending', $7, 0, $8::jsonb, $7)`,
          [
            createUuidV7(input.now),
            insertedCommandId,
            freshSession.daily_session_id,
            Number(freshSession.source_revision),
            input.expectedDataEpoch,
            coverage,
            input.now,
            JSON.stringify({
              eventType: "dialogue_state_requested",
              expectedDataEpoch: input.expectedDataEpoch,
              policyVersion: input.policy.policyVersion,
              sourceRevision: Number(freshSession.source_revision),
              status: "pending",
              subjectId: freshSession.daily_session_id,
              subjectType: "daily_session",
              workflowCommandId: insertedCommandId,
            }),
          ],
        );
        queued += 1;
      }
      await client.query("COMMIT");
      return queued;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reconcile(input: { now: Date; maximumClaimAgeMs: number }): Promise<void> {
    await this.pool.query(
      `UPDATE dialogue_state_commands
       SET status = 'failed', claimed_at = NULL, claim_id = NULL,
           last_error_code = 'dialogue_state_result_unknown'
       WHERE status = 'running' AND claimed_at <= $1`,
      [new Date(input.now.getTime() - input.maximumClaimAgeMs)],
    );
  }

  public async loadCommand(input: {
    commandId: string;
    now: Date;
  }): Promise<Awaited<ReturnType<DialogueStateRepository["loadCommand"]>>> {
    const claimId = createUuidV7(input.now);
    const command = await this.pool.query<DialogueStateCommandRow>(
      `UPDATE dialogue_state_commands
       SET status = 'running', claim_id = $2, claimed_at = $3
       WHERE dialogue_state_command_id = $1 AND status = 'created'
       RETURNING *`,
      [input.commandId, claimId, input.now],
    );
    const row = command.rows[0];
    if (!row) return null;
    const refs = await this.pool.query<{
      actor: "user" | "assistant";
      canonical_text: string;
      conversation_event_revision_id: string;
      sequence_no: string;
    }>(
      `SELECT ref.sequence_no, revision.conversation_event_revision_id,
          event.actor, revision.canonical_text
       FROM dialogue_state_command_source_refs ref
       INNER JOIN dialogue_state_commands frozen
         ON frozen.dialogue_state_command_id = ref.dialogue_state_command_id
       INNER JOIN app_users owner
         ON owner.user_id = frozen.user_id
        AND owner.status = 'active'
        AND owner.data_epoch = frozen.expected_data_epoch
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
        AND revision.content_purged_at IS NULL
        AND revision.transcript_status IN ('final', 'corrected')
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
        AND event.user_id = frozen.user_id
        AND event.daily_session_id = frozen.daily_session_id
        AND event.current_revision_id = ref.conversation_event_revision_id
        AND event.lifecycle_status = 'active'
        AND event.actor IN ('user', 'assistant')
        AND (event.actor = 'user' OR EXISTS (
          SELECT 1 FROM generation_commands response
          WHERE response.generation_command_id = event.generation_command_id
            AND response.status = 'succeeded'
            AND response.authoritative_result_id = ref.conversation_event_revision_id
        ))
       WHERE ref.dialogue_state_command_id = $1
       ORDER BY ref.sequence_no`,
      [input.commandId],
    );
    return {
      command: {
        claimId: row.claim_id,
        coverageThroughSequence: Number(row.coverage_through_sequence_no),
        dailySessionId: asDailySessionId(row.daily_session_id),
        dialogueRevision: Number(row.dialogue_revision),
        expectedDataEpoch: Number(row.expected_data_epoch),
        id: row.dialogue_state_command_id,
        modelConfigVersion: row.model_config_version,
        policyVersion: row.policy_version,
        promptVersion: row.prompt_version,
        sourceRevision: Number(row.source_revision),
        userId: asUserId(row.user_id),
      },
      sources: refs.rows.map((source) => ({
        actor: source.actor,
        revisionId: asConversationEventRevisionId(
          source.conversation_event_revision_id,
        ),
        sequence: Number(source.sequence_no),
        text: source.canonical_text,
      })),
    };
  }

  public async publish(input: {
    command: DialogueStateCommand;
    content: DialogueStateContent;
    now: Date;
  }): Promise<"published" | "stale"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<{ claim_id: string | null; status: string }>(
        `SELECT claim_id, status
         FROM dialogue_state_commands
         WHERE dialogue_state_command_id = $1
         FOR UPDATE`,
        [input.command.id],
      );
      if (
        claimed.rowCount !== 1 ||
        claimed.rows[0]!.status !== "running" ||
        claimed.rows[0]!.claim_id !== input.command.claimId
      ) {
        await client.query("COMMIT");
        return "stale";
      }
      const session = await client.query<{
        data_epoch: string;
        source_revision: string;
        dialogue_revision: string;
        user_status: string;
      }>(
        `SELECT owner.status AS user_status, owner.data_epoch::text,
            session.source_revision::text, session.dialogue_revision::text
         FROM daily_sessions session
         INNER JOIN app_users owner ON owner.user_id = session.user_id
         WHERE session.daily_session_id = $1 AND session.user_id = $2
         FOR UPDATE OF session, owner`,
        [input.command.dailySessionId, input.command.userId],
      );
      const sources = await client.query<{
        actor: "user" | "assistant";
        conversation_event_revision_id: string;
        current_revision_id: string;
        data_epoch: string;
        event_sequence_no: string;
        lifecycle_status: string;
        content_purged_at: Date | null;
        sequence_no: string;
        transcript_status: string;
        authoritative: boolean;
      }>(
        `SELECT ref.sequence_no, event.sequence_no AS event_sequence_no,
            ref.conversation_event_revision_id, event.actor,
            event.lifecycle_status, event.current_revision_id,
            revision.content_purged_at, revision.transcript_status,
            owner.data_epoch::text,
            CASE WHEN event.actor = 'user' THEN TRUE ELSE EXISTS (
              SELECT 1 FROM generation_commands response
              WHERE response.generation_command_id = event.generation_command_id
                AND response.status = 'succeeded'
                AND response.authoritative_result_id = revision.conversation_event_revision_id
            ) END AS authoritative
         FROM dialogue_state_command_source_refs ref
         INNER JOIN conversation_event_revisions revision
           ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
         INNER JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
         INNER JOIN app_users owner ON owner.user_id = event.user_id
         WHERE ref.dialogue_state_command_id = $1
           AND event.actor IN ('user', 'assistant')
         ORDER BY ref.sequence_no
         FOR UPDATE OF event, revision, owner`,
        [input.command.id],
      );
      const valid =
        session.rowCount === 1 &&
        session.rows[0]!.user_status === "active" &&
        Number(session.rows[0]!.data_epoch) === input.command.expectedDataEpoch &&
        Number(session.rows[0]!.source_revision) === input.command.sourceRevision &&
        Number(session.rows[0]!.dialogue_revision) === input.command.dialogueRevision &&
        sources.rows.length === input.command.coverageThroughSequence &&
        sources.rows.every(
          (source, index) =>
            Number(source.sequence_no) === index + 1 &&
            Number(source.sequence_no) === Number(source.event_sequence_no) &&
            source.lifecycle_status === "active" &&
            source.current_revision_id === source.conversation_event_revision_id &&
            source.content_purged_at === null &&
            (source.transcript_status === "final" ||
              source.transcript_status === "corrected") &&
            Number(source.data_epoch) === input.command.expectedDataEpoch &&
            source.authoritative,
        );
      const current = await client.query<{
        covered_through_sequence_no: string;
        dialogue_revision: string;
        source_revision: string;
      }>(
        `SELECT source_revision, dialogue_revision, covered_through_sequence_no
         FROM current_dialogue_states
         WHERE daily_session_id = $1 FOR UPDATE`,
        [input.command.dailySessionId],
      );
      const currentRow = current.rows[0];
      const watermark = currentRow ?? (await client.query<{
        covered_through_sequence_no: string;
        dialogue_revision: string;
        source_revision: string;
      }>(
        `SELECT version.source_revision, version.dialogue_revision,
            version.covered_through_sequence_no
         FROM dialogue_state_versions version
         INNER JOIN dialogue_state_commands command
           ON command.dialogue_state_command_id = version.dialogue_state_command_id
         INNER JOIN app_users owner
           ON owner.user_id = version.user_id
          AND owner.status = 'active'
          AND owner.data_epoch = command.expected_data_epoch
         WHERE version.daily_session_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM dialogue_state_command_source_refs ref
             LEFT JOIN conversation_event_revisions revision
               ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
             LEFT JOIN conversation_events event
               ON event.conversation_event_id = revision.conversation_event_id
             WHERE ref.dialogue_state_command_id = version.dialogue_state_command_id
               AND (
                 revision.conversation_event_revision_id IS NULL
                 OR revision.user_id <> version.user_id
                 OR revision.content_purged_at IS NOT NULL
                 OR revision.transcript_status NOT IN ('final', 'corrected')
                 OR event.conversation_event_id IS NULL
                 OR event.user_id <> version.user_id
                 OR event.daily_session_id <> version.daily_session_id
                 OR event.lifecycle_status <> 'active'
                 OR event.current_revision_id <> ref.conversation_event_revision_id
                 OR (event.actor = 'assistant' AND NOT EXISTS (
                   SELECT 1 FROM generation_commands response
                   WHERE response.generation_command_id = event.generation_command_id
                     AND response.status = 'succeeded'
                     AND response.authoritative_result_id = ref.conversation_event_revision_id
                 ))
               )
           )
         ORDER BY version.source_revision DESC, version.dialogue_revision DESC,
           version.covered_through_sequence_no DESC, version.version_no DESC
         LIMIT 1`,
        [input.command.dailySessionId],
      )).rows[0];
      const advances = !watermark ||
        Number(watermark.source_revision) < input.command.sourceRevision ||
        (Number(watermark.source_revision) === input.command.sourceRevision &&
          Number(watermark.dialogue_revision) < input.command.dialogueRevision) ||
        (Number(watermark.source_revision) === input.command.sourceRevision &&
          Number(watermark.dialogue_revision) === input.command.dialogueRevision &&
          Number(watermark.covered_through_sequence_no) < input.command.coverageThroughSequence);
      if (!valid || !advances) {
        await client.query(
          `UPDATE dialogue_state_commands SET status = 'stale'
           WHERE dialogue_state_command_id = $1 AND status IN ('created', 'running')`,
          [input.command.id],
        );
        await client.query("COMMIT");
        return "stale";
      }

      const version = await client.query<{ version_no: string }>(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
         FROM dialogue_state_versions WHERE daily_session_id = $1`,
        [input.command.dailySessionId],
      );
      const versionId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO dialogue_state_versions (
           dialogue_state_version_id, dialogue_state_command_id, user_id,
           daily_session_id, version_no, source_revision, dialogue_revision,
           covered_through_sequence_no, content, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          versionId,
          input.command.id,
          input.command.userId,
          input.command.dailySessionId,
          Number(version.rows[0]!.version_no),
          input.command.sourceRevision,
          input.command.dialogueRevision,
          input.command.coverageThroughSequence,
          JSON.stringify(input.content),
          input.now,
        ],
      );
      const pointer = currentRow
        ? await client.query(
            `UPDATE current_dialogue_states
             SET dialogue_state_version_id = $2, user_id = $3,
                 source_revision = $4, dialogue_revision = $5,
                 covered_through_sequence_no = $6, updated_at = $7
             WHERE daily_session_id = $1
               AND (
                 source_revision < $4 OR
                 (source_revision = $4 AND dialogue_revision < $5) OR
                 (source_revision = $4 AND dialogue_revision = $5
                   AND covered_through_sequence_no < $6)
               )`,
            [
              input.command.dailySessionId,
              versionId,
              input.command.userId,
              input.command.sourceRevision,
              input.command.dialogueRevision,
              input.command.coverageThroughSequence,
              input.now,
            ],
          )
        : await client.query(
            `INSERT INTO current_dialogue_states (
               daily_session_id, dialogue_state_version_id, user_id,
               source_revision, dialogue_revision, covered_through_sequence_no,
               updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (daily_session_id) DO NOTHING`,
            [
              input.command.dailySessionId,
              versionId,
              input.command.userId,
              input.command.sourceRevision,
              input.command.dialogueRevision,
              input.command.coverageThroughSequence,
              input.now,
            ],
          );
      await client.query(
        `UPDATE dialogue_state_commands SET status = $2, last_error_code = NULL
         WHERE dialogue_state_command_id = $1
           AND status = 'running' AND claim_id = $3`,
        [input.command.id, pointer.rowCount === 1 ? "published" : "stale", input.command.claimId],
      );
      await client.query("COMMIT");
      return pointer.rowCount === 1 ? "published" : "stale";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async fail(input: { claimId: string; commandId: string; errorCode: string }): Promise<void> {
    await this.pool.query(
      `UPDATE dialogue_state_commands SET status = 'failed', last_error_code = $2
       WHERE dialogue_state_command_id = $1 AND status = 'running' AND claim_id = $3`,
      [input.commandId, input.errorCode, input.claimId],
    );
  }

  public async stale(input: { claimId: string; commandId: string }): Promise<void> {
    await this.pool.query(
      `UPDATE dialogue_state_commands SET status = 'stale'
       WHERE dialogue_state_command_id = $1 AND status = 'running' AND claim_id = $2`,
      [input.commandId, input.claimId],
    );
  }
}

async function readValidSources(
  client: import("pg").PoolClient,
  input: { dailySessionId: string; userId: string },
): Promise<DialogueStateSource[]> {
  const result = await client.query<{
    actor: "user" | "assistant";
    canonical_text: string;
    conversation_event_revision_id: string;
    sequence_no: string;
  }>(
    `SELECT event.sequence_no, revision.conversation_event_revision_id,
        event.actor, revision.canonical_text
     FROM conversation_events event
     INNER JOIN conversation_event_revisions revision
       ON revision.conversation_event_revision_id = event.current_revision_id
      AND revision.user_id = event.user_id
      AND revision.content_purged_at IS NULL
      AND revision.transcript_status IN ('final', 'corrected')
     WHERE event.daily_session_id = $1 AND event.user_id = $2
       AND event.lifecycle_status = 'active'
       AND event.actor IN ('user', 'assistant')
       AND (event.actor = 'user' OR EXISTS (
         SELECT 1 FROM generation_commands response
         WHERE response.generation_command_id = event.generation_command_id
           AND response.status = 'succeeded'
           AND response.authoritative_result_id = revision.conversation_event_revision_id
       ))
     ORDER BY event.sequence_no`,
    [input.dailySessionId, input.userId],
  );
  const mapped = result.rows.map((source) => ({
    actor: source.actor,
    revisionId: asConversationEventRevisionId(
      source.conversation_event_revision_id,
    ),
    sequence: Number(source.sequence_no),
    text: source.canonical_text,
  }));
  const contiguous: DialogueStateSource[] = [];
  for (const source of mapped) {
    if (source.sequence !== contiguous.length + 1) break;
    contiguous.push(source);
  }
  return contiguous;
}

export async function loadDialogueStateForContext(
  client: import("pg").PoolClient,
  input: {
    dailySessionId: string;
    dialogueRevision: number;
    sourceRevision: number;
    expectedDataEpoch: number;
  },
): Promise<{ dialogueState: CurrentDialogueState | null; failure: boolean }> {
  const pointer = await client.query<{
    covered_through_sequence_no: string;
    dialogue_state_version_id: string;
    dialogue_revision: string;
    source_revision: string;
    updated_at: Date;
    version_no: string;
    user_id: string;
    policy_version: string;
    prompt_version: string;
    model_config_version: string;
    content: DialogueStateContent;
  }>(
    `SELECT version.covered_through_sequence_no,
        version.dialogue_state_version_id,
        version.dialogue_revision, version.source_revision,
        version.created_at AS updated_at, version.version_no, version.user_id,
        command.policy_version, command.prompt_version,
        command.model_config_version, version.content
     FROM dialogue_state_versions version
     INNER JOIN dialogue_state_commands command
       ON command.dialogue_state_command_id = version.dialogue_state_command_id
     INNER JOIN app_users owner
       ON owner.user_id = version.user_id
      AND owner.status = 'active'
      AND owner.data_epoch = $2
     WHERE version.daily_session_id = $1
       AND command.status = 'published'
       AND version.source_revision <= $3
       AND version.dialogue_revision <= $4
       AND NOT EXISTS (
         SELECT 1
         FROM dialogue_state_command_source_refs ref
         LEFT JOIN conversation_event_revisions revision
           ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
         LEFT JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
         LEFT JOIN app_users source_owner
           ON source_owner.user_id = event.user_id
         WHERE ref.dialogue_state_command_id = version.dialogue_state_command_id
           AND (revision.conversation_event_revision_id IS NULL
             OR event.conversation_event_id IS NULL
             OR event.actor NOT IN ('user', 'assistant')
             OR revision.content_purged_at IS NOT NULL
             OR revision.user_id <> version.user_id
             OR event.lifecycle_status <> 'active'
             OR event.user_id <> version.user_id
             OR event.daily_session_id <> version.daily_session_id
             OR source_owner.status <> 'active'
             OR source_owner.data_epoch <> $2
             OR revision.transcript_status NOT IN ('final', 'corrected')
             OR event.current_revision_id <> ref.conversation_event_revision_id
             OR (event.actor = 'assistant' AND NOT EXISTS (
               SELECT 1 FROM generation_commands response
               WHERE response.generation_command_id = event.generation_command_id
                 AND response.status = 'succeeded'
                 AND response.authoritative_result_id = revision.conversation_event_revision_id
             )))
       )
     ORDER BY version.source_revision DESC, version.dialogue_revision DESC,
       version.covered_through_sequence_no DESC, version.version_no DESC
     LIMIT 1`,
    [
      input.dailySessionId,
      input.expectedDataEpoch,
      input.sourceRevision,
      input.dialogueRevision,
    ],
  );
  const row = pointer.rows[0];
  if (!row) {
    const failure = await client.query(
      `SELECT 1 FROM current_dialogue_states current_state
       WHERE current_state.daily_session_id = $1
       UNION ALL
       SELECT 1 FROM dialogue_state_commands command
       WHERE command.daily_session_id = $1
         AND command.status = 'failed'
         AND command.last_error_code IS NOT NULL
         AND command.source_revision = (
           SELECT MAX(latest.source_revision)
           FROM dialogue_state_commands latest
           WHERE latest.daily_session_id = $1
         )
       LIMIT 1`,
      [input.dailySessionId],
    );
    return { dialogueState: null, failure: (failure.rowCount ?? 0) > 0 };
  }
  const refs = await client.query<{ conversation_event_revision_id: string }>(
    `SELECT ref.conversation_event_revision_id
     FROM dialogue_state_command_source_refs ref
     INNER JOIN dialogue_state_versions version
       ON version.dialogue_state_command_id = ref.dialogue_state_command_id
     WHERE version.dialogue_state_version_id = $1
     ORDER BY ref.sequence_no`,
    [row.dialogue_state_version_id],
  );
  let content: DialogueStateContent;
  try {
    content = row.content;
    validateDialogueStateContent(
      content,
      refs.rows.map((ref) =>
        asConversationEventRevisionId(ref.conversation_event_revision_id),
      ),
    );
  } catch {
    return { dialogueState: null, failure: true };
  }
  const currentSources = await readValidSources(client, {
    dailySessionId: input.dailySessionId,
    userId: row.user_id,
  });
  const currentCoverage = currentSources.at(-1)?.sequence ?? 0;
  return {
    dialogueState: {
      content,
      coveredThroughSequence: Number(row.covered_through_sequence_no),
      dialogueRevision: Number(row.dialogue_revision),
      id: row.dialogue_state_version_id,
      modelConfigVersion: row.model_config_version,
      policyVersion: row.policy_version,
      promptVersion: row.prompt_version,
      sourceRevision: Number(row.source_revision),
      sourceRevisionIds: refs.rows.map((ref) =>
        asConversationEventRevisionId(ref.conversation_event_revision_id),
      ),
      status:
        Number(row.source_revision) === input.sourceRevision &&
        Number(row.dialogue_revision) === input.dialogueRevision &&
        Number(row.covered_through_sequence_no) === currentCoverage
          ? "current"
          : "lagging",
      updatedAt: row.updated_at,
      version: Number(row.version_no),
    },
    failure: false,
  };
}
