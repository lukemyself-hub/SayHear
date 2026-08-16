import {
  RecoveryReapplyConfirmationError,
  RecoveryReapplyNotRequiredError,
  RecoveryGateClosedError,
  InternalOwnerAccessDeniedError,
  type InternalOwnerAccessService,
  type RecoveryReapplyService,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createRecoveryReapplyHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  operatorService: InternalOwnerAccessService;
  service: RecoveryReapplyService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      await dependencies.operatorService.assertOperator(principal.userId);
    } catch (error) {
      if (error instanceof InternalOwnerAccessDeniedError) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      throw error;
    }
    const url = new URL(request.url);
    if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
      return Response.json(
        { error: "client_owner_identifier_not_allowed" },
        { status: 400 },
      );
    }

    if (request.method === "GET") {
      return Response.json(await dependencies.service.inspect(principal.userId));
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { allow: "GET, POST" } },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const confirmation =
      typeof body === "object" && body !== null && "confirm" in body
        ? String((body as { confirm: unknown }).confirm)
        : "";
    try {
      return Response.json(
        await dependencies.service.reapply({
          confirmation,
          userId: principal.userId,
        }),
      );
    } catch (error) {
      if (error instanceof RecoveryReapplyConfirmationError) {
        return Response.json({ error: "confirmation_mismatch" }, { status: 400 });
      }
      if (error instanceof RecoveryReapplyNotRequiredError) {
        return Response.json(
          { error: "reapply_not_required", status: error.status },
          { status: 409 },
        );
      }
      if (error instanceof RecoveryGateClosedError) {
        return Response.json(
          { error: "recovery_gate_closed", status: error.result.status },
          { status: 503 },
        );
      }
      throw error;
    }
  };
}
