import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
    return Response.json(
      { error: "client_owner_identifier_not_allowed" },
      { status: 400 },
    );
  }
  return Response.json(
    await composition.recoveryReapplyService.inspect(
      asUserId(session.user.id),
    ),
  );
}
