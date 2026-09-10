import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { authSessionIdFromRequest } from "../../../../../src/auth";
import { createReflectionInspectionHandler } from "../../../../../src/reflection-inspection-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createReflectionInspectionHandler({
    authenticate: async (authenticatedRequest) => {
      const session = await getServerSession(composition.authOptions);
      const cookieName = composition.authOptions.cookies?.sessionToken?.name;
      const authSessionId = cookieName
        ? authSessionIdFromRequest(authenticatedRequest, cookieName)
        : null;
      return session?.user?.id && authSessionId
        ? { authSessionId, userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.reflectionInspectionService,
  })(request);
}
