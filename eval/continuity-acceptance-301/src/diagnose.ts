/**
 * Locating where a continuity answer went wrong (T07 #320).
 *
 * A failed or doubtful answer has one of five causes, and each is decided from
 * a different real boundary, never from the HTTP status or from the fact that
 * a source was "injected":
 *
 *  - `no_source`         the authoritative history never held the words;
 *  - `read_failed`       the controlled read itself failed (Inspector status);
 *  - `selection_omitted` the words exist and were readable but were not read
 *                        into the answer's Context, or never reached the
 *                        Provider (coverage + the actual request);
 *  - `time_lost`         the words reached the Provider without their time, or
 *                        with a different local date than they were said on
 *                        (the Times list of the actual request);
 *  - `generation_error`  the words and their time reached the model intact and
 *                        the answer is still wrong. This is only ever a
 *                        semantic verdict (a human or reviewed judgement); a
 *                        committed turn or an injected source never implies it.
 *
 * The verdict without a semantic review is `undetermined`, which is neither a
 * pass nor a fail. The trace names the Provider call (`providerResponseId`)
 * whose payload was inspected, so the conclusion can be re-checked on the very
 * request that left SayHear.
 */

export type DiagnosticFault =
  | "generation_error"
  | "no_source"
  | "none"
  | "read_failed"
  | "selection_omitted"
  | "time_lost"
  | "undetermined";

export type ReadState = "complete" | "empty" | "failed" | "partial" | "unread";

export type DiagnosticRequest = Readonly<{
  instructions: string;
  /** The messages exactly as sent, in order. */
  messages: readonly Readonly<{ role: string; text: string }>[];
  /** The id the Provider answered with; equals the Inspector's providerRequestId. */
  providerResponseId: string;
  sequence: number;
  toolsOffered: readonly string[];
}>;

export type DiagnosticRecall = Readonly<{
  answerCommandId: string;
  enumerationComplete: boolean | null;
  failureCode: string | null;
  omitted: Readonly<Record<string, number>>;
  role: string;
  searchOutcome: string | null;
  sourceRevisionIds: readonly string[];
  status: string;
}>;

export type DiagnosticTurnCommand = Readonly<{
  egressDisposition: string | null;
  errorCategory: string | null;
  providerRequestId: string | null;
  stage: string;
}>;

export type DiagnosticEvidence = Readonly<{
  /** Texts of the authoritative history (what a person could read back). */
  authoritativeTexts: readonly string[];
  /** Requests of the conversation turn, in order. */
  requests: readonly DiagnosticRequest[];
  recall: DiagnosticRecall | null;
  /** Semantic verdict for the answer; null when nobody has judged it. */
  semanticVerdict: "fail" | "pass" | null;
  /** Sources the answer needed. */
  sources: readonly Readonly<{
    /** Local date it must be shown with, `YYYY-MM-DD`. */
    expectedLocalDate: string | null;
    revisionId: string | null;
    source: string;
    text: string;
  }>[];
  turn: Readonly<{
    commands: readonly DiagnosticTurnCommand[];
    finalDisposition: string;
  }> | null;
}>;

export type SourceDiagnosis = Readonly<{
  evidence: readonly string[];
  fault: DiagnosticFault;
  /** Which Provider call the conclusion was drawn from, when one exists. */
  trace: Readonly<{
    commandStage: string | null;
    providerResponseId: string;
    requestSequence: number;
  }> | null;
  source: string;
}>;

export type StepDiagnosis = Readonly<{
  /** What the person-facing read said, as the actual payload tells it. */
  payloadReadStatus: string | null;
  readState: ReadState;
  sources: readonly SourceDiagnosis[];
  /** Plain statement of any disagreement between the Inspector and the payload. */
  disagreements: readonly string[];
}>;

/** `Times:` lines of a request's time_context: `1=2026-09-12 19:00:00 GMT+8;...`. */
export function parseTimesList(instructions: string): ReadonlyMap<number, string> {
  const times = new Map<number, string>();
  const start = instructions.indexOf("Times:");
  if (start < 0) return times;
  for (const line of instructions.slice(start).split("\n").slice(1)) {
    const match = /^(\d+)=(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/.exec(line.trim());
    if (!match) break;
    times.set(Number(match[1]), match[2]!);
  }
  return times;
}

/** `Read status: partial (code).` from the History Answer receipt, if present. */
export function parsePayloadReadStatus(instructions: string): string | null {
  const match = /Read status: ([a-z_]+)/.exec(instructions);
  return match ? match[1]! : null;
}

function readStateOf(recall: DiagnosticRecall | null): ReadState {
  if (recall === null) return "unread";
  if (recall.status === "failed") return "failed";
  if (recall.status === "partial") return "partial";
  const empty =
    recall.sourceRevisionIds.length === 0 && recall.enumerationComplete === true;
  return empty ? "empty" : "complete";
}

/** The request that answered the person: the last one with tools off, else the last. */
function answeringRequest(requests: readonly DiagnosticRequest[]): DiagnosticRequest | null {
  const answers = requests.filter((request) => request.toolsOffered.length === 0);
  return answers.at(-1) ?? requests.at(-1) ?? null;
}

export function diagnoseStep(evidence: DiagnosticEvidence): StepDiagnosis {
  const request = answeringRequest(evidence.requests);
  const times = request ? parseTimesList(request.instructions) : new Map<number, string>();
  const payloadReadStatus = request ? parsePayloadReadStatus(request.instructions) : null;
  const readState = readStateOf(evidence.recall);
  const disagreements: string[] = [];
  if (
    evidence.recall !== null &&
    payloadReadStatus !== null &&
    payloadReadStatus !== evidence.recall.status
  ) {
    disagreements.push(
      `Inspector says the read was ${evidence.recall.status}; the payload told the model ${payloadReadStatus}.`,
    );
  }
  if (evidence.recall !== null && request !== null && payloadReadStatus === null) {
    disagreements.push("The Inspector records a history read but the answering payload carries none.");
  }
  const answerStage =
    evidence.turn?.commands.find((command) => command.providerRequestId === request?.providerResponseId)
      ?.stage ?? null;
  const trace = request
    ? { commandStage: answerStage, providerResponseId: request.providerResponseId, requestSequence: request.sequence }
    : null;

  const sources = evidence.sources.map((wanted): SourceDiagnosis => {
    const notes: string[] = [];
    if (
      wanted.revisionId === null ||
      !evidence.authoritativeTexts.some((text) => text.includes(wanted.text))
    ) {
      notes.push("authoritative history: the words are not there");
      return { evidence: notes, fault: "no_source", source: wanted.source, trace: null };
    }
    notes.push("authoritative history: present");
    if (evidence.recall?.status === "failed" || evidence.recall?.searchOutcome === "channel_failed") {
      notes.push(
        `inspector.historyRecall: status=${evidence.recall.status} failureCode=${evidence.recall.failureCode ?? "none"} searchOutcome=${evidence.recall.searchOutcome ?? "none"}`,
      );
      return { evidence: notes, fault: "read_failed", source: wanted.source, trace };
    }
    const messageIndex = request
      ? request.messages.findIndex((message) => message.text.includes(wanted.text)) + 1
      : 0;
    const inContext = evidence.recall?.sourceRevisionIds.includes(wanted.revisionId) ?? false;
    notes.push(
      `inspector.sources: ${evidence.recall ? (inContext ? "present" : "absent") : "no history branch"}`,
      `provider payload: ${messageIndex > 0 ? `message ${messageIndex}` : "absent"}`,
    );
    if (messageIndex === 0) {
      const omitted = evidence.recall
        ? ` omitted=${JSON.stringify(evidence.recall.omitted)} enumerationComplete=${String(evidence.recall.enumerationComplete)}`
        : " (the Decision took no history branch)";
      notes.push(`coverage:${omitted}`);
      return { evidence: notes, fault: "selection_omitted", source: wanted.source, trace };
    }
    const shown = times.get(messageIndex) ?? null;
    notes.push(`time of message ${messageIndex}: ${shown ?? "missing"} (expected ${wanted.expectedLocalDate ?? "any"})`);
    if (shown === null || (wanted.expectedLocalDate !== null && shown !== wanted.expectedLocalDate)) {
      return { evidence: notes, fault: "time_lost", source: wanted.source, trace };
    }
    if (evidence.semanticVerdict === "fail") {
      notes.push("semantic review: the answer is wrong although the source and its time arrived intact");
      return { evidence: notes, fault: "generation_error", source: wanted.source, trace };
    }
    if (evidence.semanticVerdict === "pass") {
      return { evidence: notes, fault: "none", source: wanted.source, trace };
    }
    notes.push("semantic review: none yet; the source reached the model intact, its use is not judged");
    return { evidence: notes, fault: "undetermined", source: wanted.source, trace };
  });
  return { disagreements, payloadReadStatus, readState, sources };
}
