import {
  ContinuousExchangeNotFoundError,
  InvalidUserTextTurnError,
  type JournalEligibilityService,
  type OutboxDispatcherService,
  type UserId,
  type UserTextConversationService,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createContinuousExchangeEndHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: UserTextConversationService;
  /**
   * After a deterministic Continuous Exchange End, SayHear best-effort creates
   * the idempotent eligibility command and dispatches the outbox for low latency
   * (architecture 13.3 step 1). Convergence is still guaranteed by Cron + the
   * command's stable idempotency key if this best-effort attempt fails.
   */
  journalEligibilityService?: JournalEligibilityService;
  outboxDispatcherService?: OutboxDispatcherService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const end = await dependencies.service.endContinuousExchange(
        principal.userId,
        {
          dailySessionId:
            typeof body.dailySessionId === "string"
              ? body.dailySessionId
              : "",
        },
      );

      // Best-effort eligibility creation + dispatch. Explicitly swallowed: the
      // authoritative transaction (the end) already committed; a failure here
      // only adds latency until the next Cron sweep converges.
      if (dependencies.journalEligibilityService && dependencies.outboxDispatcherService) {
        try {
          await dependencies.journalEligibilityService.evaluate(end.dailySessionId);
          await dependencies.outboxDispatcherService.dispatchPending();
        } catch {
          // Best-effort: Cron reclaims and converges.
        }
      }

      return Response.json(end);
    } catch (error) {
      if (error instanceof InvalidUserTextTurnError) {
        return Response.json(
          { error: "invalid_continuous_exchange_end" },
          { status: 400 },
        );
      }
      if (error instanceof ContinuousExchangeNotFoundError) {
        return Response.json(
          { error: "continuous_exchange_not_found" },
          { status: 404 },
        );
      }
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
