import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";
import { createOperatorHistoryRecallHandler } from "../../../../../src/operator-history-recall-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operator entrypoint for the independent history-recall governance switch
 * (issue #320). GET reports the content-free effective state; POST
 * `{ "action": "disable" }` revokes the active immutable version and POST
 * `{ "action": "enable" }` inserts a brand-new one. Closing also drains the
 * unsettled History Answer commands and reports how many remain; POST
 * `{ "action": "drain" }` repeats that while the branch is closed (a rollback
 * to a release without the history branch waits for 0). Authentication and the
 * Internal Owner capability check match the recent-context operator surface.
 */
async function handle(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createOperatorHistoryRecallHandler({
    accessService: composition.accessService,
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    historyAnswers: composition.historyAnswerDrain,
    repository: composition.historyRecallGovernanceRepository,
  })(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
