import type {
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";
import type { PoolClient } from "pg";

/**
 * Locks the command and its exact attempt before a role-specific domain
 * transaction writes private-derived state. Recovery settles the old attempt
 * in the same ledger, so a late provider callback must fail closed here.
 */
export async function modelRoleAttemptIsRunning(
  client: PoolClient,
  input: Readonly<{
    userId: UserId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }>,
): Promise<boolean> {
  const result = await client.query<{ status: string }>(
    `SELECT attempt.status
     FROM generation_commands command
     INNER JOIN model_run_attempts attempt
       ON attempt.generation_command_id = command.generation_command_id
      AND attempt.user_id = command.user_id
     WHERE command.generation_command_id = $1
       AND command.user_id = $2
       AND attempt.model_run_attempt_id = $3
     FOR UPDATE OF command, attempt`,
    [input.generationCommandId, input.userId, input.modelRunAttemptId],
  );
  return result.rows[0]?.status === "running";
}
