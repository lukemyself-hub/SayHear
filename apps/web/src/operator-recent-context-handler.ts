import {
  InternalOwnerAccessDeniedError,
  RECENT_CONTEXT_COMPILER_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  RecentContextGovernanceConflictError,
  type InternalOwnerAccessService,
  type RecentContextGovernanceEffectiveState,
  type RecentContextGovernancePolicy,
  type RecentContextGovernanceRepository,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

/**
 * Operator-only recent-context governance endpoint (issue #295).
 *
 * "Operator" maps to the single Internal Owner identity (ADR-0014); the
 * capability check goes through the existing internal-owner access service,
 * exactly like the Full Purge surface. There is no natural-language path here:
 * the Conversation Action Catalog has no governance operations.
 *
 * `GET` reports the content-free effective state. `POST` disables (revoke the
 * single active immutable version in one transaction) or re-enables (insert a
 * brand-new version). A revoked version is never resurrected and its audit
 * fields are write-once: `changed_by` records who enabled it, `revoked_by`
 * records who revoked it, and revocation never overwrites the enable actor.
 * An in-flight selection that froze the old version fails closed at the next
 * fence.
 */
export function createOperatorRecentContextHandler(dependencies: {
  accessService: InternalOwnerAccessService;
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  now?: () => Date;
  repository: RecentContextGovernanceRepository;
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
        budgetTokens: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
        changedBy: principal.userId,
        compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
        maxCandidateBytes:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
        maxCandidateRows: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
        maxSingleEventTokens:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens,
        now: now(),
        readTimeoutMs: RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs,
        selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
        selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      });
      return Response.json({
        effective: serialize(
          await dependencies.repository.findEffectiveState(),
        ),
        outcome: "enabled",
        policy: serializePolicy(policy),
      });
    } catch (error) {
      if (error instanceof RecentContextGovernanceConflictError) {
        return Response.json({ error: "already_enabled" }, { status: 409 });
      }
      throw error;
    }
  };
}

function serializePolicy(policy: RecentContextGovernancePolicy) {
  return {
    budgetTokens: policy.budgetTokens,
    changedBy: policy.changedBy,
    compilerVersion: policy.compilerVersion,
    createdAt: policy.createdAt,
    maxCandidateBytes: policy.maxCandidateBytes,
    maxCandidateRows: policy.maxCandidateRows,
    maxSingleEventTokens: policy.maxSingleEventTokens,
    policyVersion: policy.policyVersion,
    readTimeoutMs: policy.readTimeoutMs,
    revokedAt: policy.revokedAt,
    revokedBy: policy.revokedBy,
    selectionPolicyVersion: policy.selectionPolicyVersion,
    selectorPolicyVersion: policy.selectorPolicyVersion,
    status: policy.status,
  };
}

function serialize(state: RecentContextGovernanceEffectiveState) {
  return {
    active: state.active ? serializePolicy(state.active) : null,
    enabled: state.enabled,
    latest: state.latest ? serializePolicy(state.latest) : null,
    policyCount: state.policyCount,
  };
}
