import {
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_RECALL_DEFAULT_POLICY,
  HistoryRecallGovernanceConflictError,
  InternalOwnerAccessDeniedError,
  HISTORY_RECALL_TIME_COMPILER_VERSION,
  type HistoryRecallGovernanceEffectiveState,
  type HistoryRecallGovernancePolicy,
  type HistoryRecallGovernanceRepository,
  type InternalOwnerAccessService,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

/**
 * Operator-only history-recall governance endpoint (issue #320), the same
 * shape and authorization as the recent-context one. `GET` reports the
 * content-free effective state; `POST {action:"disable"}` revokes the single
 * active immutable version in one transaction; `POST {action:"enable"}`
 * inserts a brand-new version. A revoked version is never resurrected, so a
 * result frozen under it stays unusable, and re-enabling revives nothing.
 */
export function createOperatorHistoryRecallHandler(dependencies: {
  accessService: InternalOwnerAccessService;
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  now?: () => Date;
  repository: HistoryRecallGovernanceRepository;
}): (request: Request) => Promise<Response> {
  const now = () => (dependencies.now ?? (() => new Date()))();
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
      await dependencies.accessService.getAccess(principal.userId);
    } catch (error) {
      if (error instanceof InternalOwnerAccessDeniedError) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      throw error;
    }

    if (request.method === "GET") {
      return Response.json(
        serialize(await dependencies.repository.findEffectiveState()),
      );
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
    const action =
      typeof body === "object" && body !== null
        ? (body as { action?: unknown }).action
        : undefined;
    if (action !== "enable" && action !== "disable") {
      return Response.json(
        { error: "action_required", allowed: ["enable", "disable"] },
        { status: 400 },
      );
    }
    try {
      if (action === "disable") {
        const result = await dependencies.repository.revokeActivePolicy({
          now: now(),
          revokedBy: principal.userId,
        });
        return Response.json({
          effective: serialize(
            await dependencies.repository.findEffectiveState(),
          ),
          outcome: result.outcome,
        });
      }
      const policy = await dependencies.repository.insertActivePolicy({
        changedBy: principal.userId,
        compilerVersion: HISTORY_RECALL_TIME_COMPILER_VERSION,
        harnessPolicyVersion: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
        historyPolicyVersion: HISTORY_RECALL_DEFAULT_POLICY.version,
        now: now(),
      });
      return Response.json({
        effective: serialize(
          await dependencies.repository.findEffectiveState(),
        ),
        outcome: "enabled",
        policy: { ...policy },
      });
    } catch (error) {
      if (error instanceof HistoryRecallGovernanceConflictError) {
        return Response.json({ error: "already_enabled" }, { status: 409 });
      }
      throw error;
    }
  };
}

function serialize(state: HistoryRecallGovernanceEffectiveState) {
  const plain = (policy: HistoryRecallGovernancePolicy | null) =>
    policy === null ? null : { ...policy };
  return {
    active: plain(state.active),
    enabled: state.enabled,
    latest: plain(state.latest),
    policyCount: state.policyCount,
  };
}
