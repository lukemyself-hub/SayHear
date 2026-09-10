import {
  CandidateReviewAuthError,
  asMemoryCandidateId,
  asPredicateChangeProposalId,
  type CandidateReviewPortalService,
  type CandidateReviewService,
  type PredicateGovernanceService,
  type UserId,
} from "@sayhear/application";

import { candidateReviewOutcomeCopy } from "./candidate-review-copy";

export type AuthenticatedPrincipal = Readonly<{
  authSessionId: string;
  userId: UserId;
}>;

export type ReviewAuthenticator = (
  request: Request,
) => Promise<AuthenticatedPrincipal | null>;

function rejectClientOwnerIdentifier(url: URL): Response | null {
  if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
    return Response.json(
      {
        outcome: "invalid_reason_code",
        message: candidateReviewOutcomeCopy("invalid_reason_code"),
      },
      { status: 400 },
    );
  }
  return null;
}

function authErrorResponse(error: CandidateReviewAuthError): Response {
  const status = error.code === "unauthorized" ? 401 : 403;
  return Response.json(
    { outcome: error.code, message: candidateReviewOutcomeCopy(error.code) },
    { status },
  );
}

function withOutcome(
  outcome: string,
  extra: Record<string, unknown> = {},
  status = 200,
): Response {
  return Response.json(
    { outcome, message: candidateReviewOutcomeCopy(outcome), ...extra },
    { status },
  );
}

/**
 * Candidate Review Portal handlers (SPEC #193 §8.5, B2).
 *
 * Every operator control calls only a B1 public interface
 * (`candidateReviewService` / `governanceService`); queue and Evidence reads
 * go through the Portal service. This module never imports a domain write
 * repository, a Registry publisher or a Claim writer, so the four-layer
 * privilege proof keeps holding at the route inventory layer.
 */
export function createCandidateReviewQueueHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  portalService: CandidateReviewPortalService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    const url = new URL(request.url);
    const rejected = rejectClientOwnerIdentifier(url);
    if (rejected) return rejected;
    try {
      const views = await dependencies.portalService.listPortalQueue({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
      });
      return Response.json({ outcome: "applied", views });
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewEvidenceHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  portalService: CandidateReviewPortalService;
}): (request: Request, candidateIdParam: string) => Promise<Response> {
  return async (request, candidateIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    const url = new URL(request.url);
    const rejected = rejectClientOwnerIdentifier(url);
    if (rejected) return rejected;
    let candidateId;
    try {
      candidateId = asMemoryCandidateId(candidateIdParam);
    } catch {
      return withOutcome("candidate_not_found", {}, 404);
    }
    try {
      const result = await dependencies.portalService.readCandidateEvidence({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        candidateId,
      });
      if (result.outcome === "candidate_not_found") {
        return withOutcome("candidate_not_found", {}, 404);
      }
      return Response.json({
        outcome: "applied",
        message: candidateReviewOutcomeCopy("applied"),
        excerpts: result.excerpts,
      });
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewMapHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  reviewService: CandidateReviewService;
}): (request: Request, candidateIdParam: string) => Promise<Response> {
  return async (request, candidateIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    let candidateId;
    try {
      candidateId = asMemoryCandidateId(candidateIdParam);
    } catch {
      return withOutcome("candidate_not_found", {}, 404);
    }
    let body: { predicateId?: unknown; typedValue?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withOutcome("invalid_reason_code", {}, 400);
    }
    if (typeof body.predicateId !== "string" || body.predicateId.length === 0) {
      return withOutcome("predicate_not_active", {}, 400);
    }
    try {
      const typedValue =
        body.typedValue === undefined
          ? undefined
          : (body.typedValue as string | readonly string[]);
      const result = await dependencies.reviewService.mapExisting({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        candidateId,
        predicateId: body.predicateId,
        ...(typedValue === undefined ? {} : { typedValue }),
      });
      const status =
        result.outcome === "applied"
          ? 200
          : result.outcome === "candidate_not_found"
            ? 404
            : result.outcome === "unauthorized" ||
                result.outcome === "step_up_required" ||
                result.outcome === "recent_step_up_required"
              ? 403
              : 200;
      return withOutcome(
        result.outcome,
        { candidateAfter: result.candidateAfter },
        status,
      );
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewRejectHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  reviewService: CandidateReviewService;
}): (request: Request, candidateIdParam: string) => Promise<Response> {
  return async (request, candidateIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    let candidateId;
    try {
      candidateId = asMemoryCandidateId(candidateIdParam);
    } catch {
      return withOutcome("candidate_not_found", {}, 404);
    }
    let body: {
      reasonCode?: unknown;
      proposal?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withOutcome("invalid_reason_code", {}, 400);
    }
    if (typeof body.reasonCode !== "string") {
      return withOutcome("invalid_reason_code", {}, 400);
    }
    try {
      const result = await dependencies.reviewService.reject({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        candidateId,
        reasonCode: body.reasonCode as
          | "insufficient_evidence"
          | "entity_scope_unresolved"
          | "sensitive_inference_violation"
          | "value_schema_mismatch"
          | "duplicate_concept"
          | "concept_no_product_value",
        ...(body.proposal === undefined
          ? {}
          : { proposal: body.proposal as never }),
      });
      const status =
        result.outcome === "applied"
          ? 200
          : result.outcome === "candidate_not_found"
            ? 404
            : 200;
      return withOutcome(
        result.outcome,
        { candidateAfter: result.candidateAfter },
        status,
      );
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewApproveHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  reviewService: CandidateReviewService;
}): (request: Request, candidateIdParam: string) => Promise<Response> {
  return async (request, candidateIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    let candidateId;
    try {
      candidateId = asMemoryCandidateId(candidateIdParam);
    } catch {
      return withOutcome("candidate_not_found", {}, 404);
    }
    let body: { mode?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withOutcome("invalid_reason_code", {}, 400);
    }
    if (
      typeof body.mode !== "object" ||
      body.mode === null ||
      !("action" in (body.mode as Record<string, unknown>))
    ) {
      return withOutcome("invalid_reason_code", {}, 400);
    }
    try {
      const result = await dependencies.reviewService.approveForRegistryChange({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        candidateId,
        mode: body.mode as never,
      });
      const status =
        result.outcome === "applied"
          ? 200
          : result.outcome === "candidate_not_found"
            ? 404
            : 200;
      return withOutcome(
        result.outcome,
        {
          candidateAfter: result.candidateAfter,
          proposalVersionId: result.proposalVersionId,
        },
        status,
      );
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewProposalHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  governanceService: PredicateGovernanceService;
}): (request: Request, proposalIdParam: string) => Promise<Response> {
  return async (request, proposalIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    const url = new URL(request.url);
    const rejected = rejectClientOwnerIdentifier(url);
    if (rejected) return rejected;
    let proposalId;
    try {
      proposalId = asPredicateChangeProposalId(proposalIdParam);
    } catch {
      return withOutcome("proposal_not_found", {}, 404);
    }
    try {
      const result = await dependencies.governanceService.describeProposal({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        proposalId,
      });
      if (result.outcome === "not_found") {
        return withOutcome("proposal_not_found", {}, 404);
      }
      return Response.json({
        outcome: "applied",
        message: candidateReviewOutcomeCopy("applied"),
        proposal: result.proposal,
        versions: result.versions,
      });
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewCancelHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  governanceService: PredicateGovernanceService;
}): (request: Request, proposalIdParam: string) => Promise<Response> {
  return async (request, proposalIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    let proposalId;
    try {
      proposalId = asPredicateChangeProposalId(proposalIdParam);
    } catch {
      return withOutcome("proposal_not_found", {}, 404);
    }
    try {
      const result = await dependencies.governanceService.cancel({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        proposalId,
      });
      return withOutcome(result.outcome, {
        staledCandidateCount: result.staledCandidateCount,
      });
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}

export function createCandidateReviewReconsiderHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  governanceService: PredicateGovernanceService;
}): (request: Request, proposalIdParam: string) => Promise<Response> {
  return async (request, proposalIdParam) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return withOutcome("unauthorized", {}, 401);
    }
    let proposalId;
    try {
      proposalId = asPredicateChangeProposalId(proposalIdParam);
    } catch {
      return withOutcome("proposal_not_found", {}, 404);
    }
    let body: { draft?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withOutcome("proposal_draft_rejected", {}, 400);
    }
    if (typeof body.draft !== "object" || body.draft === null) {
      return withOutcome("proposal_draft_rejected", {}, 400);
    }
    try {
      const result = await dependencies.governanceService.reconsider({
        userId: principal.userId,
        authSessionId: principal.authSessionId,
        proposalId,
        draft: body.draft as never,
      });
      return withOutcome(result.outcome, {
        versionAfter: result.versionAfter,
      });
    } catch (error) {
      if (error instanceof CandidateReviewAuthError) {
        return authErrorResponse(error);
      }
      throw error;
    }
  };
}
