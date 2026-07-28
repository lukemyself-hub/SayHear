import {
  asGenerationCommandId,
  InternalInspectionNotFoundError,
  type InternalInspectionService,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createInternalInspectionHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: InternalInspectionService;
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
    const generationCommandId = url.searchParams.get(
      "generation_command_id",
    );
    if (!generationCommandId) {
      return Response.json(
        { error: "generation_command_id_required" },
        { status: 400 },
      );
    }

    try {
      return Response.json(
        await dependencies.service.getGenerationMetadata(
          principal.userId,
          asGenerationCommandId(generationCommandId),
        ),
      );
    } catch (error) {
      if (error instanceof InternalInspectionNotFoundError) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      throw error;
    }
  };
}
