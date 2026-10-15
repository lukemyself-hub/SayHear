import { packRoot } from "./fixture";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ORACLE_LEAK_MIN_LENGTH,
  oracleStrings,
  scriptedDecisionHindsight,
  sourceText,
  type LoadedCase,
  type ObjectiveCriterion,
  type ReviewedCriterion,
} from "./fixture";
import type {
  CaseObservation,
  ObservedMessage,
  ObservedSession,
  ObservedStep,
} from "./observation";

/**
 * Scores one observed run against its independent oracle (T00 #313).
 *
 * Objective criteria are decided here from what was observed at the real
 * boundaries. Free text is never decided here by string matching: semantic and
 * subjective criteria need findings from an independent reviewer, and this
 * module only checks that those findings are complete, cite text that really
 * is in the transcript, and do not come from the model under test.
 *
 * Five outcomes are kept apart on purpose. `fail` means the product did the
 * wrong thing on the real path. `not-run` means the criterion was not
 * exercised. `environment-error` means the harness broke. `needs-review` means
 * evidence is missing or disputed. Only `pass` on every criterion is a pass.
 */

export type CriterionStatus =
  | "pass"
  | "fail"
  | "not-run"
  | "environment-error"
  | "needs-review"
  /**
   * An owner ruling took the criterion out of acceptance (`owner-rulings.json`).
   * The criterion and what was observed stay on the record; the verdict of the
   * case is decided by the others.
   */
  | "not-counted";

export const REVIEW_SCHEMA_VERSION = "continuity-acceptance-review:v1";
export const RUBRIC_VERSION = "continuity-rubric:v1";

export type ReviewFinding = Readonly<{
  criterionId: string;
  itemId: string;
  /** Verbatim span of the assistant reply that supports or refutes the item. */
  quote?: string;
  reason: string;
  verdict: "pass" | "fail" | "needs-review";
}>;

export type ReviewFile = Readonly<{
  caseId: string;
  findings: readonly ReviewFinding[];
  /** `human:<name>`, `agent:<name>` or `model:<model id>`. */
  reviewer: string;
  rubricVersion: string;
  runId: string;
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
}>;

export type CriterionResult = Readonly<{
  description: string;
  /** Pointers into the observation, or quoted spans, backing the verdict. */
  evidence: readonly string[];
  id: string;
  kind: "invariant" | "objective" | "semantic" | "subjective";
  owner: string | null;
  reason: string;
  /**
   * `pipeline-only`: judged on a step whose scripted Decision used a clue
   * that needs hindsight. The verdict holds for the pipeline and source
   * control given that Decision; it says nothing about whether a model would
   * have chosen it. Absent otherwise.
   */
  scope?: "pipeline-only";
  status: CriterionStatus;
}>;

export type CaseReport = Readonly<{
  caseId: string;
  criteria: readonly CriterionResult[];
  /** Ids of the criteria whose verdict is `pipeline-only`. */
  pipelineOnly: readonly string[];
  mode: CaseObservation["mode"];
  reviewer: string | null;
  runId: string;
  status: CriterionStatus;
}>;

/** Worst outcome wins; an empty run proves nothing and is `not-run`. */
export function aggregateStatus(
  statuses: readonly CriterionStatus[],
): CriterionStatus {
  const counted = statuses.filter((status) => status !== "not-counted");
  if (counted.length === 0) return "not-run";
  for (const status of [
    "environment-error",
    "fail",
    "needs-review",
    "not-run",
  ] as const) {
    if (counted.includes(status)) return status;
  }
  return "pass";
}

export type OwnerRulings = Readonly<{
  interpretations: readonly Readonly<{ caseId: string; criterionId: string; reading: string; ruling: string }>[];
  notCounted: readonly Readonly<{ caseId: string; criterionId: string; reason: string; ruling: string }>[];
  rulings: readonly Readonly<{ by: string; date: string; id: string; statement: string }>[];
}>;

let cachedOwnerRulings: OwnerRulings | null = null;

/** The product owner's rulings on how criteria are counted and read. */
export function loadOwnerRulings(): OwnerRulings {
  cachedOwnerRulings ??= JSON.parse(
    readFileSync(path.join(packRoot, "owner-rulings.json"), "utf8"),
  ) as OwnerRulings;
  return cachedOwnerRulings;
}

/**
 * Applies the owner's rulings to one scored criterion. A criterion ruled out
 * of acceptance becomes `not-counted` and keeps what was observed as evidence;
 * a ruling on how to read a criterion is attached for whoever reviews the
 * answer. The oracle files themselves are never edited for a ruling, so the
 * frozen holdout pack keeps its recorded hashes.
 */
export function applyOwnerRulings(
  caseId: string,
  result: CriterionResult,
): CriterionResult {
  const rulings = loadOwnerRulings();
  const cite = (id: string) => {
    const ruling = rulings.rulings.find((candidate) => candidate.id === id);
    return ruling ? `${ruling.id}, ${ruling.by} ${ruling.date}` : id;
  };
  const excluded = rulings.notCounted.find(
    (entry) => entry.caseId === caseId && entry.criterionId === result.id,
  );
  if (excluded) {
    return {
      ...result,
      evidence: [...result.evidence, `observed: ${result.status} — ${result.reason}`],
      reason: `Not counted by owner ruling (${cite(excluded.ruling)}): ${excluded.reason}`,
      status: "not-counted",
    };
  }
  const readings = rulings.interpretations.filter(
    (entry) => entry.caseId === caseId && entry.criterionId === result.id,
  );
  return readings.length === 0
    ? result
    : {
        ...result,
        evidence: [
          ...result.evidence,
          ...readings.map((entry) => `owner ruling (${cite(entry.ruling)}): ${entry.reading}`),
        ],
      };
}

/**
 * 0 complete pass · 1 product failure · 2 incomplete (not run or awaiting
 * review) · 3 harness/environment failure.
 */
export function exitCodeForStatus(status: CriterionStatus): number {
  if (status === "pass") return 0;
  if (status === "fail") return 1;
  if (status === "environment-error") return 3;
  return 2;
}

type Verdict = Readonly<{
  evidence: string[];
  reason: string;
  status: CriterionStatus;
}>;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Letters and digits only, case-folded: punctuation and spacing do not hide a leak. */
function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const FRAGMENT_LENGTH = 16;
/** Han / kana / hangul carry far more per character, so a shorter run is already distinctive. */
const DENSE_FRAGMENT_LENGTH = 8;
const DENSE_FRAGMENT_MIN_NON_ASCII = 6;

function fragmentsOf(compacted: string): Set<string> {
  const fragments = new Set<string>();
  for (let start = 0; start + DENSE_FRAGMENT_LENGTH <= compacted.length; start += 1) {
    const dense = compacted.slice(start, start + DENSE_FRAGMENT_LENGTH);
    // eslint-disable-next-line no-control-regex
    if (dense.replace(/[\u0000-\u007f]/g, "").length >= DENSE_FRAGMENT_MIN_NON_ASCII) {
      fragments.add(dense);
    }
    if (start + FRAGMENT_LENGTH <= compacted.length) {
      fragments.add(compacted.slice(start, start + FRAGMENT_LENGTH));
    }
  }
  return fragments;
}

/**
 * The fragments of an excluded source that only it contains: long runs of its
 * letters that appear in no message the case permits to be sent (other seeded
 * messages that are not forbidden, and everything said or corrected during
 * the run). A corrected message shares most of its words with the wording it
 * replaced; only the part that differs can show that the old wording leaked.
 */
function distinctiveFragments(
  loaded: LoadedCase,
  source: string,
  excluded: readonly string[],
): Set<string> {
  const forbidden = new Set([
    ...excluded,
    ...loaded.oracle.sourceEligibility
      .filter((entry) => entry.eligibility === "forbidden")
      .map((entry) => entry.source),
  ]);
  const permitted = [
    ...loaded.fixture.history.flatMap((turn) => [
      ...(forbidden.has(`${turn.key}:user`) ? [] : [turn.user]),
      ...(forbidden.has(`${turn.key}:assistant`) ? [] : [turn.assistant]),
    ]),
    ...loaded.fixture.steps.flatMap((step) =>
      step.type === "say" || step.type === "correct" ? [step.text] : [],
    ),
  ].map(compact);
  const fragments = fragmentsOf(compact(sourceText(loaded.fixture, source) ?? ""));
  for (const fragment of [...fragments]) {
    if (permitted.some((text) => text.includes(fragment))) fragments.delete(fragment);
  }
  return fragments;
}

function allMessages(sessions: readonly ObservedSession[]): Array<
  ObservedMessage & { dailySessionId: string; index: number }
> {
  return sessions.flatMap((session) =>
    session.messages.map((message, index) => ({
      ...message,
      dailySessionId: session.dailySessionId,
      index,
    })),
  );
}

/** The message that directly follows `messageId` in its own session. */
function following(
  sessions: readonly ObservedSession[],
  messageId: string,
): ObservedMessage | null | undefined {
  for (const session of sessions) {
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index !== -1) return session.messages[index + 1] ?? null;
  }
  return undefined;
}

/**
 * In a real-model run, whether this step's own reply came from the real
 * Provider. A reply answered locally (a rehearsal, an injected fault) is not a
 * model answer and its timing is not a model latency sample (T08 #321).
 */
function answeredByRealProvider(step: ObservedStep): boolean {
  const own = step.providerRequests.filter((request) => request.conversationTurn);
  return own.length > 0 && own.every((request) => request.transport === "live");
}

const NOT_FROM_REAL_PROVIDER: Verdict = {
  evidence: [],
  reason:
    "This step's reply was not produced by the real Provider (it was answered locally), so it is neither a model answer nor a model latency sample.",
  status: "not-run",
};

function findStep(observation: CaseObservation, id: string): ObservedStep | null {
  return observation.steps.find((step) => step.id === id) ?? null;
}

function missingStep(id: string, observation: CaseObservation): Verdict {
  if (observation.interactive) {
    return {
      evidence: [],
      reason: `Step ${id} was not played in this interactive session.`,
      status: "not-run",
    };
  }
  return {
    evidence: [],
    reason: `Step ${id} was never observed, so the harness cannot judge it.`,
    status: "environment-error",
  };
}

function evaluateObjective(
  criterion: ObjectiveCriterion,
  loaded: LoadedCase,
  observation: CaseObservation,
): Verdict {
  const check = criterion.check;
  if (check.type === "session_ownership") {
    const evidence: string[] = [];
    let failed = false;
    for (const expected of check.expect) {
      const key = expected.source.split(":")[0];
      const turn = observation.seed.turns.find((candidate) => candidate.key === key);
      const session = observation.seed.readback.find(
        (candidate) => candidate.dailySessionId === turn?.dailySessionId,
      );
      const actual = session?.logicalDate ?? null;
      evidence.push(`seed.turns[${key}] -> session ${turn?.dailySessionId ?? "?"} logicalDate ${actual ?? "?"} (expected ${expected.logicalDate})`);
      if (actual !== expected.logicalDate) failed = true;
    }
    return failed
      ? { evidence, reason: "A message is owned by a different Daily Session date than expected.", status: "fail" }
      : { evidence, reason: "Every message is owned by the expected Daily Session date.", status: "pass" };
  }

  if (check.type === "unsupported") {
    return {
      evidence: [],
      reason: `Not exercised: the runner cannot yet ${check.capability}. This is a missing harness capability, not a product verdict.`,
      status: "not-run",
    };
  }

  const step = findStep(observation, check.step);
  if (!step) return missingStep(check.step, observation);
  const chat = step.chat;
  const pointer = `steps[${step.id}]`;

  switch (check.type) {
    case "outbound_includes_input": {
      const strings = step.providerRequests
        .filter((request) => request.conversationTurn)
        .flatMap((request) => request.strings);
      const evidence: string[] = [];
      let all = true;
      for (const id of check.inputs) {
        const said = findStep(observation, id)?.input?.text ?? null;
        const present = said !== null && strings.some((value) => value.includes(said));
        evidence.push(`steps[${id}].input.text: providerRequest=${present ? "present" : "absent"}`);
        if (!present) all = false;
      }
      return all
        ? { evidence, reason: "Everything said earlier in the run reached the Provider for this turn.", status: "pass" }
        : { evidence, reason: "Something said earlier in the run did not reach the Provider for this turn.", status: "fail" };
    }
    case "action_admitted": {
      const actions = chat?.actions ?? [];
      const evidence = [`${pointer}.chat.actions=${JSON.stringify(actions)}`];
      return actions.includes(check.actionKind)
        ? { evidence, reason: `The ${check.actionKind} Action was admitted for this turn.`, status: "pass" }
        : { evidence, reason: `No ${check.actionKind} Action was admitted for this turn.`, status: "fail" };
    }
    case "no_action": {
      const actions = chat?.actions ?? [];
      const evidence = [`${pointer}.chat.actions=${JSON.stringify(actions)}`];
      return actions.length === 0
        ? { evidence, reason: "No Action was admitted for this turn.", status: "pass" }
        : { evidence, reason: "An Action was admitted for a turn that asked for none.", status: "fail" };
    }
    case "turn_committed": {
      const evidence = [
        `${pointer}.chat.httpStatus=${chat?.httpStatus ?? "none"}`,
        `${pointer}.chat.terminalEvent=${chat?.terminalEvent ?? "none"}`,
        ...step.problems.map((problem) => `${pointer}.problems: ${problem}`),
      ];
      return chat?.httpStatus === 200 &&
        chat.terminalEvent === "assistant_committed" &&
        chat.streamedText.trim().length > 0
        ? { evidence, reason: "The turn streamed text and committed.", status: "pass" }
        : { evidence, reason: "The turn did not end in a committed assistant reply.", status: "fail" };
    }
    case "history_matches_stream": {
      if (!chat?.userMessageId) {
        return { evidence: [`${pointer}.chat.userMessageId is missing`], reason: "The user message was never committed.", status: "fail" };
      }
      const copies = allMessages(observation.finalHistory).filter(
        (message) => message.id === chat.userMessageId,
      );
      const next = following(observation.finalHistory, chat.userMessageId);
      const evidence = [
        `finalHistory has ${copies.length} message(s) with id ${chat.userMessageId}`,
        `next message: ${next ? `${next.actor} ${JSON.stringify(next.text.slice(0, 60))}` : "none"}`,
      ];
      return copies.length === 1 &&
        next?.actor === "assistant" &&
        next.text === chat.streamedText
        ? { evidence, reason: "Authoritative history holds the user message once, followed by exactly the streamed reply.", status: "pass" }
        : { evidence, reason: "Authoritative history does not match what was streamed.", status: "fail" };
    }
    case "outbound_includes":
    case "outbound_excludes": {
      // A required source must be in the request that generates this turn's
      // answer. An excluded source must be in no request at all, including
      // any background model role that ran during the turn.
      const strings = step.providerRequests
        .filter((request) => check.type === "outbound_excludes" || request.conversationTurn)
        .flatMap((request) => request.strings);
      const references = new Set(
        (step.inspection?.referencedEvents ?? []).map((event) => event.revisionId),
      );
      const evidence: string[] = [];
      let allPresent = true;
      let anyPresent = false;
      // An excluded source must not arrive in part either: cut short,
      // re-punctuated or embedded in other text is still a leak.
      const compactedStrings =
        check.type === "outbound_excludes" ? strings.map(compact) : [];
      for (const source of check.sources) {
        const [key, actor] = source.split(":");
        const text = sourceText(loaded.fixture, source) ?? "";
        const turn = observation.seed.turns.find((candidate) => candidate.key === key);
        const revisionId = actor === "user" ? turn?.userRevisionId : turn?.assistantRevisionId;
        const whole = strings.some((value) => value.includes(text));
        const fragment =
          check.type === "outbound_excludes" && !whole
            ? [...distinctiveFragments(loaded, source, check.sources)].find((candidate) =>
                compactedStrings.some((value) => value.includes(candidate)),
              )
            : undefined;
        const inRequest = whole || fragment !== undefined;
        const inInspector = revisionId ? references.has(revisionId) : false;
        evidence.push(
          `${source}: providerRequest=${inRequest ? "present" : "absent"}${fragment === undefined ? "" : ` (a distinctive fragment of it, ${fragment.length} letters after removing spacing and punctuation)`}, inspector.referencedEvents=${inInspector ? "present" : "absent"}`,
        );
        if (!(inRequest && inInspector)) allPresent = false;
        if (inRequest || inInspector) anyPresent = true;
      }
      if (step.providerRequests.length === 0) {
        evidence.push(`${pointer}.providerRequests is empty`);
      }
      if (check.type === "outbound_includes") {
        return allPresent
          ? { evidence, reason: "Every required source reached the Provider and is recorded by the Inspector.", status: "pass" }
          : { evidence, reason: "A required source did not reach the Provider request for this turn.", status: "fail" };
      }
      if (step.providerRequests.length === 0) {
        return { evidence, reason: "No Provider request was observed, so exclusion cannot be shown.", status: "fail" };
      }
      return anyPresent
        ? { evidence, reason: "An excluded source reached the Provider or the compiled Context.", status: "fail" }
        : { evidence, reason: "No excluded source reached the Provider or the compiled Context.", status: "pass" };
    }
    case "no_commit_after_abort": {
      if (!chat?.clientAborted) {
        return {
          evidence: [`${pointer}.chat.clientAborted=${chat?.clientAborted ?? "none"}`],
          reason: "The client never aborted mid-stream, so cancellation was not exercised.",
          status: "environment-error",
        };
      }
      if (!chat.userMessageId) {
        return { evidence: [`${pointer}.chat.userMessageId is missing`], reason: "The aborted turn's user message was not observed.", status: "environment-error" };
      }
      const next = following(observation.finalHistory, chat.userMessageId);
      const evidence = [
        `after abort, message following ${chat.userMessageId}: ${next ? `${next.actor} ${JSON.stringify(next.text.slice(0, 60))}` : "none"}`,
      ];
      return next?.actor === "assistant"
        ? { evidence, reason: "An assistant reply was committed after the client cancelled.", status: "fail" }
        : { evidence, reason: "No assistant reply was committed for the cancelled turn.", status: "pass" };
    }
    case "replaced_reply_never_shown": {
      const types = (chat?.events ?? []).map((event) => event.type);
      const shown = types.includes("assistant_delta") || types.includes("assistant_committed");
      const next = chat?.userMessageId
        ? following(observation.finalHistory, chat.userMessageId)
        : undefined;
      const evidence = [
        `${pointer}.chat.events types=${JSON.stringify([...new Set(types)])}`,
        `message following ${chat?.userMessageId ?? "?"}: ${next ? next.actor : next === null ? "none" : "unknown"}`,
      ];
      if (!chat?.userMessageId || next === undefined) {
        return { evidence, reason: "The replaced turn's user message was not observed.", status: "environment-error" };
      }
      return shown || next?.actor === "assistant"
        ? { evidence, reason: "A reply that a newer message had retired was shown or stored.", status: "fail" }
        : { evidence, reason: "The retired reply was neither shown nor stored.", status: "pass" };
    }
    case "stopped_at_deadline": {
      const last = chat?.events.at(-1);
      const next = chat?.userMessageId
        ? following(observation.finalHistory, chat.userMessageId)
        : undefined;
      const closedMs = chat?.timing.streamClosedMs ?? null;
      const evidence = [
        `${pointer}.chat last event=${last?.type ?? "none"} category=${last?.category ?? "none"}`,
        `${pointer}.chat.timing.streamClosedMs=${closedMs} (CLI network, limit ${check.maxMs})`,
        `${pointer}.inspection.commandStatus=${step.inspection?.commandStatus ?? "null"} attemptStatus=${step.inspection?.attemptStatus ?? "null"}`,
        `message following ${chat?.userMessageId ?? "?"}: ${next ? next.actor : next === null ? "none" : "unknown"}`,
      ];
      const stopped =
        last?.type === "response_failed" &&
        last.category === "timeout" &&
        closedMs !== null &&
        closedMs <= check.maxMs;
      const settled =
        step.inspection !== null &&
        step.inspection.commandStatus !== "running" &&
        step.inspection.commandStatus !== "prepared" &&
        step.inspection.commandStatus !== "compiling" &&
        step.inspection.attemptStatus !== "running";
      if (!stopped) {
        return { evidence, reason: "The stalled request was not stopped with a timeout inside the limit.", status: "fail" };
      }
      if (next?.actor === "assistant") {
        return { evidence, reason: "A late answer was committed after the request deadline.", status: "fail" };
      }
      return settled
        ? { evidence, reason: "The request ended with a timeout inside the limit, committed nothing late and left nothing running.", status: "pass" }
        : { evidence, reason: "The request ended but its command or attempt was left unsettled.", status: "fail" };
    }
    case "resend_is_idempotent": {
      const original = findStep(observation, check.of);
      if (!original) return missingStep(check.of, observation);
      const originalId = original.chat?.userMessageId ?? null;
      const resentId = chat?.userMessageId ?? null;
      const copies = originalId
        ? allMessages(observation.finalHistory).filter((message) => message.id === originalId).length
        : 0;
      const generations = step.providerRequests.filter(
        (request) => request.conversationTurn,
      ).length;
      const evidence = [
        `steps[${check.of}].chat.userMessageId=${originalId}`,
        `${pointer}.chat.userMessageId=${resentId}`,
        `${pointer}.providerRequests (conversation turn)=${generations}`,
        `finalHistory copies=${copies}`,
      ];
      return originalId !== null &&
        resentId === originalId &&
        copies === 1 &&
        generations === 0
        ? { evidence, reason: "The resend resolved to the original message and caused no new generation.", status: "pass" }
        : { evidence, reason: "The resend was not idempotent.", status: "fail" };
    }
    case "usage_recorded": {
      const inspection = step.inspection;
      const evidence = [
        `${pointer}.inspection.inputTokens=${inspection?.inputTokens ?? "null"}`,
        `${pointer}.inspection.outputTokens=${inspection?.outputTokens ?? "null"}`,
      ];
      return inspection && inspection.inputTokens !== null && inspection.outputTokens !== null
        ? { evidence, reason: "Token usage is recorded for the attempt.", status: "pass" }
        : { evidence, reason: "Token usage is missing for the attempt.", status: "fail" };
    }
    case "date_coverage": {
      const coverage = step.inspection?.dateCoverage.find(
        (entry) => entry.localDate === check.localDate,
      );
      if (!coverage) {
        return {
          evidence: [`${pointer}.inspection.dateCoverage has no entry for ${check.localDate}`],
          reason: "That local date was not covered by any recorded read, so nothing about it is verified.",
          status: "fail",
        };
      }
      const evidence = [
        `${pointer}.inspection.dateCoverage[${check.localDate}] empty=${coverage.empty} readBounded=${coverage.readBounded} candidateRows=${coverage.candidateRows}`,
      ];
      const matches =
        coverage.empty === check.expect.empty &&
        (check.expect.readBounded === undefined ||
          coverage.readBounded === check.expect.readBounded);
      return matches
        ? { evidence, reason: "Recorded coverage for the date matches the expectation.", status: "pass" }
        : { evidence, reason: "Recorded coverage for the date contradicts the expectation.", status: "fail" };
    }
    case "deadline": {
      if (!answeredByRealProvider(step)) return NOT_FROM_REAL_PROVIDER;
      const first = chat?.timing.firstVisibleTextMs ?? null;
      const complete = chat?.timing.committedMs ?? null;
      const evidence = [
        `${pointer}.chat.timing.firstVisibleTextMs=${first} (CLI network, limit ${check.firstVisibleTextMaxMs})`,
        `${pointer}.chat.timing.committedMs=${complete} (CLI network, limit ${check.completeMaxMs})`,
      ];
      return first !== null &&
        complete !== null &&
        first <= check.firstVisibleTextMaxMs &&
        complete <= check.completeMaxMs
        ? { evidence, reason: "CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement.", status: "pass" }
        : { evidence, reason: "CLI-observed timings exceed the limits or the turn never completed.", status: "fail" };
    }
  }
}

function evaluateReviewed(
  criterion: ReviewedCriterion,
  observation: CaseObservation,
  review: ReviewFile | null,
): Verdict {
  if (observation.mode !== "real-model") {
    return {
      evidence: [],
      reason: "Deterministic mode replies with a fixed stub sentence, which is not a model answer and is never scored for meaning.",
      status: "not-run",
    };
  }
  const step = findStep(observation, criterion.step);
  if (!step) return missingStep(criterion.step, observation);
  const reply = step.chat?.streamedText ?? "";
  if (step.providerRequests.length > 0 && !answeredByRealProvider(step)) {
    return NOT_FROM_REAL_PROVIDER;
  }
  if (step.chat?.terminalEvent !== "assistant_committed" || !reply.trim()) {
    return {
      evidence: [`steps[${step.id}].chat.terminalEvent=${step.chat?.terminalEvent ?? "none"}`],
      reason: "There is no committed answer to review.",
      status: "fail",
    };
  }
  if (!review) {
    return { evidence: [], reason: "No independent review was supplied for this answer.", status: "needs-review" };
  }
  if (review.caseId !== observation.caseId || review.runId !== observation.identity.runId) {
    return {
      evidence: [`review is for ${review.caseId}/${review.runId}`],
      reason: "The supplied review belongs to a different case or run.",
      status: "needs-review",
    };
  }
  if (review.reviewer === `model:${observation.identity.model}`) {
    return {
      evidence: [`review.reviewer=${review.reviewer}`],
      reason: "The model under test cannot grade its own answer.",
      status: "needs-review",
    };
  }

  const normalizedReply = normalize(reply);
  const cited = (quote: string | undefined) =>
    typeof quote === "string" &&
    normalize(quote).length > 0 &&
    normalizedReply.includes(normalize(quote));
  const evidence: string[] = [];
  const statuses: CriterionStatus[] = [];
  const consider = (itemId: string, polarity: "required" | "forbidden") => {
    const finding = review.findings.find(
      (candidate) => candidate.criterionId === criterion.id && candidate.itemId === itemId,
    );
    if (!finding) {
      evidence.push(`${itemId}: no finding`);
      statuses.push("needs-review");
      return;
    }
    if (finding.verdict === "needs-review") {
      evidence.push(`${itemId}: reviewer left it open — ${finding.reason}`);
      statuses.push("needs-review");
      return;
    }
    // A claim about the reply's content must point at the reply. A required
    // item is proven by where it appears; a forbidden item is disproven by
    // where it appears. Absence needs no quote.
    const needsQuote =
      (polarity === "required" && finding.verdict === "pass") ||
      (polarity === "forbidden" && finding.verdict === "fail");
    if (needsQuote && !cited(finding.quote)) {
      evidence.push(`${itemId}: reviewer says ${finding.verdict} but the cited span is not in the reply`);
      statuses.push("needs-review");
      return;
    }
    evidence.push(
      `${itemId}: ${finding.verdict}${finding.quote ? ` — reply: ${JSON.stringify(finding.quote)}` : ""} — ${finding.reason}`,
    );
    statuses.push(finding.verdict);
  };
  for (const itemId of criterion.required) consider(itemId, "required");
  for (const itemId of criterion.forbidden) consider(itemId, "forbidden");

  const status = aggregateStatus(statuses);
  if (status === "pass" && criterion.kind === "subjective" && !review.reviewer.startsWith("human:")) {
    return {
      evidence,
      reason: "An agent or model review of empathy and persona is advisory; a human verdict is required (ADR-0110).",
      status: "needs-review",
    };
  }
  return {
    evidence,
    reason:
      status === "pass"
        ? "Every ledger item is settled by a finding that cites the reply."
        : status === "fail"
          ? "At least one ledger item is contradicted by the reply."
          : "At least one ledger item lacks a usable finding.",
    status,
  };
}

function evaluateInvariants(
  loaded: LoadedCase,
  observation: CaseObservation,
): CriterionResult[] {
  const results: CriterionResult[] = [];

  // Seeded history must be readable back through the normal history API,
  // otherwise the scenario's precondition was never established.
  const readback = allMessages(observation.seed.readback);
  const seedEvidence: string[] = [];
  let seedOk = true;
  for (const turn of loaded.fixture.history) {
    const seeded = observation.seed.turns.find((candidate) => candidate.key === turn.key);
    const user = readback.filter((message) => message.actor === "user" && message.text === turn.user).length;
    const assistant = readback.filter((message) => message.actor === "assistant" && message.text === turn.assistant).length;
    if (seeded?.terminalEvent !== "assistant_committed" || user !== 1 || assistant !== 1) {
      seedOk = false;
      seedEvidence.push(`seed.turns[${turn.key}] terminal=${seeded?.terminalEvent ?? "missing"} userCopies=${user} assistantCopies=${assistant}`);
    }
  }
  results.push({
    description: "Seeded history is read back verbatim through the normal history API.",
    evidence: seedEvidence,
    id: "INV-seed-readback",
    kind: "invariant",
    owner: null,
    reason: seedOk
      ? `All ${loaded.fixture.history.length} seeded turns are present exactly once.`
      : "Seeded history could not be confirmed, so the scenario precondition is not established.",
    status: seedOk ? "pass" : "environment-error",
  });

  // Nothing the scorer knows may have reached the model.
  const outbound = [
    ...observation.seed.providerStrings.map((value) => ({ value, where: "seed" })),
    ...observation.backgroundProviderStrings.map((value) => ({ value, where: "background" })),
    ...observation.steps.flatMap((step) =>
      step.providerRequests.flatMap((request) =>
        request.strings.map((value) => ({ value, where: `steps[${step.id}].providerRequests[${request.sequence}]` })),
      ),
    ),
  ];
  const leaks: string[] = [];
  for (const candidate of oracleStrings(loaded.oracle)) {
    if (candidate.length < ORACLE_LEAK_MIN_LENGTH) continue;
    const hit = outbound.find((entry) => entry.value.includes(candidate));
    if (hit) leaks.push(`${hit.where} contains oracle text ${JSON.stringify(candidate.slice(0, 60))}`);
  }
  results.push({
    description: "No oracle text, scenario title or expected answer appears in any Provider request.",
    evidence: leaks,
    id: "INV-oracle-not-in-outbound",
    kind: "invariant",
    owner: null,
    reason: leaks.length === 0
      ? `Scanned ${outbound.length} outbound strings; none carries oracle text.`
      : "Oracle text reached the model request.",
    status: leaks.length === 0 ? "pass" : "fail",
  });

  const seen = new Map<string, number>();
  for (const message of allMessages(observation.finalHistory)) {
    if (message.id) seen.set(message.id, (seen.get(message.id) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `finalHistory has ${count} messages with id ${id}`);
  results.push({
    description: "Authoritative history contains every message exactly once.",
    evidence: duplicates,
    id: "INV-no-duplicate-messages",
    kind: "invariant",
    owner: null,
    reason: duplicates.length === 0 ? `${seen.size} messages, no duplicates.` : "A message appears more than once in authoritative history.",
    status: duplicates.length === 0 ? "pass" : "fail",
  });

  return results;
}

export function evaluateCase(input: {
  loaded: LoadedCase;
  observation: CaseObservation;
  review: ReviewFile | null;
}): CaseReport {
  const { loaded, observation, review } = input;
  const broken = observation.environmentErrors.length > 0;
  const brokenVerdict: Verdict = {
    evidence: observation.environmentErrors.map((error) => `environmentErrors: ${error}`),
    reason: "The harness failed, so this is not a verdict about the product.",
    status: "environment-error",
  };

  // The script only acts in deterministic mode; a real model picks its own clues.
  const hindsightByStep = new Map<string, string[]>();
  if (observation.mode === "deterministic") {
    for (const entry of scriptedDecisionHindsight(loaded.fixture)) {
      hindsightByStep.set(entry.stepId, [
        ...(hindsightByStep.get(entry.stepId) ?? []),
        entry.clue,
      ]);
    }
  }

  const criteria: CriterionResult[] = [];
  for (const invariant of evaluateInvariants(loaded, observation)) {
    criteria.push(broken ? { ...invariant, ...brokenVerdict } : invariant);
  }
  for (const criterion of loaded.oracle.criteria) {
    let verdict: Verdict;
    if (broken) {
      verdict = brokenVerdict;
    } else if (criterion.kind === "objective") {
      verdict = criterion.modes.includes(observation.mode)
        ? evaluateObjective(criterion, loaded, observation)
        : {
            evidence: [],
            reason: `This check is only meaningful in ${criterion.modes.join(" / ")} mode; the run used ${observation.mode}.`,
            status: "not-run",
          };
    } else {
      verdict = evaluateReviewed(criterion, observation, review);
    }
    const scriptedStep =
      criterion.kind === "objective" && "step" in criterion.check
        ? criterion.check.step
        : null;
    const hindsightClues =
      scriptedStep === null ? [] : (hindsightByStep.get(scriptedStep) ?? []);
    criteria.push(applyOwnerRulings(observation.caseId, {
      description: criterion.description,
      evidence:
        hindsightClues.length > 0
          ? [
              ...verdict.evidence,
              `pipeline-only: the scripted Decision for steps[${scriptedStep}] used hindsight clue(s) ${hindsightClues.map((clue) => JSON.stringify(clue)).join(", ")}, which neither the current message nor the person's previous seven days of messages contain`,
            ]
          : verdict.evidence,
      id: criterion.id,
      kind: criterion.kind,
      owner: criterion.owner ?? null,
      reason: verdict.reason,
      ...(hindsightClues.length > 0 ? { scope: "pipeline-only" as const } : {}),
      status: verdict.status,
    }));
  }

  const pipelineOnly = criteria
    .filter((criterion) => criterion.scope === "pipeline-only")
    .map((criterion) => criterion.id);
  const aggregate = aggregateStatus(criteria.map((criterion) => criterion.status));
  return {
    caseId: observation.caseId,
    criteria,
    mode: observation.mode,
    pipelineOnly,
    reviewer: review?.reviewer ?? null,
    runId: observation.identity.runId,
    // A case whose passes rest on a hindsight Decision has not shown that the
    // model would choose it: the choice was not exercised, so it is not a pass.
    status: aggregate === "pass" && pipelineOnly.length > 0 ? "not-run" : aggregate,
  };
}
