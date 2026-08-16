import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createRecoveryReapplyHandler } from "../../../../../../src/recovery-reapply-handler";
import { createServerComposition } from "../../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createRecoveryReapplyHandler({
    authenticate: async () => {
      const session = await getServerSession(composition.authOptions);
      return session?.user?.id ? { userId: asUserId(session.user.id) } : null;
    },
    service: composition.recoveryReapplyService,
  })(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
