import { getServerSession } from "next-auth";
import { asUserId } from "@sayhear/application";
import { createServerComposition } from "../../../../../src/server-composition";
import { createJournalRetryHandler } from "../../../../../src/journal-retry-handler";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createJournalRetryHandler({
    async authenticate() {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id ? { userId: asUserId(session.user.id) } : null;
    },
    recoveryGate: composition.recoveryGate,
    retryForDate: (input) => composition.journalWorkflowRecovery.retryForDate(input),
  })(request);
}
