import {
  FIXTURE_SCHEMA_VERSION,
  ORACLE_SCHEMA_VERSION,
  sha256,
  type CaseFixture,
  type CaseOracle,
  type LoadedCase,
} from "./fixture";
import {
  OBSERVATION_SCHEMA_VERSION,
  type CaseObservation,
  type ObservedSession,
  type ObservedStep,
} from "./observation";
import type { CriterionStatus, ReviewFile } from "./evaluate";

/**
 * Checker calibration (T00 #313): prefabricated correct and deliberately wrong
 * synthetic transcripts with the verdict each one MUST receive. It proves the
 * report can tell a good run from a specific bad one — it does not merely
 * prove the tool exits zero.
 *
 * The calibration scenario is deliberately not one of C01–C12, so tuning the
 * checker here can never tune it against an acceptance case. Expectations are
 * literals written from the acceptance contract; a checker miss or false alarm
 * is a bug in the checker, never a reason to edit these expectations to match.
 */

const FIXTURE: CaseFixture = {
  defaults: { locale: "en-US", timezone: "America/Chicago" },
  fixtureVersion: "calibration-1",
  history: [
    {
      assistant: "A flooded basement is a rough way to start a month.",
      at: "2026-03-02T15:00:00.000Z",
      key: "k0",
      user: "The basement flooded this morning and I spent hours bailing it out.",
    },
    {
      assistant: "Getting the fence upright again sounds satisfying.",
      at: "2026-03-24T14:10:00.000Z",
      key: "k1",
      user: "I finally fixed the leaning garden fence before breakfast.",
    },
    {
      assistant: "Maybe she is thinking about moving closer to you?",
      at: "2026-03-24T19:30:00.000Z",
      key: "k2",
      user: "My sister Dana wants to visit in April and stay a week.",
    },
    {
      assistant: "Presenting to the whole floor is a lot to hold.",
      at: "2026-03-25T03:40:00.000Z",
      key: "k3",
      user: "I am nervous about presenting the budget review to the whole floor on Friday.",
    },
  ],
  id: "CAL",
  languageVariant: "en",
  schemaVersion: FIXTURE_SCHEMA_VERSION,
  stage: "development",
  steps: [
    { at: "2026-03-25T15:00:00.000Z", id: "q1", text: "What did we talk about yesterday?", type: "say" },
    { abortAfterDeltas: 1, at: "2026-03-25T15:05:00.000Z", id: "q2", text: "Actually, never mind that.", type: "say" },
    { at: "2026-03-25T15:06:00.000Z", id: "q3", of: "q1", type: "resend" },
  ],
};

const FIXTURE_TEXT = JSON.stringify(FIXTURE);

const ORACLE: CaseOracle = {
  capability: "Calibration only: recap a single local day and keep guesses apart from user facts.",
  criteria: [
    { check: { step: "q1", type: "turn_committed" }, description: "The recap turn commits.", id: "O-commit", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { step: "q1", type: "history_matches_stream" }, description: "Authoritative history holds exactly the streamed reply.", id: "O-history", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { sources: ["k1:user", "k2:user", "k3:user"], step: "q1", type: "outbound_includes" }, description: "All three of that day's user messages reach the Provider.", id: "O-sources", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { sources: ["k0:user"], step: "q1", type: "outbound_excludes" }, description: "The excluded older message never reaches the Provider.", id: "O-excluded", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { expect: { empty: true, readBounded: false }, localDate: "2026-03-23", step: "q1", type: "date_coverage" }, description: "The day before is verified empty by an unbounded read.", id: "O-empty-day", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { step: "q2", type: "no_commit_after_abort" }, description: "A cancelled reply is never committed late.", id: "O-abort", kind: "objective", modes: ["deterministic", "real-model"] },
    { check: { of: "q1", step: "q3", type: "resend_is_idempotent" }, description: "Re-sending with the same keys creates nothing new.", id: "O-resend", kind: "objective", modes: ["deterministic", "real-model"] },
    { description: "The recap covers every main topic and does not promote the assistant's guess.", forbidden: ["f-guess"], id: "S-topics", kind: "semantic", required: ["t-fence", "t-sister", "t-presentation"], step: "q1" },
    { description: "The recap places those messages on the correct day.", forbidden: [], id: "S-time", kind: "semantic", required: ["tm-day"], step: "q1" },
    { description: "The tone receives the nervousness without lecturing.", forbidden: [], id: "P-tone", kind: "subjective", required: ["a-nervous"], step: "q1" },
  ],
  expectedBehavior: ["Recap the three subjects raised on the previous local day."],
  facts: {
    allowed: [{ id: "a-nervous", sources: ["k3:user"], statement: "The person felt anxious ahead of a Friday talk at work." }],
    forbidden: [{ id: "f-guess", sources: ["k2:assistant"], statement: "The relative intends to relocate nearer; only the assistant floated that." }],
  },
  failureSignals: ["A subject from early in the day is dropped."],
  fixture: { sha256: sha256(FIXTURE_TEXT), version: "calibration-1" },
  id: "CAL",
  language: "en",
  ownerTickets: [],
  schemaVersion: ORACLE_SCHEMA_VERSION,
  sourceEligibility: [
    { eligibility: "forbidden", reason: "Excluded by an earlier user control.", source: "k0:user" },
    { eligibility: "allowed", reason: "Said on the day being recapped.", source: "k1:user" },
    { eligibility: "allowed", reason: "Said on the day being recapped.", source: "k2:user" },
    { eligibility: "allowed", reason: "Said on the day being recapped.", source: "k3:user" },
  ],
  spec: [],
  time: [{ id: "tm-day", sources: ["k1:user", "k2:user", "k3:user"], statement: "All three were expressed on 24 March local time, the day before the question." }],
  title: "Calibration: one-day recap",
  topics: [
    { id: "t-fence", sources: ["k1:user"], statement: "Repairing an outdoor barrier in the yard." },
    { id: "t-sister", sources: ["k2:user"], statement: "A sibling planning a spring stay." },
    { id: "t-presentation", sources: ["k3:user"], statement: "Worry over an upcoming finance talk." },
  ],
};

const ORACLE_TEXT = JSON.stringify(ORACLE);

export const calibrationCase: LoadedCase = {
  fixture: FIXTURE,
  fixturePath: "calibration/CAL.fixture.json",
  fixtureSha256: sha256(FIXTURE_TEXT),
  fixtureText: FIXTURE_TEXT,
  oracle: ORACLE,
  oraclePath: "calibration/CAL.oracle.json",
  oracleSha256: sha256(ORACLE_TEXT),
  oracleText: ORACLE_TEXT,
};

const MODEL = "calibration-model-under-test";

/** Two correct recaps in different words: both must score the same. */
const REPLY_A =
  "Yesterday you told me three things: you fixed the leaning garden fence in the morning, your sister Dana wants to come and stay for a week in April, and late at night you said you were nervous about Friday's budget review.";
const REPLY_B =
  "Three threads from the 24th. Early on, the fence in the garden got straightened. Then Dana, your sister, hoping for a week-long April visit. And near midnight, the nerves about presenting the budget review on Friday.";
const REPLY_MISSING_TOPIC =
  "Yesterday you mentioned that your sister Dana wants to stay for a week in April, and that you were nervous about Friday's budget review.";
const REPLY_WRONG_DATE =
  "Last Tuesday you fixed the garden fence, heard that your sister Dana wants to visit in April, and worried about Friday's budget review.";
const REPLY_GUESS_AS_FACT =
  "Yesterday you fixed the garden fence, said your sister Dana is moving closer to you and will visit in April, and worried about Friday's budget review.";

function userText(key: string): string {
  return FIXTURE.history.find((turn) => turn.key === key)!.user;
}

function session(
  dailySessionId: string,
  logicalDate: string,
  messages: readonly Readonly<{ actor: string; id: string; text: string }>[],
): ObservedSession {
  return {
    dailySessionId,
    logicalDate,
    messages: messages.map((message, index) => ({
      actor: message.actor,
      createdAt: null,
      id: message.id,
      sequence: index + 1,
      text: message.text,
    })),
  };
}

function seededSessions(): ObservedSession[] {
  return [
    session("session-0302", "2026-03-02", [
      { actor: "user", id: "k0-u", text: userText("k0") },
      { actor: "assistant", id: "k0-a", text: FIXTURE.history[0]!.assistant },
    ]),
    session("session-0324", "2026-03-24", [
      { actor: "user", id: "k1-u", text: userText("k1") },
      { actor: "assistant", id: "k1-a", text: FIXTURE.history[1]!.assistant },
      { actor: "user", id: "k2-u", text: userText("k2") },
      { actor: "assistant", id: "k2-a", text: FIXTURE.history[2]!.assistant },
      { actor: "user", id: "k3-u", text: userText("k3") },
      { actor: "assistant", id: "k3-a", text: FIXTURE.history[3]!.assistant },
    ]),
  ];
}

function correctObservation(reply: string): CaseObservation {
  const q1: ObservedStep = {
    at: "2026-03-25T15:00:00.000Z",
    chat: {
      assistantRevisionId: "q1-a-rev",
      clientAborted: false,
      events: [
        { delta: null, elapsedMs: 40, type: "user_committed" },
        { delta: reply, elapsedMs: 900, type: "assistant_delta" },
        { delta: null, elapsedMs: 1_200, type: "assistant_committed" },
      ],
      generationCommandId: "q1-command",
      httpStatus: 200,
      streamedText: reply,
      terminalEvent: "assistant_committed",
      timing: { acceptedMs: 40, committedMs: 1_200, firstVisibleTextMs: 900, streamClosedMs: 1_210 },
      userMessageId: "q1-u",
      userRevisionId: "q1-u-rev",
    },
    id: "q1",
    input: { clientEventId: "CAL-q1-event", clientTurnId: "CAL-q1-turn", locale: "en-US", text: "What did we talk about yesterday?", timezone: "America/Chicago" },
    inspection: {
      attemptStatus: "succeeded",
      commandStatus: "succeeded",
      compilerVersion: "context-compiler:calibration",
      dailySessionId: "session-0325",
      dateCoverage: [
        { candidateRows: 0, empty: true, localDate: "2026-03-23", readBounded: false },
        { candidateRows: 6, empty: false, localDate: "2026-03-24", readBounded: false },
      ],
      inputTokens: 900,
      outputTokens: 60,
      providerLatencyMs: 850,
      recentContextFailure: null,
      recentContextWindow: { end: "2026-03-25", start: "2026-03-19" },
      referencedEvents: [
        { actor: "user", expressedAt: "2026-03-24T14:10:00.000Z", revisionId: "k1-u-rev", section: "recent_conversation_context" },
        { actor: "user", expressedAt: "2026-03-24T19:30:00.000Z", revisionId: "k2-u-rev", section: "recent_conversation_context" },
        { actor: "user", expressedAt: "2026-03-25T03:40:00.000Z", revisionId: "k3-u-rev", section: "recent_conversation_context" },
        { actor: "user", expressedAt: null, revisionId: "q1-u-rev", section: "current_user_input" },
      ],
    },
    problems: [],
    providerRequests: [
      { conversationTurn: true, sequence: 5, strings: ["system instructions", userText("k1"), userText("k2"), userText("k3"), "What did we talk about yesterday?"] },
    ],
    type: "say",
  };
  const q2: ObservedStep = {
    at: "2026-03-25T15:05:00.000Z",
    chat: {
      assistantRevisionId: null,
      clientAborted: true,
      events: [
        { delta: null, elapsedMs: 35, type: "user_committed" },
        { delta: "Of ", elapsedMs: 700, type: "assistant_delta" },
      ],
      generationCommandId: "q2-command",
      httpStatus: 200,
      streamedText: "Of ",
      terminalEvent: null,
      timing: { acceptedMs: 35, committedMs: null, firstVisibleTextMs: 700, streamClosedMs: 705 },
      userMessageId: "q2-u",
      userRevisionId: "q2-u-rev",
    },
    id: "q2",
    input: { clientEventId: "CAL-q2-event", clientTurnId: "CAL-q2-turn", locale: "en-US", text: "Actually, never mind that.", timezone: "America/Chicago" },
    inspection: null,
    problems: [],
    providerRequests: [{ conversationTurn: true, sequence: 6, strings: ["system instructions", "Actually, never mind that."] }],
    type: "say",
  };
  const q3: ObservedStep = {
    at: "2026-03-25T15:06:00.000Z",
    chat: {
      assistantRevisionId: "q1-a-rev",
      clientAborted: false,
      events: [
        { delta: null, elapsedMs: 30, type: "user_committed" },
        { delta: null, elapsedMs: 45, type: "assistant_committed" },
      ],
      generationCommandId: "q1-command",
      httpStatus: 200,
      streamedText: "",
      terminalEvent: "assistant_committed",
      timing: { acceptedMs: 30, committedMs: 45, firstVisibleTextMs: null, streamClosedMs: 50 },
      userMessageId: "q1-u",
      userRevisionId: "q1-u-rev",
    },
    id: "q3",
    input: { clientEventId: "CAL-q1-event", clientTurnId: "CAL-q1-turn", locale: "en-US", text: "What did we talk about yesterday?", timezone: "America/Chicago" },
    inspection: null,
    problems: [],
    providerRequests: [],
    type: "resend",
  };
  return {
    backgroundProviderStrings: [],
    caseId: "CAL",
    environmentErrors: [],
    finalHistory: [
      ...seededSessions(),
      session("session-0325", "2026-03-25", [
        { actor: "user", id: "q1-u", text: "What did we talk about yesterday?" },
        { actor: "assistant", id: "q1-a", text: reply },
        { actor: "user", id: "q2-u", text: "Actually, never mind that." },
      ]),
    ],
    identity: {
      fixtureSha256: calibrationCase.fixtureSha256,
      fixtureVersion: "calibration-1",
      gitCommit: "0000000000000000000000000000000000000000",
      gitDirty: false,
      model: MODEL,
      recentContextGovernance: "active",
      runId: "calibration-run",
    },
    mode: "real-model",
    scheduledScans: [],
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seed: {
      providerStrings: [],
      readback: seededSessions(),
      turns: FIXTURE.history.map((turn) => ({
        assistantRevisionId: `${turn.key}-a-rev`,
        at: turn.at,
        dailySessionId: turn.key === "k0" ? "session-0302" : "session-0324",
        key: turn.key,
        terminalEvent: "assistant_committed",
        userRevisionId: `${turn.key}-u-rev`,
      })),
    },
    steps: [q1, q2, q3],
  };
}

function review(
  reviewer: string,
  findings: ReviewFile["findings"],
): ReviewFile {
  return {
    caseId: "CAL",
    findings,
    reviewer,
    rubricVersion: "continuity-rubric:v1",
    runId: "calibration-run",
    schemaVersion: "continuity-acceptance-review:v1",
  };
}

const TONE_FINDING = {
  criterionId: "P-tone",
  itemId: "a-nervous",
  quote: "nervous about",
  reason: "Names the feeling without advice.",
  verdict: "pass" as const,
};

function correctReview(reviewer: string, quotes: Readonly<Record<string, string>>): ReviewFile {
  return review(reviewer, [
    { criterionId: "S-topics", itemId: "t-fence", quote: quotes["fence"]!, reason: "Fence repair is recapped.", verdict: "pass" },
    { criterionId: "S-topics", itemId: "t-sister", quote: quotes["sister"]!, reason: "The visit is recapped.", verdict: "pass" },
    { criterionId: "S-topics", itemId: "t-presentation", quote: quotes["presentation"]!, reason: "The presentation worry is recapped.", verdict: "pass" },
    { criterionId: "S-topics", itemId: "f-guess", reason: "No relocation claim appears.", verdict: "pass" },
    { criterionId: "S-time", itemId: "tm-day", quote: quotes["day"]!, reason: "Placed on the previous day.", verdict: "pass" },
    { ...TONE_FINDING, quote: quotes["tone"]! },
  ]);
}

const QUOTES_A = {
  day: "Yesterday you told me",
  fence: "fixed the leaning garden fence",
  presentation: "nervous about Friday's budget review",
  sister: "your sister Dana wants to come and stay",
  tone: "you were nervous about",
};
const QUOTES_B = {
  day: "from the 24th",
  fence: "the fence in the garden got straightened",
  presentation: "the nerves about presenting the budget review",
  sister: "Dana, your sister, hoping for a week-long April visit",
  tone: "the nerves about presenting",
};

function mutate(
  observation: CaseObservation,
  change: (draft: {
    environmentErrors: string[];
    finalHistory: ObservedSession[];
    mode: CaseObservation["mode"];
    seedProviderStrings: string[];
    steps: ObservedStep[];
  }) => void,
): CaseObservation {
  const draft = {
    environmentErrors: [...observation.environmentErrors],
    finalHistory: [...observation.finalHistory],
    mode: observation.mode,
    seedProviderStrings: [...observation.seed.providerStrings],
    steps: [...observation.steps],
  };
  change(draft);
  return {
    ...observation,
    environmentErrors: draft.environmentErrors,
    finalHistory: draft.finalHistory,
    mode: draft.mode,
    seed: { ...observation.seed, providerStrings: draft.seedProviderStrings },
    steps: draft.steps,
  };
}

export type CalibrationSample = Readonly<{
  /** What is wrong with this transcript, or `none`. */
  defect: string;
  expect: Readonly<{
    aggregate: CriterionStatus;
    criteria: Readonly<Record<string, CriterionStatus>>;
  }>;
  name: string;
  observation: CaseObservation;
  review: ReviewFile | null;
}>;

const ALL_OBJECTIVE_PASS = {
  "INV-no-duplicate-messages": "pass",
  "INV-oracle-not-in-outbound": "pass",
  "INV-seed-readback": "pass",
  "O-abort": "pass",
  "O-commit": "pass",
  "O-empty-day": "pass",
  "O-excluded": "pass",
  "O-history": "pass",
  "O-resend": "pass",
  "O-sources": "pass",
} as const;

export function calibrationSamples(): CalibrationSample[] {
  const good = correctObservation(REPLY_A);
  const q1 = good.steps[0]!;
  const lastSession = good.finalHistory.at(-1)!;
  return [
    {
      defect: "none",
      expect: { aggregate: "pass", criteria: { ...ALL_OBJECTIVE_PASS, "P-tone": "pass", "S-time": "pass", "S-topics": "pass" } },
      name: "correct-wording-a-human-reviewed",
      observation: good,
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "none (different correct wording)",
      expect: { aggregate: "pass", criteria: { ...ALL_OBJECTIVE_PASS, "P-tone": "pass", "S-time": "pass", "S-topics": "pass" } },
      name: "correct-wording-b-human-reviewed",
      observation: correctObservation(REPLY_B),
      review: correctReview("human:luke", QUOTES_B),
    },
    {
      defect: "none, but persona was only reviewed by an agent",
      expect: { aggregate: "needs-review", criteria: { "P-tone": "needs-review", "S-time": "pass", "S-topics": "pass" } },
      name: "correct-agent-reviewed-leaves-subjective-open",
      observation: good,
      review: correctReview("agent:independent-reviewer", QUOTES_A),
    },
    {
      defect: "an early topic is missing from the recap",
      expect: { aggregate: "fail", criteria: { "S-topics": "fail" } },
      name: "missing-early-topic",
      observation: correctObservation(REPLY_MISSING_TOPIC),
      review: review("agent:independent-reviewer", [
        { criterionId: "S-topics", itemId: "t-fence", reason: "The fence repair is never mentioned.", verdict: "fail" },
        { criterionId: "S-topics", itemId: "t-sister", quote: "your sister Dana wants to stay for a week", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-presentation", quote: "nervous about Friday's budget review", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "f-guess", reason: "Absent.", verdict: "pass" },
        { criterionId: "S-time", itemId: "tm-day", quote: "Yesterday you mentioned", reason: "Correct day.", verdict: "pass" },
        TONE_FINDING,
      ]),
    },
    {
      defect: "an early topic is missing and a careless review claims it is there",
      expect: { aggregate: "needs-review", criteria: { "S-topics": "needs-review" } },
      name: "missing-early-topic-with-unsupported-pass",
      observation: correctObservation(REPLY_MISSING_TOPIC),
      review: review("agent:careless-reviewer", [
        { criterionId: "S-topics", itemId: "t-fence", quote: "fixed the leaning garden fence", reason: "Claimed present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-sister", quote: "your sister Dana wants to stay for a week", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-presentation", quote: "nervous about Friday's budget review", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "f-guess", reason: "Absent.", verdict: "pass" },
        { criterionId: "S-time", itemId: "tm-day", quote: "Yesterday you mentioned", reason: "Correct day.", verdict: "pass" },
        TONE_FINDING,
      ]),
    },
    {
      defect: "the recap puts the messages on the wrong date",
      expect: { aggregate: "fail", criteria: { "S-time": "fail", "S-topics": "pass" } },
      name: "wrong-date",
      observation: correctObservation(REPLY_WRONG_DATE),
      review: review("agent:independent-reviewer", [
        { criterionId: "S-topics", itemId: "t-fence", quote: "fixed the garden fence", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-sister", quote: "your sister Dana wants to visit in April", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-presentation", quote: "worried about Friday's budget review", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "f-guess", reason: "Absent.", verdict: "pass" },
        { criterionId: "S-time", itemId: "tm-day", quote: "Last Tuesday", reason: "The messages were expressed yesterday, not last Tuesday.", verdict: "fail" },
      ]),
    },
    {
      defect: "the assistant's earlier guess is restated as a user fact",
      expect: { aggregate: "fail", criteria: { "S-time": "pass", "S-topics": "fail" } },
      name: "guess-promoted-to-fact",
      observation: correctObservation(REPLY_GUESS_AS_FACT),
      review: review("agent:independent-reviewer", [
        { criterionId: "S-topics", itemId: "t-fence", quote: "fixed the garden fence", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-sister", quote: "will visit in April", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "t-presentation", quote: "worried about Friday's budget review", reason: "Present.", verdict: "pass" },
        { criterionId: "S-topics", itemId: "f-guess", quote: "is moving closer to you", reason: "Only the assistant suggested relocation.", verdict: "fail" },
        { criterionId: "S-time", itemId: "tm-day", quote: "Yesterday you fixed", reason: "Correct day.", verdict: "pass" },
      ]),
    },
    {
      defect: "a cancelled reply is committed late",
      expect: { aggregate: "fail", criteria: { "O-abort": "fail", "O-commit": "pass" } },
      name: "late-reply-after-cancel",
      observation: mutate(good, (draft) => {
        draft.finalHistory[draft.finalHistory.length - 1] = {
          ...lastSession,
          messages: [
            ...lastSession.messages,
            { actor: "assistant", createdAt: null, id: "q2-a-late", sequence: 4, text: "Of course, we can drop it." },
          ],
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "a day is called empty although the read was cut short",
      expect: { aggregate: "fail", criteria: { "O-empty-day": "fail" } },
      name: "false-empty-range",
      observation: mutate(good, (draft) => {
        draft.steps[0] = {
          ...q1,
          inspection: {
            ...q1.inspection!,
            dateCoverage: [
              { candidateRows: 0, empty: true, localDate: "2026-03-23", readBounded: true },
              { candidateRows: 6, empty: false, localDate: "2026-03-24", readBounded: false },
            ],
          },
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "a required source never reaches the Provider",
      expect: { aggregate: "fail", criteria: { "O-sources": "fail" } },
      name: "required-source-missing-from-outbound",
      observation: mutate(good, (draft) => {
        draft.steps[0] = {
          ...q1,
          inspection: {
            ...q1.inspection!,
            referencedEvents: q1.inspection!.referencedEvents.filter((event) => event.revisionId !== "k1-u-rev"),
          },
          providerRequests: [
            { conversationTurn: true, sequence: 5, strings: ["system instructions", userText("k2"), userText("k3"), "What did we talk about yesterday?"] },
          ],
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "an excluded source flows back to the Provider",
      expect: { aggregate: "fail", criteria: { "O-excluded": "fail" } },
      name: "forbidden-source-in-outbound",
      observation: mutate(good, (draft) => {
        draft.steps[0] = {
          ...q1,
          providerRequests: [
            { conversationTurn: true, sequence: 5, strings: [...q1.providerRequests[0]!.strings, userText("k0")] },
          ],
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "the expected answer leaked into the model request",
      expect: { aggregate: "fail", criteria: { "INV-oracle-not-in-outbound": "fail" } },
      name: "oracle-leaked-into-request",
      observation: mutate(good, (draft) => {
        draft.steps[0] = {
          ...q1,
          providerRequests: [
            { conversationTurn: true, sequence: 5, strings: [...q1.providerRequests[0]!.strings, `hint: ${ORACLE.topics[0]!.statement}`] },
          ],
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "a resend produced a second copy of the message",
      expect: { aggregate: "fail", criteria: { "INV-no-duplicate-messages": "fail" } },
      name: "duplicate-after-resend",
      observation: mutate(good, (draft) => {
        draft.finalHistory[draft.finalHistory.length - 1] = {
          ...lastSession,
          messages: [
            ...lastSession.messages,
            { actor: "user", createdAt: null, id: "q1-u", sequence: 4, text: "What did we talk about yesterday?" },
          ],
        };
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "the model under test graded itself",
      expect: { aggregate: "needs-review", criteria: { "S-time": "needs-review", "S-topics": "needs-review" } },
      name: "self-review-is-not-evidence",
      observation: good,
      review: correctReview(`model:${MODEL}`, QUOTES_A),
    },
    {
      defect: "no review was supplied for a real answer",
      expect: { aggregate: "needs-review", criteria: { "P-tone": "needs-review", "S-time": "needs-review", "S-topics": "needs-review" } },
      name: "real-answer-without-review",
      observation: good,
      review: null,
    },
    {
      defect: "a stub reply was produced, which is not a model answer",
      expect: { aggregate: "not-run", criteria: { ...ALL_OBJECTIVE_PASS, "P-tone": "not-run", "S-time": "not-run", "S-topics": "not-run" } },
      name: "deterministic-mode-never-scores-wording",
      observation: mutate(good, (draft) => {
        draft.mode = "deterministic";
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
    {
      defect: "the harness itself failed",
      expect: { aggregate: "environment-error", criteria: { "O-commit": "environment-error", "S-topics": "environment-error" } },
      name: "environment-error-is-not-a-product-verdict",
      observation: mutate(good, (draft) => {
        draft.environmentErrors.push("SayHear app did not become ready.");
      }),
      review: correctReview("human:luke", QUOTES_A),
    },
  ];
}
