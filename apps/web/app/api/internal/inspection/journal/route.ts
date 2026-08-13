import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { authSessionIdFromRequest } from "../../../../../src/auth";
import { createJournalInspectionHandler } from "../../../../../src/journal-inspection-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createJournalInspectionHandler({
    authenticate: async (authenticatedRequest) => {
      const session = await getServerSession(composition.authOptions);
      const cookieName = composition.authOptions.cookies?.sessionToken?.name;
      const authSessionId = cookieName ? authSessionIdFromRequest(authenticatedRequest, cookieName) : null;
      return session?.user?.id && authSessionId ? { authSessionId, userId: asUserId(session.user.id) } : null;
    },
    authorize: composition.inspectionService.authorizeSensitiveInspection,
    expectedDataEpoch: composition.configurationExpectedDataEpoch,
    service: composition.journalService,
  })(request);
}
