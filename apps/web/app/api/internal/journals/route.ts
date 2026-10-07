import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createJournalDateListHandler } from "../../../../src/journal-date-list-handler";
import { createServerComposition } from "../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  const handler = createJournalDateListHandler({
    async authenticate() {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.journalService,
  });
  return handler(request);
}
