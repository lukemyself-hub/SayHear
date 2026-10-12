import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ACCEPTANCE_INACTIVITY_TIMEOUT_MS, repositoryRoot } from "./app-server";
import type { ChatObservation, HistoryMessage } from "./client";
import type { AcceptanceEnvironment } from "./environment";
// The runner drives a conversation from the model-visible fixture alone. It
// must never import the oracle loader: what the scorer knows cannot be allowed
// anywhere near the request path.
import type {
  CaseFixture,
  HistoryReviewScript,
  ProviderFaultSpec,
  RunMode,
  ToolCallScript,
} from "./fixture";
import {
  OBSERVATION_SCHEMA_VERSION,
  type CaseObservation,
  type ObservedInspection,
  type ObservedSeedTurn,
  type ObservedSession,
  type ObservedStep,
} from "./observation";

/**
 * Loads a fixture's history through the real chat route, then plays its
 * follow-up steps and records what happened (T00 #313).
 *
 * History is not inserted with SQL. Each past exchange is submitted over HTTP
 * at its own controlled instant, with the Provider stub replaying the reply
 * the fixture says was given then. Events, revisions, Daily Session ownership
 * and request timezones are therefore whatever the product's own write path
 * produces — and stay correct as later tickets add state at commit time. The
 * loader prepares inputs only: it never writes a retrieval result, a Context
 * or an answer.
 */

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) collectStrings(child, into);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Coverage of the controlled history review as date entries. A date inside a
 * completely enumerated range that holds no message is empty and unbounded; a
 * date of an unfinished or trimmed read is bounded.
 */
function historyDateCoverage(
  history: Record<string, unknown> | null,
): ObservedInspection["dateCoverage"] {
  const coverage = record(history?.["coverage"]);
  const plan = record(history?.["plan"]);
  if (!coverage || !plan) return [];
  // An experience search (#316) reads no itemized dates; its coverage is the
  // scan, not a calendar range, so it contributes no date entries.
  if (plan["kind"] === "search_experience") return [];
  const listed = (Array.isArray(coverage["perDate"]) ? coverage["perDate"] : [])
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const entries = new Map<string, ObservedInspection["dateCoverage"][number]>();
  for (const entry of listed) {
    const state = String(entry["state"]);
    entries.set(String(entry["localDate"]), {
      candidateRows: number(entry["enumeratedRows"]) ?? 0,
      empty: state === "empty",
      localDate: String(entry["localDate"]),
      readBounded: state === "partial" || state === "unread",
    });
  }
  if (coverage["enumerationComplete"] === true) {
    const start = String(plan["readStartDate"] ?? plan["startDate"]);
    const end = String(plan["readEndDate"] ?? plan["endDate"]);
    let day = start;
    for (let guard = 0; day <= end && guard < 400; guard += 1) {
      if (!entries.has(day)) {
        entries.set(day, { candidateRows: 0, empty: true, localDate: day, readBounded: false });
      }
      day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  }
  return [...entries.values()];
}

/** Reduce the controlled Inspector's answer to the fields the checks use. */
export function summarizeInspection(raw: Record<string, unknown>): ObservedInspection {
  const context = record(raw["compiledContext"]) ?? {};
  const recent = record(context["recentContext"]);
  const sections = Array.isArray(context["sections"]) ? context["sections"] : [];
  const dailySession = sections
    .map(record)
    .find((section) => section?.["key"] === "daily_session");
  const sessionId = text(dailySession?.["reference"])?.split(":")[0] ?? null;
  const failure = record(recent?.["failure"]);
  const history = record(raw["historyRecall"]);
  const historyPlan = record(history?.["plan"]);
  const turn = record(raw["turn"]);
  return {
    providerRequestId: text(raw["providerRequestId"]),
    turn: turn
      ? {
          assistantEventCommitted: turn["assistantEventCommitted"] === true,
          commands: (Array.isArray(turn["commands"]) ? turn["commands"] : [])
            .map(record)
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .map((entry) => ({
              egressDisposition: text(entry["egressDisposition"]),
              errorCategory: text(entry["errorCategory"]),
              providerRequestId: text(entry["providerRequestId"]),
              stage: String(entry["stage"]),
            })),
          finalDisposition: String(turn["finalDisposition"]),
        }
      : null,
    generationStage: text(raw["generationStage"]),
    historyRecall: history
      ? {
          answerCommandId: String(history["answerCommandId"]),
          decisionCommandId: String(history["decisionCommandId"]),
          enumerationComplete:
            typeof record(history["coverage"])?.["enumerationComplete"] === "boolean"
              ? (record(history["coverage"])!["enumerationComplete"] as boolean)
              : null,
          failureCode: text(history["failureCode"]),
          omitted: Object.fromEntries(
            Object.entries(record(record(history["coverage"])?.["omitted"]) ?? {}).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          ),
          searchOutcome: text(record(record(history["coverage"])?.["search"])?.["outcome"]),
          sourceRevisionIds: (Array.isArray(history["sources"]) ? history["sources"] : [])
            .map((entry) => text(record(entry)?.["revisionId"]))
            .filter((entry): entry is string => entry !== null),
          planDates: historyPlan
            ? `${String(historyPlan["startDate"])}..${String(historyPlan["endDate"])} ${String(historyPlan["timezone"])}`
            : null,
          policyVersion: String(history["policyVersion"]),
          role: String(history["role"]),
          sourceCount: Array.isArray(history["sources"]) ? history["sources"].length : 0,
          status: String(history["status"]),
        }
      : null,
    attemptStatus: text(raw["attemptStatus"]),
    commandStatus: text(raw["commandStatus"]),
    compilerVersion: text(context["compilerVersion"]),
    dailySessionId: sessionId && UUID.test(sessionId) ? sessionId : null,
    dateCoverage: [
      ...historyDateCoverage(history),
      ...(Array.isArray(recent?.["perDate"]) ? recent["perDate"] : [])
        .map(record)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          candidateRows: number(entry["candidateRows"]) ?? 0,
          empty: entry["empty"] === true,
          localDate: String(entry["localDate"]),
          readBounded: entry["readBounded"] === true,
        })),
    ],
    inputTokens: number(raw["inputTokens"]),
    outputTokens: number(raw["outputTokens"]),
    providerLatencyMs: number(raw["providerLatencyMs"]),
    recentContextFailure: failure ? JSON.stringify(failure) : null,
    recentContextWindow: recent
      ? {
          end: String(recent["windowEndLocalDate"]),
          start: String(recent["windowStartLocalDate"]),
        }
      : null,
    referencedEvents: (Array.isArray(context["referencedEvents"]) ? context["referencedEvents"] : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        actor: String(entry["actor"]),
        expressedAt: text(entry["expressedAt"]),
        revisionId: String(entry["revisionId"]),
        section: String(entry["section"]),
      })),
  };
}

function eventField(chat: ChatObservation, type: string, ...trail: string[]): string | null {
  const event = chat.events.find((candidate) => candidate.event["type"] === type)?.event;
  let cursor: unknown = event;
  for (const key of trail) cursor = record(cursor)?.[key];
  return text(cursor);
}

function toSession(dailySessionId: string, messages: readonly HistoryMessage[]): ObservedSession {
  const ordered = [...messages].sort(
    (left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
  );
  return {
    dailySessionId,
    logicalDate: text(ordered[0]?.["logicalDate"]),
    messages: ordered.map((message) => ({
      actor: message.actor,
      createdAt: text(message.createdAt),
      id: text(message["eventId"]),
      sequence: number(message.sequence),
      text: message.text,
    })),
  };
}

export function gitIdentity(): { commit: string; dirty: boolean } {
  try {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repositoryRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { commit: run("rev-parse", "HEAD"), dirty: run("status", "--porcelain").length > 0 };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

export type RunCaseInput = Readonly<{
  environment: AcceptanceEnvironment;
  fixture: CaseFixture;
  fixtureSha256: string;
  /** An interactive session: unplayed steps are `not-run`, not an error. */
  interactive?: boolean;
  mode: RunMode;
  /** Called after each observed step; the interactive chat prints from it. */
  onStep?: (step: ObservedStep) => void;
}>;

/** A live conversation over one seeded case; `runCase` and `chat` share it. */
export type CaseSession = Readonly<{
  correct(
    id: string,
    target: string,
    at: Date,
    corrected: { locale?: string; text: string },
  ): Promise<ObservedStep>;
  finish(): Promise<CaseObservation>;
  forget(id: string, targets: readonly string[], at: Date): Promise<ObservedStep>;
  restart(id: string, at: Date): Promise<ObservedStep>;
  resend(id: string, of: string, at: Date): Promise<ObservedStep>;
  say(step: {
    abortAfterDeltas?: number;
    abortAfterMs?: number;
    at: Date;
    continueInBackground?: boolean;
    id: string;
    historyReview?: HistoryReviewScript;
    locale?: string;
    providerFault?: ProviderFaultSpec;
    text: string;
    timezone?: string;
    toolCall?: ToolCallScript;
  }): Promise<ObservedStep>;
  seed: CaseObservation["seed"];
}>;

export async function openCaseSession(input: RunCaseInput): Promise<CaseSession> {
  const { environment, fixture } = input;
  const { client, stub } = environment;
  const sessionIds = new Set<string>();
  const steps: ObservedStep[] = [];
  let aborted = false;

  // Seeding is destructive to this schema's baseline: prove ownership first.
  await environment.assertOwned();
  const recentContextGovernance = await environment.enableRecentContext();
  const historyRecallGovernance = await environment.enableHistoryRecall();

  async function inspect(
    generationCommandId: string | null,
    problems: string[],
  ): Promise<ObservedInspection | null> {
    if (!generationCommandId) return null;
    try {
      let inspection = summarizeInspection(await client.inspect(generationCommandId));
      // A Decision that took the history review branch did not produce the
      // reply: the independent History Answer command did. Follow the link so
      // the sources the answer was actually compiled from are what is judged.
      if (inspection.historyRecall?.role === "decision") {
        const answer = summarizeInspection(
          await client.inspect(inspection.historyRecall.answerCommandId),
        );
        inspection = { ...answer, historyRecall: inspection.historyRecall };
      }
      if (inspection.dailySessionId) sessionIds.add(inspection.dailySessionId);
      return inspection;
    } catch (error) {
      problems.push(`Inspector read failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function readSessions(): Promise<ObservedSession[]> {
    const sessions: ObservedSession[] = [];
    for (const dailySessionId of sessionIds) {
      sessions.push(toSession(dailySessionId, await client.messages(dailySessionId)));
    }
    return sessions.sort((left, right) =>
      String(left.logicalDate).localeCompare(String(right.logicalDate)),
    );
  }

  // Idle time passes for the product only when its scheduled scan runs. When
  // controlled time jumps past the inactivity timeout, the runner triggers
  // that same scan, exactly as production's Cron would have in between. A gap
  // shorter than the timeout runs no scan, so a conversation that crosses
  // midnight stays in one Daily Session, as it does for a real person.
  const scheduledScans: Array<{ at: string; result: Readonly<Record<string, unknown>> }> = [];
  let lastActivityMs: number | null = null;
  async function arriveAt(at: Date): Promise<void> {
    environment.setNow(at);
    if (
      lastActivityMs !== null &&
      at.getTime() - lastActivityMs > ACCEPTANCE_INACTIVITY_TIMEOUT_MS
    ) {
      scheduledScans.push({
        at: at.toISOString(),
        result: await environment.runScheduledScan(),
      });
      // The scan dispatches background model roles asynchronously. Let them
      // reach the Provider before the next turn starts, so they are recorded
      // as background egress instead of bleeding into that turn.
      let seen = stub.requests().length;
      for (let quiet = 0, waited = 0; quiet < 4 && waited < 40; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = stub.requests().length;
        quiet = now === seen ? quiet + 1 : 0;
        seen = now;
      }
    }
    lastActivityMs = at.getTime();
  }

  // --- load history through the real write path ---------------------------
  const seedTurns: ObservedSeedTurn[] = [];
  const seedRequestsBefore = stub.requests().length;
  for (const turn of fixture.history) {
    await arriveAt(new Date(turn.at));
    stub.setStepLabel(`seed:${turn.key}`);
    stub.setHistoricalReply(turn.assistant);
    const chat = await client.chat({
      clientEventId: `${fixture.id}-${turn.key}-event`,
      clientTurnId: `${fixture.id}-${turn.key}-turn`,
      locale: turn.locale ?? fixture.defaults.locale,
      text: turn.user,
      timezone: turn.timezone ?? fixture.defaults.timezone,
    });
    const problems: string[] = [];
    const inspection = await inspect(chat.generationCommandId, problems);
    if (turn.legacyMissingTimezone && chat.generationCommandId) {
      await environment.clearRequestTimezone(chat.generationCommandId);
    }
    seedTurns.push({
      assistantRevisionId: eventField(chat, "assistant_committed", "revisionId"),
      at: turn.at,
      dailySessionId: inspection?.dailySessionId ?? null,
      key: turn.key,
      terminalEvent: chat.terminalEvent,
      userEventId: eventField(chat, "user_committed", "message", "id"),
      userRevisionId: eventField(chat, "user_committed", "message", "revisionId"),
    });
  }
  stub.setHistoricalReply(null);
  stub.setStepLabel(null);
  // Seeding is over. In a live run everything from here on is answered by the
  // real Provider; in a rehearsal it stays local.
  environment.gate?.setLive(environment.live);
  const seedProviderStrings: string[] = [];
  for (const request of stub.requests().slice(seedRequestsBefore)) {
    collectStrings(request.body, seedProviderStrings);
  }
  // The seed is verified through the normal read API, not by trusting writes.
  const seed = { providerStrings: seedProviderStrings, readback: await readSessions(), turns: seedTurns };

  // Requests the person left running while they kept typing (#319). Each entry
  // settles one background step into its final observation.
  const pendingBackground: Array<() => Promise<void>> = [];
  async function settleBackground(): Promise<void> {
    while (pendingBackground.length > 0) {
      await pendingBackground.shift()!();
    }
  }

  async function submit(
    id: string,
    type: "say" | "resend",
    at: Date,
    submission: {
      abortAfterDeltas?: number;
      abortAfterMs?: number;
      background?: boolean;
      clientEventId: string;
      clientTurnId: string;
      locale: string;
      historyReview?: HistoryReviewScript;
      providerFault?: Parameters<typeof stub.setFault>[0];
      text: string;
      timezone: string;
      toolCall?: ToolCallScript;
    },
  ): Promise<ObservedStep> {
    await arriveAt(at);
    const requestsBeforeStep = stub.requests().length;
    stub.setStepLabel(id);
    stub.setFault(submission.providerFault ?? null);
    stub.setHistoryReview(submission.historyReview ?? null);
    stub.setToolCall(submission.toolCall ?? null);
    const problems: string[] = [];
    const chatPromise: Promise<ChatObservation | null> = client
      .chat({
        clientEventId: submission.clientEventId,
        clientTurnId: submission.clientTurnId,
        locale: submission.locale,
        text: submission.text,
        timezone: submission.timezone,
        ...(submission.abortAfterDeltas === undefined
          ? {}
          : { abortAfterDeltas: submission.abortAfterDeltas }),
        ...(submission.abortAfterMs === undefined ? {} : { abortAfterMs: submission.abortAfterMs }),
      })
      .catch((error) => {
        problems.push(`Chat request failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });

    const stepInput = {
      clientEventId: submission.clientEventId,
      clientTurnId: submission.clientTurnId,
      locale: submission.locale,
      text: submission.text,
      timezone: submission.timezone,
    };
    async function finalize(chat: ChatObservation | null): Promise<ObservedStep> {
      // Every live Provider answer for this step has been copied to the run.
      await environment.gate?.settled();
      if (chat?.clientAborted) {
        aborted = true;
        // Give a wrongly surviving generation the chance to commit late, so the
        // final history read can catch it.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      const inspection = await inspect(chat?.generationCommandId ?? null, problems);
      return {
        at: at.toISOString(),
        chat: chat
          ? {
              actions: chat.events
                .filter((entry) => entry.event["type"] === "action_admitted")
                .map((entry) => String(record(entry.event["receipt"])?.["actionKind"] ?? "unknown")),
              assistantRevisionId: eventField(chat, "assistant_committed", "revisionId"),
              clientAborted: chat.clientAborted,
              events: chat.events.map((entry) => ({
                category: text(entry.event["category"]),
                delta: text(entry.event["delta"]),
                elapsedMs: Math.round(entry.elapsedMs * 10) / 10,
                type: String(entry.event["type"]),
              })),
              generationCommandId: chat.generationCommandId,
              httpStatus: chat.httpStatus,
              streamedText: chat.streamedText,
              terminalEvent: chat.terminalEvent,
              timing: chat.timing,
              userMessageId: eventField(chat, "user_committed", "message", "id"),
              userRevisionId: eventField(chat, "user_committed", "message", "revisionId"),
            }
          : null,
        id,
        input: stepInput,
        inspection,
        problems,
        providerRequests: stub
          .requests()
          // Only this session's requests: after a reset the same step ids recur.
          .slice(seedRequestsBefore)
          .filter((request) => request.stepLabel === id)
          .map((request) => {
            const strings: string[] = [];
            collectStrings(request.body, strings);
            // The stub speaks the Responses API; the gate records the Chat
            // Completions request the OpenCode Go adapter built (T08 #321).
            const viaGate = environment.gate
              ?.requests()
              .find((candidate) => candidate.sequence === request.sequence);
            const input = record(request.body)?.["input"];
            const messages = viaGate
              ? viaGate.messages
              : (Array.isArray(input) ? input : [])
                  .map(record)
                  .filter((entry): entry is Record<string, unknown> => entry !== null)
                  .map((entry) => ({
                    role: String(entry["role"]),
                    text:
                      typeof entry["content"] === "string"
                        ? entry["content"]
                        : JSON.stringify(entry["content"]),
                  }));
            const tools = record(request.body)?.["tools"];
            const lastUser = messages.findLast((message) => message.role === "user");
            return {
              // The turn's own generation: the newest thing the person said in
              // the request is this turn's text. (A continuation after a tool
              // call appends assistant and tool messages after it.)
              conversationTurn: viaGate
                ? lastUser?.text === submission.text
                : messages.at(-1)?.role === "user" && messages.at(-1)?.text === submission.text,
              instructions: viaGate
                ? viaGate.instructions
                : (text(record(request.body)?.["instructions"]) ?? ""),
              messages,
              providerResponseId:
                viaGate?.response?.providerRequestId ??
                (viaGate ? `gate-request-${request.sequence}` : `stub-request-${request.sequence}`),
              ...(viaGate ? { response: viaGate.response, transport: viaGate.transport } : {}),
              sequence: request.sequence,
              strings,
              toolsOffered: viaGate
                ? viaGate.toolsOffered
                : (Array.isArray(tools) ? tools : [])
                    .map((tool) => text(record(tool)?.["name"]))
                    .filter((entry): entry is string => entry !== null),
            };
          }),
        type,
      };
    }

    if (submission.background) {
      // Wait until the request has reached the Provider, so the fault and the
      // label this step set belong to it and not to the next step.
      for (
        let waited = 0;
        stub.requests().length === requestsBeforeStep && waited < 5_000;
        waited += 50
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stub.setFault(null);
      stub.setHistoryReview(null);
      stub.setToolCall(null);
      stub.setStepLabel(null);
      const placeholder: ObservedStep = {
        at: at.toISOString(),
        chat: null,
        id,
        input: stepInput,
        inspection: null,
        problems,
        providerRequests: [],
        type,
      };
      const index = steps.push(placeholder) - 1;
      pendingBackground.push(async () => {
        const settled = await finalize(await chatPromise);
        steps[index] = settled;
        input.onStep?.(settled);
      });
      return placeholder;
    }

    const chat = await chatPromise;
    stub.setFault(null);
    stub.setHistoryReview(null);
    stub.setToolCall(null);
    stub.setStepLabel(null);
    const step = await finalize(chat);
    steps.push(step);
    input.onStep?.(step);
    await settleBackground();
    return step;
  }

  return {
    async correct(id, target, at, corrected) {
      await arriveAt(at);
      const problems: string[] = [];
      const locale = corrected.locale ?? fixture.defaults.locale;
      const eventId = seedTurns.find((turn) => turn.key === target)?.userEventId ?? null;
      if (!eventId) {
        problems.push(`History turn ${target} has no committed user event to correct.`);
      } else {
        const result = await client.correct({ eventId, locale, text: corrected.text });
        if (result.httpStatus !== 200) {
          problems.push(`Correction route answered HTTP ${result.httpStatus}.`);
        }
      }
      const step: ObservedStep = {
        at: at.toISOString(),
        chat: null,
        id,
        input: {
          clientEventId: "",
          clientTurnId: "",
          locale,
          text: corrected.text,
          timezone: fixture.defaults.timezone,
        },
        inspection: null,
        problems,
        providerRequests: [],
        type: "correct",
      };
      steps.push(step);
      input.onStep?.(step);
      return step;
    },
    async forget(id, targets, at) {
      await arriveAt(at);
      const problems: string[] = [];
      const revisionIds = targets.map(
        (key) => seedTurns.find((turn) => turn.key === key)?.userRevisionId ?? null,
      );
      if (revisionIds.some((revisionId) => revisionId === null)) {
        problems.push("A forgotten history turn has no committed user revision.");
      } else {
        await environment.seedForget(revisionIds as string[], at);
      }
      const step: ObservedStep = {
        at: at.toISOString(),
        chat: null,
        id,
        input: null,
        inspection: null,
        problems,
        providerRequests: [],
        type: "forget",
      };
      steps.push(step);
      input.onStep?.(step);
      return step;
    },
    async finish() {
      await settleBackground();
      if (aborted) await new Promise((resolve) => setTimeout(resolve, 500));
      const identity = gitIdentity();
      const backgroundProviderStrings: string[] = [];
      for (const request of stub.requests().slice(seedRequestsBefore)) {
        if (request.stepLabel === null) collectStrings(request.body, backgroundProviderStrings);
      }
      await environment.gate?.settled();
      const backgroundRequests = environment.gate
        ?.requests()
        .slice(seedRequestsBefore)
        .filter((request) => request.stepLabel === null)
        .map((request) => ({
          instructionsStart: request.instructions.slice(0, 160),
          response: request.response,
          sequence: request.sequence,
          transport: request.transport,
        }));
      return {
        backgroundProviderStrings,
        ...(backgroundRequests ? { backgroundRequests } : {}),
        caseId: fixture.id,
        environmentErrors: [],
        finalHistory: await readSessions(),
        identity: {
          fixtureSha256: input.fixtureSha256,
          fixtureVersion: fixture.fixtureVersion,
          gitCommit: identity.commit,
          gitDirty: identity.dirty,
          model: environment.model,
          historyRecallGovernance,
          recentContextGovernance,
          runId: environment.runId,
        },
        ...(input.interactive ? { interactive: true } : {}),
        mode: input.mode,
        scheduledScans,
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        seed,
        steps,
      };
    },
    resend(id, of, at) {
      const original = steps.find((step) => step.id === of);
      if (!original?.input) throw new Error(`Cannot resend ${of}: it was never submitted.`);
      return submit(id, "resend", at, original.input);
    },
    async restart(id, at) {
      await arriveAt(at);
      await environment.restartApp();
      const step: ObservedStep = {
        at: at.toISOString(),
        chat: null,
        id,
        input: null,
        inspection: null,
        problems: [],
        providerRequests: [],
        type: "restart",
      };
      steps.push(step);
      input.onStep?.(step);
      return step;
    },
    say(step) {
      return submit(step.id, "say", step.at, {
        clientEventId: `${fixture.id}-${step.id}-event`,
        clientTurnId: `${fixture.id}-${step.id}-turn`,
        locale: step.locale ?? fixture.defaults.locale,
        text: step.text,
        timezone: step.timezone ?? fixture.defaults.timezone,
        ...(step.abortAfterDeltas === undefined ? {} : { abortAfterDeltas: step.abortAfterDeltas }),
        ...(step.abortAfterMs === undefined ? {} : { abortAfterMs: step.abortAfterMs }),
        ...(step.continueInBackground ? { background: true } : {}),
        ...(step.providerFault ? { providerFault: step.providerFault } : {}),
        ...(step.historyReview ? { historyReview: step.historyReview } : {}),
        ...(step.toolCall ? { toolCall: step.toolCall } : {}),
      });
    },
    seed,
  };
}

/** Play one scripted fixture step in an open session. */
export function playStep(
  session: CaseSession,
  step: CaseFixture["steps"][number],
): Promise<ObservedStep> {
  const at = new Date(step.at);
  if (step.type === "say") {
    return session.say({
      at,
      id: step.id,
      text: step.text,
      ...(step.abortAfterDeltas === undefined ? {} : { abortAfterDeltas: step.abortAfterDeltas }),
      ...(step.abortAfterMs === undefined ? {} : { abortAfterMs: step.abortAfterMs }),
      ...(step.continueInBackground ? { continueInBackground: true } : {}),
      ...(step.locale ? { locale: step.locale } : {}),
      ...(step.providerFault ? { providerFault: step.providerFault } : {}),
      ...(step.historyReview ? { historyReview: step.historyReview } : {}),
      ...(step.toolCall ? { toolCall: step.toolCall } : {}),
      ...(step.timezone ? { timezone: step.timezone } : {}),
    });
  }
  if (step.type === "resend") return session.resend(step.id, step.of, at);
  if (step.type === "forget") return session.forget(step.id, step.targets, at);
  if (step.type === "correct") {
    return session.correct(step.id, step.target, at, {
      text: step.text,
      ...(step.locale ? { locale: step.locale } : {}),
    });
  }
  return session.restart(step.id, at);
}

/** Run a fixture's scripted steps end to end and return the observation. */
export async function runCase(input: RunCaseInput): Promise<CaseObservation> {
  const session = await openCaseSession(input);
  for (const step of input.fixture.steps) await playStep(session, step);
  return session.finish();
}

/**
 * Digest of everything a rerun must reproduce: what was said, what came back,
 * how each turn ended, which seeded sources reached the Provider, and where
 * each message was filed. Generated identifiers and wall-clock timings are
 * excluded, so two runs from a reset baseline compare equal exactly when the
 * observable behaviour was the same.
 */
export function reproducibilityDigest(
  observation: CaseObservation,
  fixture: CaseFixture,
): string {
  const sessions = (list: readonly ObservedSession[]) =>
    list.map((session) => ({
      logicalDate: session.logicalDate,
      messages: session.messages.map((message) => ({
        actor: message.actor,
        createdAt: message.createdAt,
        sequence: message.sequence,
        text: message.text,
      })),
    }));
  const sourcesSeen = (step: ObservedStep) => {
    const strings = step.providerRequests
      .filter((request) => request.conversationTurn)
      .flatMap((request) => request.strings);
    return fixture.history.flatMap((turn) => [
      ...(strings.some((value) => value.includes(turn.user)) ? [`${turn.key}:user`] : []),
      ...(strings.some((value) => value.includes(turn.assistant)) ? [`${turn.key}:assistant`] : []),
    ]);
  };
  const normalized = {
    caseId: observation.caseId,
    finalHistory: sessions(observation.finalHistory),
    mode: observation.mode,
    seed: sessions(observation.seed.readback),
    steps: observation.steps.map((step) => ({
      at: step.at,
      clientAborted: step.chat?.clientAborted ?? null,
      coverage: step.inspection?.dateCoverage ?? null,
      id: step.id,
      providerRequestCount: step.providerRequests.filter((request) => request.conversationTurn).length,
      sourcesSeen: sourcesSeen(step),
      // A cancelled stream may be cut at slightly different points.
      streamedText: step.chat?.clientAborted ? null : (step.chat?.streamedText ?? null),
      terminalEvent: step.chat?.terminalEvent ?? null,
      type: step.type,
    })),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
