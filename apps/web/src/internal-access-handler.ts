import {
  InternalOwnerAccessDeniedError,
  type InternalOwnerAccessService,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createInternalAccessHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: InternalOwnerAccessService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
      return Response.json(
        { error: "client_owner_identifier_not_allowed" },
        { status: 400 },
      );
    }

    try {
      return Response.json(await dependencies.service.getAccess(principal.userId));
    } catch (error) {
      if (error instanceof InternalOwnerAccessDeniedError) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      throw error;
    }
  };
}
