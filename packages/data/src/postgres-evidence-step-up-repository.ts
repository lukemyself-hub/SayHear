import type { Pool, PoolClient } from "pg";

/**
 * ADR-0129: exact Evidence expansion requires the `conversation_content:read`
 * capability with a step-up completed within ten minutes. Before this writer
 * existed, tests seeded `step_up_authenticated_at` by hand and there was no
 * normal, server-verified way to complete a step-up.
 *
 * The step-up is a fresh GitHub OAuth roundtrip for the one Internal Owner
 * (provider `prompt=select_account`), never a password re-entry. The intent is
 * signed with the existing Auth.js secret in `apps/web/src/content-step-up.ts`;
 * this repository owns the atomic persistence and re-verifies every fact in
 * the same transaction that writes the grant.
 *
 * The bound is intentionally narrow:
 * - only the active Internal Owner's own live session is elevated,
 * - only the closed `conversation_content:read` capability is written,
 * - the timestamp is bounded by the signed intent issue time,
 * - a revoked grant is never reactivated,
 * - the first completion for an intent fences replays.
 */

export const EVIDENCE_STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;
export const CONVERSATION_CONTENT_CAPABILITY = "conversation_content:read";
export const REFLECTION_INSPECTION_CAPABILITY = "reflection_inspection:read";
export const INTERNAL_OWNER_GITHUB_ISSUER = "https://github.com";

export type EvidenceStepUpIssuerContext =
  | Readonly<{ outcome: "allowed"; dataEpoch: number }>
  | Readonly<{ outcome: "denied"; reason: "step_up_not_permitted" }>;

export type EvidenceStepUpDenialReason =
  | "authorization_revoked"
  | "epoch_mismatch"
  | "grant_revoked"
  | "identity_unverified"
  | "intent_expired"
  | "replay"
  | "session_mismatch";

export type EvidenceStepUpCompletionResult =
  | Readonly<{ outcome: "elevated" }>
  | Readonly<{ outcome: "denied"; reason: EvidenceStepUpDenialReason }>;

type OwnerRow = Readonly<{ data_epoch: string; status: string }>;
type GrantRow = Readonly<{
  status: string;
  step_up_authenticated_at: Date | null;
}>;

export class PostgresEvidenceStepUpRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * The intent issuer requires the caller's *normal* owner session plus an
   * active `reflection_inspection:read` grant (owner-scoped reflection prose
   * access, ADR-0129). This only reads; it never writes a grant.
   */
  public async readStepUpIssuerContext(input: {
    authSessionId: string;
    now: Date;
    userId: string;
  }): Promise<EvidenceStepUpIssuerContext> {
    const result = await this.pool.query<{
      grant_status: string | null;
      data_epoch: string;
    }>(
      `SELECT
         owner.user_id AS owner_user_id,
         users.data_epoch::text AS data_epoch,
         reflection_grant.status AS grant_status
       FROM auth_sessions session
       INNER JOIN active_internal_owner owner
         ON owner.user_id = session.user_id
        AND owner.issuer = $3
       INNER JOIN app_users users
         ON users.user_id = session.user_id
        AND users.status = 'active'
       LEFT JOIN internal_diagnostic_access_grants reflection_grant
         ON reflection_grant.session_token_hash = session.session_token_hash
        AND reflection_grant.capability = $5
       WHERE session.user_id = $1
         AND session.session_token_hash = decode($2, 'hex')
         AND session.expires_at > $4`,
      [
        input.userId,
        input.authSessionId,
        INTERNAL_OWNER_GITHUB_ISSUER,
        input.now,
        REFLECTION_INSPECTION_CAPABILITY,
      ],
    );
    const row = result.rows[0];
    if (!row || row.grant_status !== "active") {
      return { outcome: "denied", reason: "step_up_not_permitted" };
    }
    return { outcome: "allowed", dataEpoch: Number(row.data_epoch) };
  }

  /**
   * Completes a step-up after a real, verified GitHub OAuth callback. The
   * caller has already verified the signed intent and event identity; this
   * method re-verifies everything against the database and fails closed.
   */
  public async completeEvidenceStepUp(input: {
    authSessionId: string;
    dataEpoch: number;
    issuedAt: Date;
    now: Date;
    providerAccountId: string;
    userId: string;
  }): Promise<EvidenceStepUpCompletionResult> {
    const ageMs = input.now.getTime() - input.issuedAt.getTime();
    if (ageMs <= 0 || ageMs > EVIDENCE_STEP_UP_MAX_AGE_MS) {
      return { outcome: "denied", reason: "intent_expired" };
    }

    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;

      // 1. Lock the active owner row first, in the same order as Full Purge
      //    (app_users row before dependent state). This serializes concurrent
      //    callbacks and purge/freeze transitions.
      const owner = await client.query<OwnerRow>(
        `SELECT status, data_epoch::text
         FROM app_users
         WHERE user_id = $1
         FOR UPDATE`,
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        return await this.deny(client, transactionStarted, "authorization_revoked");
      }
      if (Number(ownerRow.data_epoch) !== input.dataEpoch) {
        return await this.deny(client, transactionStarted, "epoch_mismatch");
      }

      // 2. The verified OAuth identity must be the active Internal Owner's
      //    exact GitHub subject. Missing verified account never falls back to
      //    the user id alone.
      const identity = await client.query<{ user_id: string }>(
        `SELECT user_id
         FROM active_internal_owner
         WHERE user_id = $1 AND issuer = $2 AND subject = $3`,
        [input.userId, INTERNAL_OWNER_GITHUB_ISSUER, input.providerAccountId],
      );
      if (!identity.rows[0]) {
        return await this.deny(client, transactionStarted, "identity_unverified");
      }

      // 3. The elevated capability is bound to the live session cookie.
      const session = await client.query<{ session_token_hash: Buffer }>(
        `SELECT session_token_hash
         FROM auth_sessions
         WHERE session_token_hash = decode($1, 'hex')
           AND user_id = $2
           AND expires_at > $3`,
        [input.authSessionId, input.userId, input.now],
      );
      if (!session.rows[0]) {
        return await this.deny(client, transactionStarted, "session_mismatch");
      }

      // 4. Reflection prose access must still be active for this session.
      const reflectionGrant = await client.query<{ status: string }>(
        `SELECT status
         FROM internal_diagnostic_access_grants
         WHERE session_token_hash = decode($1, 'hex')
           AND capability = $2`,
        [input.authSessionId, REFLECTION_INSPECTION_CAPABILITY],
      );
      if (reflectionGrant.rows[0]?.status !== "active") {
        return await this.deny(client, transactionStarted, "authorization_revoked");
      }

      // 5. Read the existing conversation-content grant under the owner lock.
      //    A revoked grant is never reactivated, and any completion already
      //    recorded at or after the signed issue time is a replay.
      const existing = await client.query<GrantRow>(
        `SELECT status, step_up_authenticated_at
         FROM internal_diagnostic_access_grants
         WHERE session_token_hash = decode($1, 'hex')
           AND capability = $2
         FOR UPDATE`,
        [input.authSessionId, CONVERSATION_CONTENT_CAPABILITY],
      );
      const current = existing.rows[0];
      if (current && current.status !== "active") {
        return await this.deny(client, transactionStarted, "grant_revoked");
      }
      if (
        current?.step_up_authenticated_at &&
        current.step_up_authenticated_at.getTime() >= input.issuedAt.getTime()
      ) {
        return await this.deny(client, transactionStarted, "replay");
      }

      // 6. Create the source grant when missing; otherwise move the step-up
      //    timestamp only for an active grant whose previous step-up predates
      //    this intent. `now` is the real application clock, never a future
      //    or caller-supplied value.
      const upsert = await client.query(
        `INSERT INTO internal_diagnostic_access_grants (
           session_token_hash, capability, status, step_up_authenticated_at,
           updated_at
         ) VALUES (decode($1, 'hex'), $2, 'active', $4, $4)
         ON CONFLICT (session_token_hash, capability) DO UPDATE
           SET step_up_authenticated_at = EXCLUDED.step_up_authenticated_at,
               updated_at = EXCLUDED.updated_at
           WHERE internal_diagnostic_access_grants.status = 'active'
             AND (
               internal_diagnostic_access_grants.step_up_authenticated_at IS NULL
               OR internal_diagnostic_access_grants.step_up_authenticated_at < $3
             )
         RETURNING session_token_hash`,
        [
          input.authSessionId,
          CONVERSATION_CONTENT_CAPABILITY,
          input.issuedAt,
          input.now,
        ],
      );
      if (upsert.rowCount !== 1) {
        return await this.deny(client, transactionStarted, "replay");
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return { outcome: "elevated" };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async deny(
    client: PoolClient,
    transactionStarted: boolean,
    reason: EvidenceStepUpDenialReason,
  ): Promise<EvidenceStepUpCompletionResult> {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    return { outcome: "denied", reason };
  }
}
