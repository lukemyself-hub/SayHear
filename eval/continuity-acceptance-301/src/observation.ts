import type { RunMode } from "./fixture";

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
  failureCode: string | null;
  planDates: string | null;
  policyVersion: string;
  role: string;
  sourceCount: number;
  status: string;
}>;

export type ObservedInspection = Readonly<{
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
    sequence: number;
    strings: readonly string[];
  }>[];
  type: "say" | "resend" | "restart" | "correct";
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
