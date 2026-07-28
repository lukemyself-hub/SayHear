import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createContinuousExchangeEndHandler } from "../../../../../../src/continuous-exchange-end-handler";
import { createServerComposition } from "../../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createContinuousExchangeEndHandler({
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.conversationService,
  })(request);
}
