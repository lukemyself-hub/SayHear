import { createHash } from "node:crypto";

import type { Pool } from "pg";

type AuthUser = Readonly<{
  email: string | null;
  emailVerified: Date | null;
  id: string;
  image: string | null;
  name: string | null;
}>;

type AuthUserInput = Omit<AuthUser, "id">;
type AuthSession = Readonly<{
  expires: Date;
  sessionToken: string;
  userId: string;
}>;

function tokenDigest(sessionToken: string): Buffer {
  return createHash("sha256").update(sessionToken, "utf8").digest();
}

function toAuthUser(userId: string): AuthUser {
  return {
    email: null,
    emailVerified: null,
    id: userId,
    image: null,
    name: "Internal Owner",
  };
}

export class UnauthorizedIdentityProvisioningError extends Error {
  public constructor() {
    super("Internal Owner users must be pre-provisioned.");
    this.name = "UnauthorizedIdentityProvisioningError";
  }
}

export function createPostgresAuthAdapter(
  pool: Pool,
  dependencies: { clock: () => Date } = { clock: () => new Date() },
) {
  const getUserByAccount = async (account: {
    provider: string;
    providerAccountId: string;
  }): Promise<AuthUser | null> => {
    if (account.provider !== "github") {
      return null;
    }

    const result = await pool.query<{ user_id: string }>(
      `
        SELECT user_id
        FROM active_internal_owner
        WHERE issuer = 'https://github.com'
          AND subject = $1
      `,
      [account.providerAccountId],
    );
    const row = result.rows[0];
    return row ? toAuthUser(row.user_id) : null;
  };

  const getUser = async (userId: string): Promise<AuthUser | null> => {
    const result = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM active_internal_owner WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    return row ? toAuthUser(row.user_id) : null;
  };

  const getSessionAndUser = async (
    sessionToken: string,
  ): Promise<{ session: AuthSession; user: AuthUser } | null> => {
    const result = await pool.query<{
      expires_at: Date;
      user_id: string;
    }>(
      `
        SELECT session.expires_at, session.user_id
        FROM auth_sessions session
        INNER JOIN active_internal_owner owner
          ON owner.user_id = session.user_id
        WHERE session.session_token_hash = $1
          AND session.expires_at > $2
      `,
      [tokenDigest(sessionToken), dependencies.clock()],
    );
    const row = result.rows[0];

    return row
      ? {
          session: {
            expires: row.expires_at,
            sessionToken,
            userId: row.user_id,
          },
          user: toAuthUser(row.user_id),
        }
      : null;
  };

  return {
    async createUser(_user: AuthUserInput): Promise<AuthUser> {
      throw new UnauthorizedIdentityProvisioningError();
    },

    getUserByAccount,

    getUser,

    async getUserByEmail(_email: string): Promise<AuthUser | null> {
      return null;
    },

    async updateUser(user: Partial<AuthUser> & Pick<AuthUser, "id">) {
      const existing = await getUser(user.id);
      if (existing === null) {
        throw new UnauthorizedIdentityProvisioningError();
      }
      return existing;
    },

    async linkAccount(account: {
      provider: string;
      providerAccountId: string;
      userId: string;
      [key: string]: unknown;
    }) {
      const mapped = await getUserByAccount(account);
      if (mapped?.id !== account.userId) {
        throw new UnauthorizedIdentityProvisioningError();
      }
      return account;
    },

    async unlinkAccount(): Promise<void> {
      throw new Error(
        "The Internal Owner identity mapping cannot be unlinked by Auth.js.",
      );
    },

    async createSession(session: AuthSession): Promise<AuthSession> {
      const sessionTokenHash = tokenDigest(session.sessionToken);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Acquire the same Owner-first row lock the purge transaction takes, so
        // a concurrent purge and this login serialize on the owner row. Once a
        // purge commits, the owner is no longer active and this login cannot
        // revive stale auth for that owner.
        const owner = await client.query<{ status: string }>(
          "SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE",
          [session.userId],
        );
        if (owner.rows[0] === undefined || owner.rows[0].status !== "active") {
          throw new UnauthorizedIdentityProvisioningError();
        }
        // ADR-0129: the one Phase 1 Internal Owner reads Reflection prose with
        // the owner-scoped `reflection_inspection:read` capability and no
        // repeated step-up. That capability is provisioned with the login
        // session itself so a normal Owner login never has to be repaired with
        // manual operator SQL. The session insert derives the caller from the
        // active_internal_owner view, which joins an active identity mapping to
        // an active app_user, so an unconfigured or disabled identity inserts
        // no session and receives no grant.
        const inserted = await client.query<{ user_id: string }>(
          `
            INSERT INTO auth_sessions (
              session_token_hash,
              user_id,
              expires_at
            )
            SELECT $1, owner.user_id, $3
            FROM active_internal_owner owner
            WHERE owner.user_id = $2
            ON CONFLICT (session_token_hash) DO NOTHING
            RETURNING user_id
          `,
          [sessionTokenHash, session.userId, session.expires],
        );
        if (inserted.rowCount === 0) {
          // The token may already exist. Only a currently valid session owned
          // by this same active Owner is idempotent; a non-owner, a different
          // identity's token, or an expired conflicting session fails closed.
          const existingOwnerSession = await client.query(
            `
              SELECT 1
              FROM auth_sessions session
              INNER JOIN active_internal_owner owner
                ON owner.user_id = session.user_id
              WHERE session.session_token_hash = $1
                AND session.user_id = $2
                AND session.expires_at > CURRENT_TIMESTAMP
            `,
            [sessionTokenHash, session.userId],
          );
          if (existingOwnerSession.rowCount === 0) {
            throw new UnauthorizedIdentityProvisioningError();
          }
        }
        // Reflection prose only. This never grants `conversation_content:read`
        // or `candidate_review`, never fakes a step-up timestamp, and DO NOTHING
        // keeps an explicitly revoked capability revoked across a new login.
        await client.query(
          `
            INSERT INTO internal_diagnostic_access_grants (
              session_token_hash,
              capability,
              status,
              step_up_authenticated_at,
              updated_at
            )
            VALUES (
              $1,
              'reflection_inspection:read',
              'active',
              NULL,
              CURRENT_TIMESTAMP
            )
            ON CONFLICT (session_token_hash, capability) DO NOTHING
          `,
          [sessionTokenHash],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return session;
    },

    getSessionAndUser,

    async updateSession(
      session: Partial<AuthSession> & Pick<AuthSession, "sessionToken">,
    ): Promise<AuthSession | null> {
      const current = await getSessionAndUser(session.sessionToken);
      if (current === null) {
        return null;
      }
      const nextSession = {
        expires: session.expires ?? current.session.expires,
        sessionToken: session.sessionToken,
        userId: session.userId ?? current.session.userId,
      };
      await pool.query(
        `
          UPDATE auth_sessions
          SET user_id = $2, expires_at = $3, updated_at = CURRENT_TIMESTAMP
          WHERE session_token_hash = $1
        `,
        [
          tokenDigest(nextSession.sessionToken),
          nextSession.userId,
          nextSession.expires,
        ],
      );
      return nextSession;
    },

    async deleteSession(sessionToken: string): Promise<void> {
      await pool.query(
        "DELETE FROM auth_sessions WHERE session_token_hash = $1",
        [tokenDigest(sessionToken)],
      );
    },
  };
}
