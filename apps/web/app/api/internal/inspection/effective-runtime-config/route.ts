import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { handleEffectiveRuntimeConfigRequest } from "../../../../../src/effective-runtime-config";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Content-free effective runtime configuration for the release comparison
 * gate. It uses the same Internal Owner inspection authentication as the other
 * inspection endpoints; the existing Cron operator may also read this
 * content-free resource. It never returns a secret value or connection string,
 * and it fails closed when the deployment cannot resolve its own configuration.
 */
export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return handleEffectiveRuntimeConfigRequest(request, {
    environment: process.env,
    operatorSecret: process.env.CRON_SECRET,
    getSession: () => getServerSession(composition.authOptions),
    assertOperator: async (userId) => {
      await composition.accessService.assertOperator(asUserId(userId));
    },
    loadRecentContextGovernance: () =>
      composition.recentContextGovernanceRepository.findEffectiveState(),
    loadHistoryRecallGovernance: () =>
      composition.historyRecallGovernanceRepository.findEffectiveState(),
  });
}
