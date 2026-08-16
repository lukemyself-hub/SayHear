import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";
import { createOperatorFullPurgeHandler } from "../../../../../src/operator-full-purge-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createOperatorFullPurgeHandler({
    accessService: composition.accessService,
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id
        ? { userId: asUserId(session.user.id) }
        : null;
    },
    service: composition.ownerPurgeService,
  })(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
