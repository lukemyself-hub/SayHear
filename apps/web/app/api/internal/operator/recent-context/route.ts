import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";
import { createOperatorRecentContextHandler } from "../../../../../src/operator-recent-context-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operator entrypoint for the independent recent-context governance switch
 * (issue #295). GET reports the content-free effective state; POST
 * `{ "action": "disable" }` revokes the active immutable version and POST
 * `{ "action": "enable" }` inserts a brand-new one. Authentication and the
 * Internal Owner capability check match the Full Purge operator surface.
 */
async function handle(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createOperatorRecentContextHandler({
    accessService: composition.accessService,
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    repository: composition.recentContextGovernanceRepository,
  })(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
