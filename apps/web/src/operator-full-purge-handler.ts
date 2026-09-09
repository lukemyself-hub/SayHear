import {
  InternalOwnerAccessDeniedError,
  OwnerPurgeConfirmationError,
  OwnerPurgeOwnerStateError,
  type InternalOwnerAccessService,
  type OwnerFullPurgeService,
  type OwnerPurgeOrder,
  type OwnerPurgeReceipt,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

/**
 * Operator-only Internal Owner Full Purge endpoint (issue #27). "Operator"
 * maps to the single Internal Owner identity (ADR-0014) — there is no role
 * system, and the capability check goes through the existing internal-owner
 * access service. Natural-language Conversation requests can never reach this
 * surface: the Conversation Action Catalog contains no deletion operations.
 *
 * After the opening transaction the owner's Web sessions are revoked and the
 * owner stays `deleting` until receipts converge, so mid-flight requests fail
 * closed here by design; the recovery scan auto-retries `needs_attention`
 * orders, and a re-authenticated owner (post-revival) can inspect or restart.
 */
export function createOperatorFullPurgeHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  accessService: InternalOwnerAccessService;
  service: OwnerFullPurgeService;
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
      await dependencies.accessService.getAccess(principal.userId);
    } catch (error) {
      if (error instanceof InternalOwnerAccessDeniedError) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      throw error;
    }

    if (request.method === "GET") {
      // Content-free purge state inspection: order envelope + receipts only.
      const state = await dependencies.service.inspect({
        userId: principal.userId,
      });
      return Response.json(serialize(state.order, state.receipts, false));
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { allow: "GET, POST" } },
      );
    }

    let confirmation: unknown;
    try {
      confirmation = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (
      typeof confirmation !== "object" ||
      confirmation === null ||
      (confirmation as { confirm?: unknown }).confirm === undefined
    ) {
      return Response.json(
        { error: "confirmation_required" },
        { status: 400 },
      );
    }

    try {
      const started = await dependencies.service.start({
        confirmation: String((confirmation as { confirm: unknown }).confirm),
        userId: principal.userId,
      });
      return Response.json(
        serialize(started.order, started.receipts, started.created),
      );
    } catch (error) {
      if (error instanceof OwnerPurgeConfirmationError) {
        return Response.json({ error: "confirmation_mismatch" }, { status: 400 });
      }
      if (error instanceof OwnerPurgeOwnerStateError) {
        return Response.json({ error: error.reason }, { status: 409 });
      }
      throw error;
    }
  };
}

function serialize(
  order: OwnerPurgeOrder | null,
  receipts: readonly OwnerPurgeReceipt[],
  created: boolean,
) {
  return {
    created,
    order: order && {
      ownerPurgeOrderId: order.ownerPurgeOrderId,
      status: order.status,
      fromDataEpoch: order.fromDataEpoch,
      dataEpoch: order.dataEpoch,
      policyVersion: order.policyVersion,
      purgeSurfaceRegistryVersion: order.purgeSurfaceRegistryVersion,
      externalIntegrationManifestVersion:
        order.externalIntegrationManifestVersion,
      workflowSubjectManifestVersion: order.workflowSubjectManifestVersion,
      requestedAt: order.requestedAt,
      accessRevokedAt: order.accessRevokedAt,
      propagatingAt: order.propagatingAt,
      verifyingAt: order.verifyingAt,
      activeSystemDeletedAt: order.activeSystemDeletedAt,
      retentionPendingAt: order.retentionPendingAt,
      needsAttentionAt: order.needsAttentionAt,
      needsAttentionReason: order.needsAttentionReason,
      backupRetentionUntil: order.backupRetentionUntil,
    },
    receipts: receipts.map((receipt) => ({
      destination: receipt.destination,
      destinationDisposition: receipt.destinationDisposition,
      providerDisposition: receipt.providerDisposition,
      providerRetentionUntil: receipt.providerRetentionUntil,
      backupRetentionUntil: receipt.backupRetentionUntil,
      recordedAt: receipt.recordedAt,
    })),
  };
}
