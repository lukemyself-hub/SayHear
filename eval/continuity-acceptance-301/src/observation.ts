import { createHash } from "node:crypto";

import type { RunMode } from "./fixture";
import { DETERMINISTIC_STUB_MODEL } from "./provider-stub";

/**
 * The machine-readable record of one case run (T00 #313): everything that was
 * observed at the real boundaries — the HTTP stream, the authoritative history
 * read, the controlled Inspector and the Provider request — and nothing that
 * was merely expected. `evaluateCase` scores it against the oracle; every
 * verdict in a report must be traceable to a field in this record.
 */

export const OBSERVATION_SCHEMA_VERSION = "continuity-acceptance-observation:v1";

export type ObservedMessage = Readonly<{
  actor: string;
  createdAt: string | null;
  id: string | null;
  sequence: number | null;
  text: string;
}>;

export type ObservedSession = Readonly<{
  dailySessionId: string;
  logicalDate: string | null;
  messages: readonly ObservedMessage[];
}>;

export type ObservedSeedTurn = Readonly<{
  assistantRevisionId: string | null;
  at: string;
  dailySessionId: string | null;
  key: string;
  terminalEvent: string | null;
  userEventId: string | null;
  userRevisionId: string | null;
}>;

export type ObservedReferencedEvent = Readonly<{
  actor: string;
  expressedAt: string | null;
  revisionId: string;
  section: string;
}>;

export type ObservedDateCoverage = Readonly<{
  candidateRows: number;
  empty: boolean;
  localDate: string;
  readBounded: boolean;
}>;

/** Content-free account of the controlled history review branch (issue #314). */
export type ObservedHistoryRecall = Readonly<{
  answerCommandId: string;
  decisionCommandId: string;
  /** Source enumeration reached the end of the requested range (date review). */
  enumerationComplete: boolean | null;
  failureCode: string | null;
  /** Why eligible rows were left out, by reason (content-free counts). */
  omitted: Readonly<Record<string, number>>;
  /** Outcome of an original-text search, when the branch was a search. */
  searchOutcome: string | null;
  sourceRevisionIds: readonly string[];
  planDates: string | null;
  policyVersion: string;
  role: string;
  sourceCount: number;
  status: string;
}>;

/** The whole Turn as the controlled Inspector records it (issue #320). */
export type ObservedTurn = Readonly<{
  assistantEventCommitted: boolean;
  commands: readonly Readonly<{
    egressDisposition: string | null;
    errorCategory: string | null;
    providerRequestId: string | null;
    stage: string;
  }>[];
  finalDisposition: string;
}>;

export type ObservedInspection = Readonly<{
  /** The id the Provider answered with; the join key to the actual request. */
  providerRequestId?: string | null;
  turn?: ObservedTurn | null;
  attemptStatus: string | null;
  /** Which branch the Decision took; null for an ordinary reply. */
  historyRecall?: ObservedHistoryRecall | null;
  generationStage?: string | null;
  commandStatus: string | null;
  compilerVersion: string | null;
  dailySessionId: string | null;
  dateCoverage: readonly ObservedDateCoverage[];
  inputTokens: number | null;
  outputTokens: number | null;
  providerLatencyMs: number | null;
  recentContextFailure: string | null;
  recentContextWindow: Readonly<{ end: string; start: string }> | null;
  referencedEvents: readonly ObservedReferencedEvent[];
}>;

export type ObservedStreamEvent = Readonly<{
  /** Failure category carried by a terminal failure event, when present. */
  category?: string | null;
  elapsedMs: number;
  /** Assistant delta text, when the event carried one. */
  delta: string | null;
  type: string;
}>;

export type ObservedStep = Readonly<{
  at: string;
  chat: Readonly<{
    /** Action kinds admitted on the stream for this turn, in order. */
    actions: readonly string[];
    assistantRevisionId: string | null;
    clientAborted: boolean;
    events: readonly ObservedStreamEvent[];
    generationCommandId: string | null;
    httpStatus: number;
    streamedText: string;
    terminalEvent: string | null;
    timing: Readonly<{
      acceptedMs: number | null;
      committedMs: number | null;
      firstVisibleTextMs: number | null;
      streamClosedMs: number;
    }>;
    userMessageId: string | null;
    userRevisionId: string | null;
  }> | null;
  id: string;
  input: Readonly<{
    clientEventId: string;
    clientTurnId: string;
    locale: string;
    text: string;
    timezone: string;
  }> | null;
  inspection: ObservedInspection | null;
  /** Why an expected observation is missing (HTTP error, Inspector 404, …). */
  problems: readonly string[];
  /** Every string the Provider received for this step, in arrival order. */
  providerRequests: readonly Readonly<{
    /**
     * True for the conversation generation of this very turn (its last input
     * message is the turn's own text). False for any other model role that
     * happened to call the Provider during the turn, e.g. `dialogue.state`.
     * Both are real egress and both are scanned for leaks and exclusions.
     */
    conversationTurn: boolean;
    /** The instructions and messages exactly as they left, for diagnosis. */
    instructions?: string;
    messages?: readonly Readonly<{ role: string; text: string }>[];
    /** What the stand-in Provider answered this request with. */
    providerResponseId?: string;
    sequence: number;
    strings: readonly string[];
    toolsOffered?: readonly string[];
  }>[];
  type: "say" | "resend" | "restart" | "correct" | "forget";
}>;

export type CaseObservation = Readonly<{
  /**
   * Every string sent to the Provider outside a follow-up turn: background
   * model roles started by scheduled scans. Real egress, scanned for leaks.
   */
  backgroundProviderStrings: readonly string[];
  caseId: string;
  /** Failures of the harness itself, never of the product under test. */
  environmentErrors: readonly string[];
  finalHistory: readonly ObservedSession[];
  identity: Readonly<{
    fixtureSha256: string;
    fixtureVersion: string;
    gitCommit: string;
    gitDirty: boolean;
    model: string;
    recentContextGovernance: string;
    runId: string;
  }>;
  /**
   * True for an interactive `chat` session, where a person or agent chose
   * which steps to play. Criteria about steps that were not played are then
   * `not-run` rather than a harness error.
   */
  interactive?: boolean;
  mode: RunMode;
  /**
   * Scheduled recovery scans the runner triggered to let idle time pass, with
   * the controlled instant each ran at and what the product reported.
   */
  scheduledScans: readonly Readonly<{
    at: string;
    result: Readonly<Record<string, unknown>>;
  }>[];
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  seed: Readonly<{
    /** Every string the Provider received while history was being loaded. */
    providerStrings: readonly string[];
    readback: readonly ObservedSession[];
    turns: readonly ObservedSeedTurn[];
  }>;
  steps: readonly ObservedStep[];
}>;

/**
 * Integrity of a stored run (review fix T). `report` re-scores an
 * `observation.json` that a run wrote earlier, and which criteria may be
 * scored depends on the mode recorded in it. The run therefore seals the
 * exact bytes it wrote (`observation.sha256`), and a stored observation is
 * re-scored only when the seal matches and its own facts agree with its mode:
 * the stand-in Provider's model can only belong to a deterministic run.
 *
 * The seal is a digest, not a signature: it catches a file edited after the
 * run and a hand-assembled directory, not someone who rewrites both files.
 */
export const OBSERVATION_SEAL_FILE = "observation.sha256";

export function sealObservation(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function observationIntegrityProblems(input: {
  seal: string | null;
  text: string;
}): string[] {
  const problems: string[] = [];
  if (input.seal === null) {
    problems.push(
      `the run directory has no ${OBSERVATION_SEAL_FILE}; only a run written by this tool can be re-scored`,
    );
  } else if (input.seal.trim() !== sealObservation(input.text)) {
    problems.push("observation.json changed after the run wrote it");
  }
  let parsed: {
    identity?: { model?: unknown };
    mode?: unknown;
    schemaVersion?: unknown;
  };
  try {
    parsed = JSON.parse(input.text) as typeof parsed;
  } catch {
    return [...problems, "observation.json is not readable JSON"];
  }
  if (parsed.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    problems.push(`observation.json is not ${OBSERVATION_SCHEMA_VERSION}`);
  }
  if (parsed.mode !== "deterministic" && parsed.mode !== "real-model") {
    problems.push("observation.json records no known run mode");
  }
  const standIn = parsed.identity?.model === DETERMINISTIC_STUB_MODEL;
  if (parsed.mode === "real-model" && standIn) {
    problems.push(
      "observation.json says real-model but its replies came from the stand-in Provider; it cannot be scored as a model run",
    );
  }
  if (parsed.mode === "deterministic" && !standIn && parsed.identity?.model !== "unknown") {
    problems.push(
      "observation.json says deterministic but does not name the stand-in Provider's model",
    );
  }
  return problems;
}
