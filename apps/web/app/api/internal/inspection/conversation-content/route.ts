import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { authSessionIdFromRequest } from "../../../../../src/auth";
import { createSensitiveInspectionHandler } from "../../../../../src/sensitive-inspection-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createSensitiveInspectionHandler({
    authenticate: async (authenticatedRequest) => {
      const session = await getServerSession(composition.authOptions);
      const sessionCookieName =
        composition.authOptions.cookies?.sessionToken?.name;
      const authSessionId = sessionCookieName
        ? authSessionIdFromRequest(
            authenticatedRequest,
            sessionCookieName,
          )
        : null;
      return session?.user?.id && authSessionId
        ? { authSessionId, userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.inspectionService,
  })(request);
}
