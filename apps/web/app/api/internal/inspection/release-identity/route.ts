import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { buildHostedReleaseIdentity, isReleaseIdentityOperatorRequest } from "../../../../../src/release-identity";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Content-free release identity for the hosted acceptance verifier. It uses the
 * same Internal Owner inspection authentication as the other inspection
 * endpoints. The existing Cron operator may also read this content-free
 * resource; it grants no private-content access.
 */
export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  if (!isReleaseIdentityOperatorRequest(request, process.env.CRON_SECRET)) {
    const session = await getServerSession(composition.authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      await composition.accessService.assertOperator(asUserId(session.user.id));
    } catch {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }
  try {
    return Response.json(buildHostedReleaseIdentity(process.env), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "release_identity_unavailable" },
      { status: 503 },
    );
  }
}
