import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";
import { createUserEvidenceCorrectionHandler } from "../../../../../src/user-evidence-correction-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createUserEvidenceCorrectionHandler({
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id ? { userId: asUserId(session.user.id) } : null;
    },
    conversationService: composition.conversationService,
    journalEligibilityService: composition.journalEligibilityService,
  })(request);
}
