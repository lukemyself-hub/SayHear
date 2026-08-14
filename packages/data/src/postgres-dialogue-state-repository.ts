import type {
  CurrentDialogueState,
  DialogueStateCommand,
  DialogueStateContent,
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
        [input.policyVersion, input.promptVersion, input.modelConfigVersion],
      );
      if (policy.rowCount !== 1) {
        throw new Error("DialogueState policy is unavailable or has drifted.");
      }

      await client.query(
        `UPDATE dialogue_state_commands command
         SET status = 'stale'
         WHERE command.status IN ('created', 'running')
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
                 OR event.current_revision_id <> ref.conversation_event_revision_id)
           )`,
      );
      await client.query(
        `DELETE FROM current_dialogue_states current_state
         WHERE EXISTS (
           SELECT 1
           FROM dialogue_state_versions version
           INNER JOIN dialogue_state_command_source_refs ref
             ON ref.dialogue_state_command_id = version.dialogue_state_command_id
           LEFT JOIN conversation_event_revisions revision
             ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
           LEFT JOIN conversation_events event
             ON event.conversation_event_id = revision.conversation_event_id
           WHERE version.dialogue_state_version_id = current_state.dialogue_state_version_id
             AND (revision.content_purged_at IS NOT NULL
             OR event.lifecycle_status <> 'active'
               OR revision.conversation_event_revision_id IS NULL
               OR revision.transcript_status NOT IN ('final', 'corrected')
               OR event.current_revision_id <> ref.conversation_event_revision_id)
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
         LEFT JOIN current_dialogue_states current_state
           ON current_state.daily_session_id = session.daily_session_id
         WHERE current_state.daily_session_id IS NULL
            OR current_state.source_revision < session.source_revision
            OR current_state.dialogue_revision < session.dialogue_revision
         ORDER BY session.updated_at, session.daily_session_id`,
        [input.expectedDataEpoch],
      );

      for (const session of sessions.rows) {
        const locked = await client.query(
          `SELECT daily_session_id FROM daily_sessions
           WHERE daily_session_id = $1 AND user_id = $2 FOR UPDATE`,
          [session.daily_session_id, session.user_id],
        );
        if (locked.rowCount !== 1) continue;

        const sources = await readValidSources(client, {
          dailySessionId: session.daily_session_id,
          userId: session.user_id,
        });
        const coverage = sources.at(-1)?.sequence ?? 0;
        if (coverage === 0) continue;

        const commandId = createUuidV7(input.now);
        const inserted = await client.query<{ dialogue_state_command_id: string }>(
          `INSERT INTO dialogue_state_commands (
             dialogue_state_command_id, user_id, daily_session_id,
             expected_data_epoch, source_revision, dialogue_revision,
             coverage_through_sequence_no, policy_version, prompt_version,
             model_config_version, status, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'created', $11)
           ON CONFLICT (daily_session_id, source_revision, dialogue_revision, policy_version)
           DO NOTHING
           RETURNING dialogue_state_command_id`,
          [
            commandId,
            session.user_id,
            session.daily_session_id,
            input.expectedDataEpoch,
            Number(session.source_revision),
            Number(session.dialogue_revision),
            coverage,
            input.policyVersion,
            input.promptVersion,
            input.modelConfigVersion,
            input.now,
          ],
        );
        if (inserted.rowCount !== 1) continue;
        const insertedCommandId = inserted.rows[0]!.dialogue_state_command_id;
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
             source_revision, policy_version, expected_data_epoch, status, created_at
           ) VALUES ($1, 'dialogue_state', 'daily_session', $2, $3, $4, $5, 'created', $6)`,
          [
            insertedCommandId,
            session.daily_session_id,
            Number(session.source_revision),
            input.policyVersion,
            input.expectedDataEpoch,
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO outbox_events (
             outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
             aggregate_revision, event_type, status, next_attempt_at,
             attempt_count, payload, created_at
           ) VALUES ($1, $2, 'daily_session', $3, $4,
             'dialogue_state_requested', 'pending', $5, 0, $6::jsonb, $5)`,
          [
            createUuidV7(input.now),
            insertedCommandId,
            session.daily_session_id,
            Number(session.source_revision),
            input.now,
            JSON.stringify({
              eventType: "dialogue_state_requested",
              expectedDataEpoch: input.expectedDataEpoch,
              policyVersion: input.policyVersion,
              sourceRevision: Number(session.source_revision),
              status: "pending",
              subjectId: session.daily_session_id,
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
       SET status = 'failed', last_error_code = 'dialogue_state_result_unknown'
       WHERE status = 'running' AND claimed_at <= $1`,
      [new Date(input.now.getTime() - input.maximumClaimAgeMs)],
    );
  }

  public async loadCommand(input: {
    commandId: string;
    now: Date;
  }): Promise<Awaited<ReturnType<DialogueStateRepository["loadCommand"]>>> {
    const command = await this.pool.query<DialogueStateCommandRow>(
      `UPDATE dialogue_state_commands
       SET status = 'running', claimed_at = $2
       WHERE dialogue_state_command_id = $1 AND status = 'created'
       RETURNING *`,
      [input.commandId, input.now],
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
            event.actor, event.lifecycle_status, event.current_revision_id,
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
         ORDER BY ref.sequence_no
         FOR UPDATE OF event, revision, owner`,
        [input.command.id],
      );
      const valid =
        session.rowCount === 1 &&
        session.rows[0]!.user_status === "active" &&
        Number(session.rows[0]!.data_epoch) === input.command.expectedDataEpoch &&
        sources.rows.length === input.command.coverageThroughSequence &&
        sources.rows.every(
          (source, index) =>
            Number(source.sequence_no) === index + 1 &&
            Number(source.sequence_no) === Number(source.event_sequence_no) &&
            source.lifecycle_status === "active" &&
            source.current_revision_id !== null &&
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
      const advances = !currentRow ||
        Number(currentRow.source_revision) < input.command.sourceRevision ||
        (Number(currentRow.source_revision) === input.command.sourceRevision &&
          Number(currentRow.dialogue_revision) < input.command.dialogueRevision) ||
        (Number(currentRow.source_revision) === input.command.sourceRevision &&
          Number(currentRow.dialogue_revision) === input.command.dialogueRevision &&
          Number(currentRow.covered_through_sequence_no) < input.command.coverageThroughSequence);
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
        `UPDATE dialogue_state_commands SET status = $2
         WHERE dialogue_state_command_id = $1`,
        [input.command.id, pointer.rowCount === 1 ? "published" : "stale"],
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

  public async fail(input: { commandId: string; errorCode: string }): Promise<void> {
    await this.pool.query(
      `UPDATE dialogue_state_commands SET status = 'failed', last_error_code = $2
       WHERE dialogue_state_command_id = $1 AND status IN ('created', 'running')`,
      [input.commandId, input.errorCode],
    );
  }

  public async stale(input: { commandId: string }): Promise<void> {
    await this.pool.query(
      `UPDATE dialogue_state_commands SET status = 'stale'
       WHERE dialogue_state_command_id = $1 AND status IN ('created', 'running')`,
      [input.commandId],
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
  return result.rows.map((source) => ({
    actor: source.actor,
    revisionId: asConversationEventRevisionId(
      source.conversation_event_revision_id,
    ),
    sequence: Number(source.sequence_no),
    text: source.canonical_text,
  }));
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
    `SELECT current_state.covered_through_sequence_no,
        current_state.dialogue_state_version_id,
        current_state.dialogue_revision, current_state.source_revision,
        current_state.updated_at, version.version_no, version.user_id,
        command.policy_version, command.prompt_version,
        command.model_config_version, version.content
     FROM current_dialogue_states current_state
     INNER JOIN dialogue_state_versions version
       ON version.dialogue_state_version_id = current_state.dialogue_state_version_id
     INNER JOIN dialogue_state_commands command
       ON command.dialogue_state_command_id = version.dialogue_state_command_id
     INNER JOIN app_users owner
       ON owner.user_id = current_state.user_id
      AND owner.status = 'active'
      AND owner.data_epoch = $2
     WHERE current_state.daily_session_id = $1
       AND current_state.source_revision <= $3
       AND current_state.dialogue_revision <= $4
       AND NOT EXISTS (
         SELECT 1
         FROM dialogue_state_command_source_refs ref
         INNER JOIN conversation_event_revisions revision
           ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
         INNER JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
         WHERE ref.dialogue_state_command_id = version.dialogue_state_command_id
           AND (revision.content_purged_at IS NOT NULL
             OR event.lifecycle_status <> 'active'
             OR revision.transcript_status NOT IN ('final', 'corrected')
             OR event.current_revision_id <> ref.conversation_event_revision_id)
       )`,
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
        Number(row.dialogue_revision) === input.dialogueRevision
          ? "current"
          : "lagging",
      updatedAt: row.updated_at,
      version: Number(row.version_no),
    },
    failure: false,
  };
}
