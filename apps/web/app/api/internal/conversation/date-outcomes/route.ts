import { getServerSession } from "next-auth";

import { asDailySessionId, asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Touch the principal so an unauthenticated caller cannot read date outcomes.
  void asUserId(session.user.id);

  const url = new URL(request.url);
  const rawDailySessionId = url.searchParams.get("dailySessionId") ?? "";
  let dailySessionId;
  try {
    dailySessionId = asDailySessionId(rawDailySessionId);
  } catch {
    return Response.json(
      { error: "invalid_daily_session_id" },
      { status: 400 },
    );
  }

  const outcome = await composition.journalEligibilityRepository.findDateOutcome({
    dailySessionId,
  });
  if (!outcome) {
    return Response.json(
      { error: "date_outcome_not_found" },
      { status: 404 },
    );
  }
  return Response.json(outcome);
}
