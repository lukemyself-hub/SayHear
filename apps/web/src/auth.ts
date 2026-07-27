import type { Adapter } from "next-auth/adapters";
import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

import {
  createPostgresAuthAdapter,
  createPostgresPool,
} from "@sayhear/data";

import type { loadRuntimeConfiguration } from "./runtime-config";

type RuntimeConfiguration = ReturnType<typeof loadRuntimeConfiguration>;
type Pool = ReturnType<typeof createPostgresPool>;

function logAuthCode(level: "error" | "warn", code: string): void {
  const write = level === "error" ? console.error : console.warn;
  write(`[sayhear.auth.${level}]`, { code });
}

export function createAuthOptions(input: {
  configuration: RuntimeConfiguration;
  pool: Pool;
}): NextAuthOptions {
  const secureCookies =
    input.configuration.deployment === "preview" ||
    input.configuration.deployment === "production";

  return {
    adapter: createPostgresAuthAdapter(input.pool, {
      clock: input.configuration.clock,
    }) as Adapter,
    callbacks: {
      session({ session, user }) {
        if (session.user) {
          session.user.id = user.id;
        }
        return session;
      },
    },
    cookies: {
      sessionToken: {
        name: secureCookies
          ? "__Secure-sayhear.session-token"
          : "sayhear.session-token",
        options: {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: secureCookies,
        },
      },
    },
    debug: false,
    logger: {
      debug() {},
      error(code) {
        logAuthCode("error", code);
      },
      warn(code) {
        logAuthCode("warn", code);
      },
    },
    providers: [
      GitHubProvider({
        clientId: input.configuration.githubClientId,
        clientSecret: input.configuration.githubClientSecret,
      }),
    ],
    secret: input.configuration.authSecret,
    session: {
      maxAge: 60 * 60 * 24 * 7,
      strategy: "database",
      updateAge: 60 * 60 * 24,
    },
    useSecureCookies: secureCookies,
  };
}
