import { createRecoveryScannerHandler } from "../../../../../src/recovery-scanner-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createRecoveryScannerHandler({
    continuousExchangeService: composition.continuousExchangeService,
    conversationResponseService: composition.conversationResponseService,
    journalEligibilityService: composition.journalEligibilityService,
    outboxDispatcherService: composition.outboxDispatcherService,
    scannerSecret: composition.recoveryScannerSecret,
  })(request);
}
