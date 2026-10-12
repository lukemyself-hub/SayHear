import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packRoot, type RunMode } from "./fixture";

/**
 * Model-mode gate and shared cost ledger (T00 #313).
 *
 * Deterministic mode is the default and sends nothing to a paid Provider.
 * Real-model mode must be asked for twice — on the command line and in the
 * environment — and is then checked against the ledger: every precondition
 * verified, a recorded price, no call of unknown cost left unresolved, and
 * enough of the cap remaining to cover the run's upper bound. A blocked plan
 * stays blocked; it is never downgraded to the stub and reported as a result.
 */

export const LEDGER_SCHEMA_VERSION = "continuity-cost-ledger:v1";
export const REAL_MODEL_ENABLE_VARIABLE = "SAYHEAR_ACCEPTANCE_REAL_MODEL";

/**
 * Upper bounds used only for planning. They are deliberately generous and are
 * not a product budget: #307's online diagnosis recorded a single decision
 * that spent 11,919 output tokens, and no output cap is pinned on the
 * conversation path today. T08 freezes the real figures before a paid run.
 */
export const PLANNING_BOUNDS = Object.freeze({
  /** Dispatch attempts a single turn may make before it gives up. */
  attemptsPerStep: 2,
  /** Background model roles one scheduled scan may dispatch. */
  backgroundRequestsPerScan: 2,
  /** One extra round trip when a call-only answer needs a visible reply. */
  // PROTOTYPE ONLY: a structure-3 turn may add 3 lookup round trips; the
  // output bound scales with the widened request budget (30 s -> 12k tokens).
  continuationsPerAttempt: process.env["SAYHEAR_PROTOTYPE_STRUCTURE"] === "3" ? 4 : 1,
  inputTokensPerRequest: 16_000,
  outputTokensPerRequest:
    12_000 *
    Math.max(
      1,
      Math.ceil(Number(process.env["SAYHEAR_PROTOTYPE_REQUEST_BUDGET_MS"] ?? 30_000) / 30_000),
    ),
});

export type CostLedgerEntry = Readonly<{
  /** `null` keeps a call whose cost the Provider did not report. */
  costUsdMicros: number | null;
  date: string;
  inputTokens: number | null;
  note: string;
  outputTokens: number | null;
  requests: number;
  runId: string;
  ticket: string;
}>;

export type CostLedger = Readonly<{
  capUsdMicros: number;
  /**
   * Spending at which paid runs stop for a report to the owner before going
   * on, even though the cap is not reached. Absent: only the cap applies.
   */
  pauseAtSpentUsdMicros?: number;
  entries: readonly CostLedgerEntry[];
  model: Readonly<{
    inputUsdMicrosPerMillionTokens: number | null;
    model: string;
    outputUsdMicrosPerMillionTokens: number | null;
    provider: string;
  }>;
  preconditions: readonly Readonly<{
    /**
     * Required for `owner-waived`: who decided the run may start without the
     * condition being met, when, and in what words. A waiver is not evidence
     * that the condition holds and is never reported as `verified`.
     */
    decision?: Readonly<{ by: string; date: string; statement: string }>;
    description: string;
    evidence: string | null;
    id: string;
    status: "verified" | "unverified" | "owner-waived";
  }>[];
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
}>;

export const ledgerPath = path.join(packRoot, "cost-ledger.json");

export function loadLedger(file: string = ledgerPath): CostLedger {
  const ledger = JSON.parse(readFileSync(file, "utf8")) as CostLedger;
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Cost ledger schemaVersion must be ${LEDGER_SCHEMA_VERSION}.`);
  }
  return ledger;
}

export function remainingBudget(ledger: CostLedger): {
  remainingUsdMicros: number;
  unknownCostEntries: number;
} {
  let spent = 0;
  let unknownCostEntries = 0;
  for (const entry of ledger.entries) {
    if (entry.costUsdMicros === null) unknownCostEntries += 1;
    else spent += entry.costUsdMicros;
  }
  return { remainingUsdMicros: ledger.capUsdMicros - spent, unknownCostEntries };
}

/** Token usage of the live requests of one run (see `ProviderGate.usage`). */
export type RunUsage = Readonly<{
  inputTokens: number;
  liveRequests: number;
  outputTokens: number;
  requestsWithUnknownUsage: number;
}>;

function priced(ledger: CostLedger, inputTokens: number, outputTokens: number): number {
  const { inputUsdMicrosPerMillionTokens: input, outputUsdMicrosPerMillionTokens: output } =
    ledger.model;
  if (input === null || output === null) {
    throw new Error("The cost ledger records no price; a paid run cannot be entered.");
  }
  return Math.ceil((inputTokens * input + outputTokens * output) / 1_000_000);
}

/**
 * The ledger entry of one finished real-model run (T08 #321). Reported tokens
 * are priced at the ledger's conservative rate. A live request that never
 * reported usage (it failed or was cut off) is still charged, at the
 * per-request planning bound, so the remaining budget is never overstated.
 */
export function ledgerEntryForRun(input: {
  date: string;
  ledger: CostLedger;
  note: string;
  runId: string;
  ticket: string;
  usage: RunUsage;
}): CostLedgerEntry {
  const unknown = input.usage.requestsWithUnknownUsage;
  return {
    costUsdMicros:
      priced(input.ledger, input.usage.inputTokens, input.usage.outputTokens) +
      unknown *
        priced(
          input.ledger,
          PLANNING_BOUNDS.inputTokensPerRequest,
          PLANNING_BOUNDS.outputTokensPerRequest,
        ),
    date: input.date,
    inputTokens: input.usage.inputTokens,
    note:
      unknown === 0
        ? input.note
        : `${input.note} — ${unknown} request${unknown === 1 ? "" : "s"} with unknown usage charged at the planning bound`,
    outputTokens: input.usage.outputTokens,
    requests: input.usage.liveRequests,
    runId: input.runId,
    ticket: input.ticket,
  };
}

/** Append one entry to the ledger file, keeping everything else as written. */
export function appendLedgerEntry(entry: CostLedgerEntry, file: string = ledgerPath): void {
  const ledger = JSON.parse(readFileSync(file, "utf8")) as { entries: CostLedgerEntry[] };
  ledger.entries.push(entry);
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}
`);
}

export type RunShape = Readonly<{
  /** Follow-up turns that would be answered by the real model. */
  generationSteps: number;
  /**
   * Idle gaps long enough to trigger the scheduled scan. Each one may start
   * background model roles (for example `dialogue.state`) that also call the
   * Provider, so they are counted against the budget.
   */
  scheduledScans: number;
  /** History turns; always replayed through the stub, never paid. */
  seedTurns: number;
}>;

export type RunPlan = Readonly<{
  blockers: readonly string[];
  capUsdMicros: number;
  /** `null` when no price is recorded: unknown, not free. */
  estimatedCostUsdMicros: number | null;
  inputTokenUpperBound: number;
  mode: RunMode;
  model: string;
  outputTokenUpperBound: number;
  paidRequestUpperBound: number;
  remainingUsdMicros: number;
  requestsPerStepUpperBound: number;
  shape: RunShape;
  status: "ready" | "blocked";
  unknownCostEntries: number;
  /** Preconditions the owner waived by a recorded decision (not verified). */
  waivedPreconditions: readonly Readonly<{
    by: string;
    date: string;
    id: string;
    statement: string;
  }>[];
}>;

export function planRun(input: {
  environment: Readonly<Record<string, string | undefined>>;
  ledger: CostLedger;
  requestedMode: string | undefined;
  shape: RunShape;
}): RunPlan {
  const requested = input.requestedMode ?? "deterministic";
  if (requested !== "deterministic" && requested !== "real-model") {
    throw new Error(`Unknown mode ${JSON.stringify(requested)}; use deterministic or real-model.`);
  }
  const mode: RunMode = requested;
  const { remainingUsdMicros, unknownCostEntries } = remainingBudget(input.ledger);
  const waivedPreconditions = input.ledger.preconditions.flatMap((precondition) =>
    precondition.status === "owner-waived" && precondition.decision
      ? [{ ...precondition.decision, id: precondition.id }]
      : [],
  );
  const requestsPerStepUpperBound =
    PLANNING_BOUNDS.attemptsPerStep * (1 + PLANNING_BOUNDS.continuationsPerAttempt);

  if (mode === "deterministic") {
    return {
      blockers: [],
      capUsdMicros: input.ledger.capUsdMicros,
      estimatedCostUsdMicros: 0,
      inputTokenUpperBound: 0,
      mode,
      model: "acceptance-deterministic-stub",
      outputTokenUpperBound: 0,
      paidRequestUpperBound: 0,
      remainingUsdMicros,
      requestsPerStepUpperBound,
      shape: input.shape,
      status: "ready",
      unknownCostEntries,
      waivedPreconditions,
    };
  }

  const paidRequestUpperBound =
    input.shape.generationSteps * requestsPerStepUpperBound +
    input.shape.scheduledScans * PLANNING_BOUNDS.backgroundRequestsPerScan;
  const inputTokenUpperBound = paidRequestUpperBound * PLANNING_BOUNDS.inputTokensPerRequest;
  const outputTokenUpperBound = paidRequestUpperBound * PLANNING_BOUNDS.outputTokensPerRequest;
  const { inputUsdMicrosPerMillionTokens: inputPrice, outputUsdMicrosPerMillionTokens: outputPrice } =
    input.ledger.model;
  const estimatedCostUsdMicros =
    inputPrice === null || outputPrice === null
      ? null
      : Math.ceil(
          (inputTokenUpperBound * inputPrice + outputTokenUpperBound * outputPrice) / 1_000_000,
        );

  const blockers: string[] = [];
  if (input.environment[REAL_MODEL_ENABLE_VARIABLE] !== "enabled") {
    blockers.push(
      `Real-model mode must be explicitly enabled with ${REAL_MODEL_ENABLE_VARIABLE}=enabled in addition to --mode real-model.`,
    );
  }
  for (const precondition of input.ledger.preconditions) {
    if (precondition.status === "owner-waived") {
      const decision = precondition.decision;
      if (!decision?.by?.trim() || !decision.date?.trim() || !decision.statement?.trim()) {
        blockers.push(
          `Precondition ${precondition.id} is marked owner-waived without a recorded decision (by, date, statement).`,
        );
      }
    } else if (precondition.status !== "verified") {
      blockers.push(
        `Precondition ${precondition.id} is not verified: ${precondition.description}`,
      );
    }
  }
  if (estimatedCostUsdMicros === null) {
    blockers.push(
      "No price is recorded for the model in the cost ledger, so the run's cost cannot be bounded.",
    );
  }
  if (unknownCostEntries > 0) {
    blockers.push(
      `${unknownCostEntries} ledger entr${unknownCostEntries === 1 ? "y has" : "ies have"} unknown cost; the remaining budget cannot be stated until a cost is assigned to each.`,
    );
  }
  const spentUsdMicros = input.ledger.capUsdMicros - remainingUsdMicros;
  if (
    input.ledger.pauseAtSpentUsdMicros !== undefined &&
    spentUsdMicros >= input.ledger.pauseAtSpentUsdMicros
  ) {
    blockers.push(
      `Spending (${spentUsdMicros} USD micros) has reached the recorded pause point (${input.ledger.pauseAtSpentUsdMicros}); report to the owner before any further paid run.`,
    );
  }
  if (estimatedCostUsdMicros !== null && estimatedCostUsdMicros > remainingUsdMicros) {
    blockers.push(
      `The run's upper-bound cost (${estimatedCostUsdMicros} USD micros) exceeds the remaining budget (${remainingUsdMicros} USD micros).`,
    );
  }

  return {
    blockers,
    capUsdMicros: input.ledger.capUsdMicros,
    estimatedCostUsdMicros,
    inputTokenUpperBound,
    mode,
    model: `${input.ledger.model.provider}/${input.ledger.model.model}`,
    outputTokenUpperBound,
    paidRequestUpperBound,
    remainingUsdMicros,
    requestsPerStepUpperBound,
    shape: input.shape,
    status: blockers.length === 0 ? "ready" : "blocked",
    unknownCostEntries,
    waivedPreconditions,
  };
}
