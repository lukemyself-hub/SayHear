import {
  asInactivityEvaluationId,
  type InactivityEvaluationId,
} from "@sayhear/domain";

export type InactivityEvaluationOutcome =
  | "applied"
  | "stale_revision"
  | "not_active";

export type ContinuousExchangeRepository = Readonly<{
  evaluateInactivity(input: {
    evaluatedAt: Date;
    inactivityEvaluationId: InactivityEvaluationId;
  }): Promise<
    | Readonly<{
        outcome: InactivityEvaluationOutcome;
        replayed: boolean;
      }>
    | Readonly<{ outcome: "not_due" | "not_found" }>
  >;
  listDueInactivityEvaluationIds(input: {
    dueAt: Date;
    limit: number;
  }): Promise<readonly InactivityEvaluationId[]>;
}>;

export type ContinuousExchangeService = Readonly<{
  evaluateInactivity(
    inactivityEvaluationId: string,
  ): Promise<
    | Readonly<{
        outcome: InactivityEvaluationOutcome;
        replayed: boolean;
      }>
    | Readonly<{ outcome: "not_due" | "not_found" }>
  >;
  scanDueInactivity(): Promise<
    Readonly<{
      applied: number;
      processed: number;
      stale: number;
    }>
  >;
}>;

export function createContinuousExchangeService(dependencies: {
  clock: () => Date;
  repository: ContinuousExchangeRepository;
  scanLimit?: number;
}): ContinuousExchangeService {
  const scanLimit = dependencies.scanLimit ?? 100;
  if (!Number.isInteger(scanLimit) || scanLimit <= 0 || scanLimit > 1_000) {
    throw new Error("scanLimit must be an integer from 1 through 1000.");
  }

  async function evaluateInactivity(
    inactivityEvaluationId: string,
  ): ReturnType<ContinuousExchangeService["evaluateInactivity"]> {
    let id: InactivityEvaluationId;
    try {
      id = asInactivityEvaluationId(inactivityEvaluationId);
    } catch {
      return { outcome: "not_found" };
    }
    return dependencies.repository.evaluateInactivity({
      evaluatedAt: dependencies.clock(),
      inactivityEvaluationId: id,
    });
  }

  return {
    evaluateInactivity,
    async scanDueInactivity() {
      const dueAt = dependencies.clock();
      const ids =
        await dependencies.repository.listDueInactivityEvaluationIds({
          dueAt,
          limit: scanLimit,
        });
      let applied = 0;
      let processed = 0;
      let stale = 0;
      for (const id of ids) {
        const result = await evaluateInactivity(id);
        if (
          result.outcome === "not_due" ||
          result.outcome === "not_found"
        ) {
          continue;
        }
        if ("replayed" in result && result.replayed) {
          continue;
        }
        processed += 1;
        if (result.outcome === "applied") {
          applied += 1;
        } else {
          stale += 1;
        }
      }
      return { applied, processed, stale };
    },
  };
}
