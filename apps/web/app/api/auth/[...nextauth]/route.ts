import NextAuth from "next-auth";

import {
  EVIDENCE_STEP_UP_CALLBACK_PATH,
  appendEvidenceStepUpIntentCookieClear,
  requestScopedEvidenceStepUpAuthOptions,
} from "../../../../src/content-step-up";
import { createServerComposition } from "../../../../src/server-composition";

function isGithubCallbackRequest(request: Request): boolean {
  return new URL(request.url).pathname === EVIDENCE_STEP_UP_CALLBACK_PATH;
}

export async function GET(request: Request, context: unknown) {
  const composition = createServerComposition();
  const isCallback = isGithubCallbackRequest(request);
  const options = isCallback
    ? requestScopedEvidenceStepUpAuthOptions({
        authOptions: composition.authOptions,
        clock: composition.clock,
        completion: composition.evidenceStepUpRepository,
        request,
        secret: composition.authOptions.secret ?? "",
        sessionCookieName:
          composition.authOptions.cookies?.sessionToken?.name ?? null,
      })
    : composition.authOptions;
  const response = await NextAuth(options)(request, context);
  if (!isCallback) {
    return response;
  }
  return appendEvidenceStepUpIntentCookieClear(response, {
    secure: composition.authOptions.useSecureCookies === true,
  });
}

export async function POST(request: Request, context: unknown) {
  return NextAuth(createServerComposition().authOptions)(request, context);
}
