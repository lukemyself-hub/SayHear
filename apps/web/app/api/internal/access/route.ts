import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createInternalAccessHandler } from "../../../../src/internal-access-handler";
import { createServerComposition } from "../../../../src/server-composition";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  const handler = createInternalAccessHandler({
    async authenticate() {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.accessService,
  });
  return handler(request);
}
