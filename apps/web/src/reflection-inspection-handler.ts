import {
  asEvidenceItemId,
  asMemoryCandidateId,
  asMemoryClaimVersionId,
  asReflectionAtomicPropositionId,
  asReflectionId,
  asReflectionStatementId,
  asReflectionVersionId,
  RecoveryGateClosedError,
  ReflectionInspectionAuditError,
  ReflectionInspectionCursorError,
  ReflectionInspectionDeniedError,
  ReflectionInspectionLimitError,
  type ReflectionInspectionFilters,
  type ReflectionInspectionService,
  type ReflectionScopeType,
  type ReflectionVersionStatus,
  type UserId,
} from "@sayhear/application";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFLECTION_STATUSES: readonly ReflectionVersionStatus[] = [
  "draft",
  "failed",
  "committed",
  "superseded",
  "stale",
];

type AuthenticatedPrincipal = Readonly<{
  authSessionId: string;
  userId: UserId;
}>;

class InvalidReflectionInspectionRequestError extends Error {}

function requiredId(
  url: URL,
  name: string,
): string {
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!value || !UUID_V7_PATTERN.test(value)) {
    throw new InvalidReflectionInspectionRequestError(`${name}_required`);
  }
  return value;
}

function optionalId(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!value) return null;
  if (!UUID_V7_PATTERN.test(value)) {
    throw new InvalidReflectionInspectionRequestError(`${name}_invalid`);
  }
  return value;
}

function parseLimit(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null || value.trim() === "") return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ReflectionInspectionLimitError();
  }
  return limit;
}

function parseDate(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidReflectionInspectionRequestError(`${name}_invalid`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidReflectionInspectionRequestError(`${name}_invalid`);
  }
  return value;
}

function parseFilters(url: URL): ReflectionInspectionFilters {
  const scopeType = url.searchParams.get("scope_type");
  if (scopeType && scopeType !== "daily_session" && scopeType !== "date_range") {
    throw new InvalidReflectionInspectionRequestError("scope_type_invalid");
  }
  const requestedStatuses = url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const status = requestedStatuses.length > 0 ? requestedStatuses : undefined;
  if (status?.some((value) => !REFLECTION_STATUSES.includes(value as ReflectionVersionStatus))) {
    throw new InvalidReflectionInspectionRequestError("status_invalid");
  }
  const fromDate = parseDate(url, "from_date");
  const toDate = parseDate(url, "to_date");
  const candidateId = optionalId(url, "candidate_id");
  const reflectionVersionId = optionalId(url, "reflection_version_id");
  const filters: {
    candidateId?: ReturnType<typeof asMemoryCandidateId>;
    fromDate?: string;
    reflectionVersionId?: ReturnType<typeof asReflectionVersionId>;
    scopeType?: ReflectionScopeType;
    status?: readonly ReflectionVersionStatus[];
    toDate?: string;
  } = {};
  if (candidateId !== null) filters.candidateId = asMemoryCandidateId(candidateId);
  if (fromDate !== undefined) filters.fromDate = fromDate;
  if (reflectionVersionId !== null) {
    filters.reflectionVersionId = asReflectionVersionId(reflectionVersionId);
  }
  if (scopeType) filters.scopeType = scopeType as ReflectionScopeType;
  if (status) filters.status = status as readonly ReflectionVersionStatus[];
  if (toDate !== undefined) filters.toDate = toDate;
  return filters;
}

export function createReflectionInspectionHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: ReflectionInspectionService;
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
      await dependencies.service.authorize(
        principal.userId,
        principal.authSessionId,
      );
      const layer = url.searchParams.get("layer") ?? "reflections";
      const cursor = url.searchParams.get("cursor");
      const limit = parseLimit(url);
      const expectedCurrentVersionValue = optionalId(
        url,
        "expected_current_version_id",
      );
      const expectedCurrentVersionId = expectedCurrentVersionValue
        ? asReflectionVersionId(expectedCurrentVersionValue)
        : null;

      switch (layer) {
        case "reflections": {
          const reflectionId = optionalId(url, "reflection_id");
          if (
            reflectionId &&
            (url.searchParams.has("candidate_id") ||
              url.searchParams.has("reflection_version_id"))
          ) {
            throw new InvalidReflectionInspectionRequestError(
              "reflection_locator_conflict",
            );
          }
          if (reflectionId) {
            return Response.json(
              await dependencies.service.readReflection(
                principal.userId,
                asReflectionId(reflectionId),
                expectedCurrentVersionId,
              ),
            );
          }
          return Response.json(
            await dependencies.service.listReflections(
              principal.userId,
              parseFilters(url),
              limit,
              cursor,
            ),
          );
        }
        case "versions":
          return Response.json(
            await dependencies.service.listVersions(
              principal.userId,
              asReflectionId(requiredId(url, "reflection_id")),
              expectedCurrentVersionId,
              limit,
              cursor,
            ),
          );
        case "statements":
          return Response.json(
            await dependencies.service.listStatements(
              principal.userId,
              asReflectionVersionId(requiredId(url, "reflection_version_id")),
              expectedCurrentVersionId,
              limit,
              cursor,
            ),
          );
        case "propositions":
          return Response.json(
            await dependencies.service.listPropositions(
              principal.userId,
              asReflectionStatementId(requiredId(url, "statement_id")),
              expectedCurrentVersionId,
              limit,
              cursor,
            ),
          );
        case "evidence":
          return Response.json(
            await dependencies.service.listEvidenceLinks(
              principal.userId,
              asReflectionAtomicPropositionId(
                requiredId(url, "proposition_id"),
              ),
              expectedCurrentVersionId,
              limit,
              cursor,
            ),
          );
        case "evidence_content":
          return Response.json(
            await dependencies.service.expandEvidence(
              principal.userId,
              principal.authSessionId,
              asEvidenceItemId(requiredId(url, "evidence_item_id")),
            ),
          );
        case "candidates":
          return Response.json(
            await dependencies.service.listCandidates(
              principal.userId,
              asReflectionVersionId(requiredId(url, "reflection_version_id")),
              expectedCurrentVersionId,
              limit,
              cursor,
            ),
          );
        case "candidate_successors":
          return Response.json(
            await dependencies.service.listCandidateSuccessors(
              principal.userId,
              asMemoryCandidateId(requiredId(url, "candidate_id")),
              limit,
              cursor,
            ),
          );
        case "candidate_predecessors":
          return Response.json(
            await dependencies.service.listCandidatePredecessors(
              principal.userId,
              asMemoryCandidateId(requiredId(url, "candidate_id")),
              limit,
              cursor,
            ),
          );
        case "claims":
          return Response.json(
            await dependencies.service.listClaimImpacts(
              principal.userId,
              asMemoryCandidateId(requiredId(url, "candidate_id")),
              limit,
              cursor,
            ),
          );
        case "bio_impact":
          return Response.json(
            await dependencies.service.listBioImpacts(
              principal.userId,
              asMemoryClaimVersionId(
                requiredId(url, "memory_claim_version_id"),
              ),
              limit,
              cursor,
            ),
          );
        default:
          throw new InvalidReflectionInspectionRequestError("layer_invalid");
      }
    } catch (error) {
      if (error instanceof InvalidReflectionInspectionRequestError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      if (error instanceof ReflectionInspectionDeniedError) {
        return Response.json(
          { error: "reflection_capability_required" },
          { status: 403 },
        );
      }
      if (error instanceof ReflectionInspectionCursorError) {
        return Response.json({ error: "invalid_cursor" }, { status: 400 });
      }
      if (error instanceof ReflectionInspectionLimitError) {
        return Response.json({ error: "invalid_limit" }, { status: 400 });
      }
      if (error instanceof ReflectionInspectionAuditError) {
        return Response.json(
          { error: "evidence_access_audit_failed" },
          { status: 503 },
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
