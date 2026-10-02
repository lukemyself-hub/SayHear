import type {
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";
import type { PoolClient } from "pg";

/**
 * Locks the command, its exact attempt, and the exact active rollout pin the
 * command was frozen under before a role-specific domain transaction writes
 * private-derived state. Recovery settles the old attempt in the same ledger
 * and rollback revokes the old pin, so a late provider callback must fail
 * closed here (ADR-0132/ADR-0134).
 *
 * The pin row is locked FOR UPDATE so a concurrent revoke/re-pin cannot commit
 * between this check and the domain write. Matching the command's frozen
 * `rollout_pin`/`config_version`/`provider_policy_version` prevents a late
 * result from being written under a newer pin after rollback: an any-active
 * pin lookup is not a sufficient fence.
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
     INNER JOIN model_role_rollout_pins pin
       ON pin.role = command.model_role
      AND pin.rollout_pin = command.rollout_pin
      AND pin.config_version = command.model_config_version
      AND pin.provider_policy_version = command.provider_policy_version
      AND pin.status = 'active'
     WHERE command.generation_command_id = $1
       AND command.user_id = $2
       AND attempt.model_run_attempt_id = $3
     FOR UPDATE OF command, attempt, pin`,
    [input.generationCommandId, input.userId, input.modelRunAttemptId],
  );
  return result.rows[0]?.status === "running";
}
