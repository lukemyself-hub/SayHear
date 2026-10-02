import { getServerSession } from "next-auth";

import { authSessionIdFromRequest } from "../../../../../src/auth";
import { createEvidenceStepUpIntentHandler } from "../../../../../src/content-step-up";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createEvidenceStepUpIntentHandler({
    authenticate: async (authenticatedRequest) => {
      const session = await getServerSession(composition.authOptions);
      if (!session?.user?.id) {
        return null;
      }
      const cookieName = composition.authOptions.cookies?.sessionToken?.name;
      if (!cookieName) {
        return null;
      }
      const authSessionId = authSessionIdFromRequest(
        authenticatedRequest,
        cookieName,
      );
      return authSessionId
        ? { authSessionId, userId: session.user.id }
        : null;
    },
    clock: composition.clock,
    repository: composition.evidenceStepUpRepository,
    secret: composition.authOptions.secret ?? "",
    secureCookie: composition.authOptions.useSecureCookies === true,
  })(request);
}
