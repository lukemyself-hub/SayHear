import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { authSessionIdFromRequest } from "../../../../../../../src/auth";
import { createCandidateReviewMapHandler } from "../../../../../../../src/candidate-review-handler";
import { createServerComposition } from "../../../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
): Promise<Response> {
  const composition = createServerComposition();
  const { candidateId } = await context.params;
  return createCandidateReviewMapHandler({
    authenticate: async (authenticatedRequest) => {
      const session = await getServerSession(composition.authOptions);
      const sessionCookieName =
        composition.authOptions.cookies?.sessionToken?.name;
      const authSessionId = sessionCookieName
        ? authSessionIdFromRequest(authenticatedRequest, sessionCookieName)
        : null;
      return session?.user?.id && authSessionId
        ? { authSessionId, userId: asUserId(session.user.id) }
        : null;
    },
    reviewService: composition.candidateReviewService,
  })(request, candidateId);
}
