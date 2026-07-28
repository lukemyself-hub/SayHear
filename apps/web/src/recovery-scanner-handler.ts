import type { ContinuousExchangeService } from "@sayhear/application";

export function createRecoveryScannerHandler(dependencies: {
  scannerSecret: string;
  service: ContinuousExchangeService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (
      !dependencies.scannerSecret ||
      request.headers.get("authorization") !==
        `Bearer ${dependencies.scannerSecret}`
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    return Response.json({
      inactivity: await dependencies.service.scanDueInactivity(),
    });
  };
}
