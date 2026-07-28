import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createConversationResponseHandler } from "../../../../../src/conversation-response-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createConversationResponseHandler({
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.conversationResponseService,
  })(request);
}
