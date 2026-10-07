import {
  JournalDateCursorError,
  RecoveryGateClosedError,
  type JournalService,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

/**
 * Read-only BFF for the Journal module's date list. Owner identity always comes
 * from the authenticated session; a client-supplied owner identifier is
 * rejected. The cursor is opaque and bound to the owner by the application
 * service.
 */
export function createJournalDateListHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: Pick<JournalService, "listJournalDates">;
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

    const cursor = url.searchParams.get("cursor");
    try {
      return Response.json(
        await dependencies.service.listJournalDates({
          cursor,
          userId: principal.userId,
        }),
      );
    } catch (error) {
      if (error instanceof JournalDateCursorError) {
        return Response.json({ error: "invalid_cursor" }, { status: 400 });
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
