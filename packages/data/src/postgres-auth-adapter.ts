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
      await pool.query(
        `
          INSERT INTO auth_sessions (
            session_token_hash,
            user_id,
            expires_at
          )
          VALUES ($1, $2, $3)
        `,
        [tokenDigest(session.sessionToken), session.userId, session.expires],
      );
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
