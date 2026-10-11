import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { estimateRecentContextTokens, localDateOf } from "@sayhear/application";

/**
 * Case fixtures and their independent oracle ledgers (T00 #313).
 *
 * A fixture holds only what a user and time would produce: synthetic history
 * turns, instants, IANA zones and the follow-up inputs. It carries no title,
 * no description and no expectation. Everything the scorer needs to know —
 * capability, allowed and forbidden facts, source eligibility, criteria —
 * lives in a separate oracle file that the runner never loads on the request
 * path. `validateCase` enforces that separation mechanically, and the runner
 * re-checks it against the real Provider request (see `checks.ts`).
 */

export const FIXTURE_SCHEMA_VERSION = "continuity-acceptance-fixture:v1";
export const ORACLE_SCHEMA_VERSION = "continuity-acceptance-oracle:v1";

export type LanguageVariant = "zh" | "en" | "code-switch";

export type ProviderFaultSpec = Readonly<{
  delayBeforeFirstChunkMs?: number;
  delayBetweenChunksMs?: number;
  failAfterChunks?: number;
  httpStatus?: number;
}>;

export type HistoryReviewScript = Readonly<{ endDate: string; startDate: string }>;

export type ToolCallScript = Readonly<{ argumentsJson: string; name: string }>;

/** One seeded exchange: the user's words and the reply that was given then. */
export type HistoryTurn = Readonly<{
  assistant: string;
  /** UTC instant at which the user expressed this. */
  at: string;
  key: string;
  /**
   * Simulates a legacy row whose request timezone was never recorded. The
   * turn is still submitted with `timezone`; the recorded zone is cleared
   * afterwards because the current API cannot create such a row.
   */
  legacyMissingTimezone?: boolean;
  locale?: string;
  timezone?: string;
  user: string;
}>;

export type SayStep = Readonly<{
  /** Abort the client connection after this many assistant deltas. */
  abortAfterDeltas?: number;
  at: string;
  /**
   * Start the request and move on to the next step without waiting for it, as
   * a person does who keeps typing while a reply is being prepared (#319). The
   * request's outcome is observed when the run finishes or the next step ends.
   */
  continueInBackground?: boolean;
  id: string;
  locale?: string;
  /**
   * What the stand-in Provider's Decision should select when (and only when)
   * SayHear offers it the read-only history review function. The stub never
   * invents the call: if the product does not offer the function the reply
   * is ordinary text, which is the red signal for a missing capability.
   */
  historyReview?: HistoryReviewScript;
  providerFault?: ProviderFaultSpec;
  text: string;
  timezone?: string;
  /**
   * Make the stand-in Provider's Decision select this Function when SayHear
   * offers it (reproduces a Trust Action selection for latency work, #319).
   */
  toolCall?: ToolCallScript;
  type: "say";
}>;

/** Re-submit an earlier step with the same idempotency keys. */
export type ResendStep = Readonly<{
  at: string;
  id: string;
  of: string;
  type: "resend";
}>;

/** Restart the app process: a reconnect / recovery boundary. */
export type RestartStep = Readonly<{ at: string; id: string; type: "restart" }>;

/**
 * Correct a seeded user message through the real correction route. The
 * original wording is superseded; `text` is what the person now says it was.
 */
export type CorrectStep = Readonly<{
  at: string;
  id: string;
  locale?: string;
  /** Key of the history turn whose user message is corrected. */
  target: string;
  text: string;
  type: "correct";
}>;

export type CaseStep = SayStep | ResendStep | RestartStep | CorrectStep;

export type CaseFixture = Readonly<{
  defaults: Readonly<{ locale: string; timezone: string }>;
  fixtureVersion: string;
  history: readonly HistoryTurn[];
  id: string;
  languageVariant: LanguageVariant;
  schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  /**
   * `development` fixtures may be used while building and tuning. A `final`
   * fixture is frozen before tuning and must never have been tuned against.
   */
  stage: "development" | "final";
  steps: readonly CaseStep[];
}>;

export type OracleFact = Readonly<{
  id: string;
  /** Source keys (`<turn>:user` / `<turn>:assistant`) that support this. */
  sources: readonly string[];
  statement: string;
}>;

export type ObjectiveCheck =
  | Readonly<{ step: string; type: "turn_committed" }>
  | Readonly<{ step: string; type: "history_matches_stream" }>
  | Readonly<{ sources: readonly string[]; step: string; type: "outbound_includes" }>
  | Readonly<{ sources: readonly string[]; step: string; type: "outbound_excludes" }>
  | Readonly<{
      expect: readonly Readonly<{ logicalDate: string; source: string }>[];
      type: "session_ownership";
    }>
  | Readonly<{ step: string; type: "no_commit_after_abort" }>
  /**
   * A reply that a newer message retired is never shown and never stored: its
   * stream carried no assistant text and the person's next message is the next
   * thing in history, not an Assistant Event (#319).
   */
  | Readonly<{ step: string; type: "replaced_reply_never_shown" }>
  /**
   * A request whose Provider stalls is stopped by the request deadline: the
   * stream ends with a timeout well inside `maxMs`, nothing is committed late
   * and no command is left running (#319).
   */
  | Readonly<{ maxMs: number; step: string; type: "stopped_at_deadline" }>
  | Readonly<{ of: string; step: string; type: "resend_is_idempotent" }>
  | Readonly<{ step: string; type: "usage_recorded" }>
  /** Words said or corrected during the run reach the Provider for `step`. */
  | Readonly<{ inputs: readonly string[]; step: string; type: "outbound_includes_input" }>
  | Readonly<{ actionKind: string; step: string; type: "action_admitted" }>
  | Readonly<{ step: string; type: "no_action" }>
  /**
   * The runner cannot set up or observe this yet. Always `not-run`: a missing
   * harness capability is neither a product failure nor a pass.
   */
  | Readonly<{ capability: string; type: "unsupported" }>
  | Readonly<{
      expect: Readonly<{ empty: boolean; readBounded?: boolean }>;
      localDate: string;
      step: string;
      type: "date_coverage";
    }>
  | Readonly<{
      completeMaxMs: number;
      firstVisibleTextMaxMs: number;
      step: string;
      type: "deadline";
    }>;

export type RunMode = "deterministic" | "real-model";

export type ObjectiveCriterion = Readonly<{
  check: ObjectiveCheck;
  description: string;
  id: string;
  kind: "objective";
  /** Modes in which this check is meaningful; elsewhere it is `not-run`. */
  modes: readonly RunMode[];
  /** Ticket expected to turn this green, when it is a known red today. */
  owner?: string;
}>;

export type ReviewedCriterion = Readonly<{
  description: string;
  /** Fact ids that must not appear in the reply. */
  forbidden: readonly string[];
  id: string;
  /**
   * `semantic`: an independent reviewer can settle it from the transcript and
   * the source ledger. `subjective`: empathy / persona; reviewer findings are
   * advisory and only a human verdict can pass it (ADR-0110).
   */
  kind: "semantic" | "subjective";
  owner?: string;
  /** Fact / topic / time ids the reply must get right. */
  required: readonly string[];
  step: string;
}>;

export type Criterion = ObjectiveCriterion | ReviewedCriterion;

export type CaseOracle = Readonly<{
  capability: string;
  criteria: readonly Criterion[];
  expectedBehavior: readonly string[];
  facts: Readonly<{
    allowed: readonly OracleFact[];
    forbidden: readonly OracleFact[];
  }>;
  failureSignals: readonly string[];
  /** Binds the ledger to the exact fixture bytes it was written for. */
  fixture: Readonly<{ sha256: string; version: string }>;
  id: string;
  language: string;
  ownerTickets: readonly string[];
  /**
   * Properties the fixture itself must have for the case to mean anything,
   * for example "this day spans more than one history page". Checked by
   * `validateCase`, so a fixture cannot quietly stop exercising its pressure.
   */
  preconditions?: readonly Readonly<{
    description: string;
    /** Local date, in each turn's own expression timezone. */
    localDate: string;
    /** User plus assistant messages expressed on that date. */
    minMessages?: number;
    /** The product's own recent-context token estimate of that date's user text. */
    minUserContextTokens?: number;
  }>[];
  schemaVersion: typeof ORACLE_SCHEMA_VERSION;
  sourceEligibility: readonly Readonly<{
    eligibility: "allowed" | "forbidden";
    reason: string;
    source: string;
  }>[];
  spec: readonly string[];
  time: readonly OracleFact[];
  title: string;
  topics: readonly OracleFact[];
}>;

export type LoadedCase = Readonly<{
  fixture: CaseFixture;
  fixturePath: string;
  fixtureSha256: string;
  fixtureText: string;
  oracle: CaseOracle;
  oraclePath: string;
  oracleSha256: string;
  oracleText: string;
}>;

export const packRoot = path.resolve(import.meta.dirname, "..");
export const casesDirectory = path.join(packRoot, "cases");
export const oracleDirectory = path.join(packRoot, "oracle");

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function listCaseIds(directory: string = casesDirectory): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".fixture.json"))
    .map((name) => name.replace(/\.fixture\.json$/, ""))
    .sort();
}

/**
 * Loads only the model-visible half. The runner's request path uses this; it
 * must never need the oracle to drive a conversation.
 */
export function loadFixture(
  caseId: string,
  directory: string = casesDirectory,
): Readonly<{ fixture: CaseFixture; path: string; sha256: string; text: string }> {
  const fixturePath = path.join(directory, `${caseId}.fixture.json`);
  const text = readFileSync(fixturePath, "utf8");
  return {
    fixture: JSON.parse(text) as CaseFixture,
    path: fixturePath,
    sha256: sha256(text),
    text,
  };
}

export function loadCase(
  caseId: string,
  directories: Readonly<{ cases?: string; oracle?: string }> = {},
): LoadedCase {
  const fixture = loadFixture(caseId, directories.cases ?? casesDirectory);
  const oraclePath = path.join(
    directories.oracle ?? oracleDirectory,
    `${caseId}.oracle.json`,
  );
  const oracleText = readFileSync(oraclePath, "utf8");
  return {
    fixture: fixture.fixture,
    fixturePath: fixture.path,
    fixtureSha256: fixture.sha256,
    fixtureText: fixture.text,
    oracle: JSON.parse(oracleText) as CaseOracle,
    oraclePath,
    oracleSha256: sha256(oracleText),
    oracleText,
  };
}

export function sourceKeys(fixture: CaseFixture): string[] {
  return fixture.history.flatMap((turn) => [
    `${turn.key}:user`,
    `${turn.key}:assistant`,
  ]);
}

export function sourceText(fixture: CaseFixture, source: string): string | null {
  const [key, actor] = source.split(":");
  const turn = fixture.history.find((candidate) => candidate.key === key);
  if (!turn) return null;
  if (actor === "user") return turn.user;
  if (actor === "assistant") return turn.assistant;
  return null;
}

function isValidTimezone(zone: unknown): boolean {
  if (typeof zone !== "string" || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function isUtcInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Every string an oracle carries, for the independence scans. */
export function oracleStrings(oracle: CaseOracle): string[] {
  const strings: string[] = [];
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      // Structural references are identifiers, not expectation prose.
      if (key !== null && STRUCTURAL_ORACLE_KEYS.has(key)) return;
      strings.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(oracle, null);
  return strings;
}

const STRUCTURAL_ORACLE_KEYS = new Set([
  // A product Action kind is a public identifier that legitimately appears in
  // the tool definitions sent to the Provider.
  "actionKind",
  "eligibility",
  "inputs",
  "id",
  "kind",
  "language",
  "localDate",
  "logicalDate",
  "modes",
  "of",
  "owner",
  "ownerTickets",
  "schemaVersion",
  "sha256",
  "source",
  "sources",
  "spec",
  "step",
  "type",
  "version",
  "required",
  "forbidden",
]);

/** Shortest oracle string that is treated as leak-detectable prose. */
export const ORACLE_LEAK_MIN_LENGTH = 8;

const KNOWN_CHECK_TYPES = new Set([
  "turn_committed",
  "history_matches_stream",
  "outbound_includes",
  "outbound_excludes",
  "session_ownership",
  "no_commit_after_abort",
  "replaced_reply_never_shown",
  "stopped_at_deadline",
  "resend_is_idempotent",
  "usage_recorded",
  "outbound_includes_input",
  "action_admitted",
  "no_action",
  "unsupported",
  "date_coverage",
  "deadline",
]);

const FORBIDDEN_FIXTURE_KEYS = new Set([
  "title",
  "description",
  "expected",
  "expectation",
  "oracle",
  "answer",
  "capability",
  "topicCount",
  "criteria",
]);

/**
 * Structural, reference, timezone and independence validation. Returns every
 * problem found; an empty array means the case is safe to run. Nothing here
 * starts a model, a server or a database.
 */
export function validateCase(loaded: LoadedCase): string[] {
  const problems: string[] = [];
  const { fixture, oracle } = loaded;
  const fileId = path.basename(loaded.fixturePath).replace(/\.fixture\.json$/, "");

  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    problems.push(`fixture schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`);
  }
  if (oracle.schemaVersion !== ORACLE_SCHEMA_VERSION) {
    problems.push(`oracle schemaVersion must be ${ORACLE_SCHEMA_VERSION}`);
  }
  if (fixture.id !== fileId) problems.push(`fixture id ${fixture.id} does not match file ${fileId}`);
  if (oracle.id !== fixture.id) problems.push(`oracle id ${oracle.id} does not match fixture id ${fixture.id}`);
  if (fixture.stage !== "development" && fixture.stage !== "final") {
    problems.push("fixture stage must be development or final");
  }
  if (!["zh", "en", "code-switch"].includes(fixture.languageVariant)) {
    problems.push("fixture languageVariant must be zh, en or code-switch");
  }

  // The oracle is bound to exact fixture bytes: editing history after the
  // expectations were written is visible instead of silent.
  if (oracle.fixture?.sha256 !== loaded.fixtureSha256) {
    problems.push(
      `oracle is bound to fixture sha256 ${oracle.fixture?.sha256 ?? "(none)"} but the fixture is ${loaded.fixtureSha256}`,
    );
  }
  if (oracle.fixture?.version !== fixture.fixtureVersion) {
    problems.push(
      `oracle is bound to fixture version ${oracle.fixture?.version ?? "(none)"} but the fixture is ${fixture.fixtureVersion}`,
    );
  }

  // The model-visible half must not carry scenario names or expectations.
  const visitKeys = (value: unknown, trail: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitKeys(item, `${trail}[${index}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_FIXTURE_KEYS.has(key)) {
          problems.push(`fixture must not carry expectation field ${trail}.${key}`);
        }
        visitKeys(child, `${trail}.${key}`);
      }
    }
  };
  visitKeys(fixture, "fixture");

  if (!isValidTimezone(fixture.defaults?.timezone)) {
    problems.push("fixture defaults.timezone is not a valid IANA timezone");
  }
  if (typeof fixture.defaults?.locale !== "string" || !fixture.defaults.locale) {
    problems.push("fixture defaults.locale is required");
  }

  const turnKeys = new Set<string>();
  let previousInstant = Number.NEGATIVE_INFINITY;
  for (const turn of fixture.history ?? []) {
    if (!turn.key || !/^[a-z0-9][a-z0-9-]*$/.test(turn.key)) {
      problems.push(`history turn key ${JSON.stringify(turn.key)} must be lowercase alphanumeric with dashes`);
    }
    if (turnKeys.has(turn.key)) problems.push(`duplicate history turn key ${turn.key}`);
    turnKeys.add(turn.key);
    if (!isUtcInstant(turn.at)) {
      problems.push(`history turn ${turn.key} has an invalid UTC instant ${JSON.stringify(turn.at)}`);
    } else {
      const instant = Date.parse(turn.at);
      if (instant <= previousInstant) {
        problems.push(`history turn ${turn.key} is not strictly later than the previous turn`);
      }
      previousInstant = instant;
    }
    if (turn.timezone !== undefined && !isValidTimezone(turn.timezone)) {
      problems.push(`history turn ${turn.key} has an invalid IANA timezone ${JSON.stringify(turn.timezone)}`);
    }
    if (typeof turn.user !== "string" || !turn.user.trim()) {
      problems.push(`history turn ${turn.key} needs user text`);
    }
    if (typeof turn.assistant !== "string" || !turn.assistant.trim()) {
      problems.push(`history turn ${turn.key} needs the assistant reply that was given then`);
    }
  }

  const stepIds = new Set<string>();
  const sayStepIds = new Set<string>();
  const correctStepIds = new Set<string>();
  for (const step of fixture.steps ?? []) {
    if (!step.id || stepIds.has(step.id)) problems.push(`step id ${JSON.stringify(step.id)} is missing or duplicated`);
    if (turnKeys.has(step.id)) problems.push(`step id ${step.id} collides with a history turn key`);
    stepIds.add(step.id);
    if (!isUtcInstant(step.at)) {
      problems.push(`step ${step.id} has an invalid UTC instant ${JSON.stringify(step.at)}`);
    } else {
      const instant = Date.parse(step.at);
      if (instant < previousInstant) {
        problems.push(`step ${step.id} happens before the preceding history or step`);
      }
      previousInstant = Math.max(previousInstant, instant);
    }
    if (step.type === "say") {
      sayStepIds.add(step.id);
      if (typeof step.text !== "string" || !step.text.trim()) problems.push(`step ${step.id} needs text`);
      if (step.timezone !== undefined && !isValidTimezone(step.timezone)) {
        problems.push(`step ${step.id} has an invalid IANA timezone ${JSON.stringify(step.timezone)}`);
      }
    } else if (step.type === "resend") {
      if (!sayStepIds.has(step.of)) problems.push(`step ${step.id} resends unknown or later step ${step.of}`);
    } else if (step.type === "correct") {
      correctStepIds.add(step.id);
      if (!turnKeys.has(step.target)) problems.push(`step ${step.id} corrects unknown history turn ${step.target}`);
      if (typeof step.text !== "string" || !step.text.trim()) problems.push(`step ${step.id} needs the corrected text`);
    } else if (step.type !== "restart") {
      problems.push(`step ${(step as { id: string }).id} has an unknown type`);
    }
  }
  if (sayStepIds.size === 0) problems.push("fixture needs at least one say step");

  // Oracle references must resolve to real fixture sources and steps. A
  // ledger item may be grounded in seeded history (`<turn>:user`,
  // `<turn>:assistant`) or in what the person says during the run
  // (`<step>:input`); only seeded history can be an outbound source.
  const sources = new Set(sourceKeys(fixture));
  const groundings = new Set([
    ...sources,
    ...[...sayStepIds, ...correctStepIds].map((id) => `${id}:input`),
  ]);
  const factIds = new Set<string>();
  const checkSources = (
    owner: string,
    list: readonly string[] | undefined,
    allowed: ReadonlySet<string> = sources,
  ) => {
    for (const source of list ?? []) {
      if (!allowed.has(source)) problems.push(`${owner} references unknown source ${source}`);
    }
  };
  for (const [group, facts] of [
    ["facts.allowed", oracle.facts?.allowed],
    ["facts.forbidden", oracle.facts?.forbidden],
    ["topics", oracle.topics],
    ["time", oracle.time],
  ] as const) {
    for (const fact of facts ?? []) {
      if (!fact.id || factIds.has(fact.id)) problems.push(`${group} id ${JSON.stringify(fact.id)} is missing or duplicated`);
      factIds.add(fact.id);
      if (!fact.statement?.trim()) problems.push(`${group} ${fact.id} needs a statement`);
      checkSources(`${group} ${fact.id}`, fact.sources, groundings);
    }
  }
  for (const fact of [...(oracle.facts?.allowed ?? []), ...(oracle.topics ?? []), ...(oracle.time ?? [])]) {
    if ((fact.sources ?? []).length === 0) {
      problems.push(`${fact.id} must cite at least one fixture source: an expectation with no original-text basis cannot be reviewed`);
    }
  }
  const eligibility = new Map<string, string>();
  for (const entry of oracle.sourceEligibility ?? []) {
    if (!sources.has(entry.source)) problems.push(`sourceEligibility references unknown source ${entry.source}`);
    if (eligibility.has(entry.source)) problems.push(`sourceEligibility lists ${entry.source} twice`);
    eligibility.set(entry.source, entry.eligibility);
  }

  const criterionIds = new Set<string>();
  if ((oracle.criteria ?? []).length === 0) problems.push("oracle needs at least one criterion");
  for (const criterion of oracle.criteria ?? []) {
    if (!criterion.id || criterionIds.has(criterion.id)) {
      problems.push(`criterion id ${JSON.stringify(criterion.id)} is missing or duplicated`);
    }
    criterionIds.add(criterion.id);
    if (criterion.kind === "objective") {
      const check = criterion.check;
      if (!KNOWN_CHECK_TYPES.has(check?.type)) {
        problems.push(`criterion ${criterion.id} uses unknown check type ${JSON.stringify(check?.type)}`);
        continue;
      }
      if ((criterion.modes ?? []).length === 0) problems.push(`criterion ${criterion.id} must name at least one mode`);
      if ("step" in check && !stepIds.has(check.step)) {
        problems.push(`criterion ${criterion.id} references unknown step ${check.step}`);
      }
      if (check.type === "resend_is_idempotent" && !sayStepIds.has(check.of)) {
        problems.push(`criterion ${criterion.id} references unknown original step ${check.of}`);
      }
      if (check.type === "outbound_includes" || check.type === "outbound_excludes") {
        checkSources(`criterion ${criterion.id}`, check.sources);
        const required = check.type === "outbound_includes" ? "allowed" : "forbidden";
        for (const source of check.sources ?? []) {
          if (eligibility.get(source) !== required) {
            problems.push(
              `criterion ${criterion.id} treats ${source} as ${required} but sourceEligibility says ${eligibility.get(source) ?? "nothing"}`,
            );
          }
        }
      }
      if (check.type === "outbound_includes_input") {
        for (const id of check.inputs ?? []) {
          if (!sayStepIds.has(id) && !correctStepIds.has(id)) {
            problems.push(`criterion ${criterion.id} references unknown input step ${id}`);
          }
        }
      }
      if (check.type === "unsupported" && !check.capability?.trim()) {
        problems.push(`criterion ${criterion.id} must name the missing capability`);
      }
      if (check.type === "session_ownership") {
        checkSources(`criterion ${criterion.id}`, check.expect.map((entry) => entry.source));
      }
    } else if (criterion.kind === "semantic" || criterion.kind === "subjective") {
      if (!sayStepIds.has(criterion.step)) {
        problems.push(`criterion ${criterion.id} references unknown say step ${criterion.step}`);
      }
      for (const id of [...(criterion.required ?? []), ...(criterion.forbidden ?? [])]) {
        if (!factIds.has(id)) problems.push(`criterion ${criterion.id} references unknown ledger item ${id}`);
      }
      if ((criterion.required ?? []).length + (criterion.forbidden ?? []).length === 0) {
        problems.push(`criterion ${criterion.id} needs at least one ledger item to review`);
      }
    } else {
      problems.push(`criterion ${(criterion as { id: string }).id} has an unknown kind`);
    }
  }

  for (const precondition of oracle.preconditions ?? []) {
    const turns = fixture.history.filter(
      (turn) =>
        isUtcInstant(turn.at) &&
        localDateOf(new Date(turn.at), turn.timezone ?? fixture.defaults.timezone) ===
          precondition.localDate,
    );
    const messages = turns.length * 2;
    const userTokens = turns.reduce(
      (total, turn) => total + estimateRecentContextTokens(turn.user),
      0,
    );
    if (precondition.minMessages !== undefined && messages < precondition.minMessages) {
      problems.push(
        `precondition not met (${precondition.description}): ${precondition.localDate} has ${messages} messages, needs at least ${precondition.minMessages}`,
      );
    }
    if (
      precondition.minUserContextTokens !== undefined &&
      userTokens < precondition.minUserContextTokens
    ) {
      problems.push(
        `precondition not met (${precondition.description}): ${precondition.localDate} has ${userTokens} estimated user tokens, needs at least ${precondition.minUserContextTokens}`,
      );
    }
  }

  // Independence: expectation prose must not be recoverable from the inputs,
  // and scenario naming must not ride along in the model-visible half.
  const fixtureProse = [
    ...fixture.history.flatMap((turn) => [turn.user, turn.assistant]),
    ...fixture.steps.flatMap((step) =>
      step.type === "say" || step.type === "correct" ? [step.text] : [],
    ),
  ];
  for (const oracleString of oracleStrings(oracle)) {
    if (oracleString.length < ORACLE_LEAK_MIN_LENGTH) continue;
    if (fixtureProse.some((prose) => prose.includes(oracleString))) {
      problems.push(
        `oracle text ${JSON.stringify(oracleString.slice(0, 40))} appears verbatim in the fixture; expectations must be written independently of the inputs`,
      );
    }
  }

  return problems;
}

/** Suite-level rule: zh, en and code-switch must each be exercised. */
export function validateLanguageCoverage(cases: readonly LoadedCase[]): string[] {
  const seen = new Set(cases.map((loaded) => loaded.fixture.languageVariant));
  return (["zh", "en", "code-switch"] as const)
    .filter((variant) => !seen.has(variant))
    .map((variant) => `suite has no ${variant} case`);
}
