import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ACCEPTANCE_INACTIVITY_TIMEOUT_MS, repositoryRoot } from "./app-server";
import type { ChatObservation, HistoryMessage } from "./client";
import type { AcceptanceEnvironment } from "./environment";
// The runner drives a conversation from the model-visible fixture alone. It
// must never import the oracle loader: what the scorer knows cannot be allowed
// anywhere near the request path.
import type { CaseFixture, ProviderFaultSpec, RunMode } from "./fixture";
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
  return {
    attemptStatus: text(raw["attemptStatus"]),
    commandStatus: text(raw["commandStatus"]),
    compilerVersion: text(context["compilerVersion"]),
    dailySessionId: sessionId && UUID.test(sessionId) ? sessionId : null,
    dateCoverage: (Array.isArray(recent?.["perDate"]) ? recent["perDate"] : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        candidateRows: number(entry["candidateRows"]) ?? 0,
        empty: entry["empty"] === true,
        localDate: String(entry["localDate"]),
        readBounded: entry["readBounded"] === true,
      })),
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
  restart(id: string, at: Date): Promise<ObservedStep>;
  resend(id: string, of: string, at: Date): Promise<ObservedStep>;
  say(step: {
    abortAfterDeltas?: number;
    at: Date;
    id: string;
    locale?: string;
    providerFault?: ProviderFaultSpec;
    text: string;
    timezone?: string;
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

  async function inspect(
    generationCommandId: string | null,
    problems: string[],
  ): Promise<ObservedInspection | null> {
    if (!generationCommandId) return null;
    try {
      const inspection = summarizeInspection(await client.inspect(generationCommandId));
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
  const seedProviderStrings: string[] = [];
  for (const request of stub.requests().slice(seedRequestsBefore)) {
    collectStrings(request.body, seedProviderStrings);
  }
  // The seed is verified through the normal read API, not by trusting writes.
  const seed = { providerStrings: seedProviderStrings, readback: await readSessions(), turns: seedTurns };

  async function submit(
    id: string,
    type: "say" | "resend",
    at: Date,
    submission: {
      abortAfterDeltas?: number;
      clientEventId: string;
      clientTurnId: string;
      locale: string;
      providerFault?: Parameters<typeof stub.setFault>[0];
      text: string;
      timezone: string;
    },
  ): Promise<ObservedStep> {
    await arriveAt(at);
    stub.setStepLabel(id);
    stub.setFault(submission.providerFault ?? null);
    const problems: string[] = [];
    let chat: ChatObservation | null = null;
    try {
      chat = await client.chat({
        clientEventId: submission.clientEventId,
        clientTurnId: submission.clientTurnId,
        locale: submission.locale,
        text: submission.text,
        timezone: submission.timezone,
        ...(submission.abortAfterDeltas === undefined
          ? {}
          : { abortAfterDeltas: submission.abortAfterDeltas }),
      });
    } catch (error) {
      problems.push(`Chat request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chat?.clientAborted) {
      aborted = true;
      // Give a wrongly surviving generation the chance to commit late, so the
      // final history read can catch it.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    stub.setFault(null);
    stub.setStepLabel(null);
    const inspection = await inspect(chat?.generationCommandId ?? null, problems);
    const step: ObservedStep = {
      at: at.toISOString(),
      chat: chat
        ? {
            actions: chat.events
              .filter((entry) => entry.event["type"] === "action_admitted")
              .map((entry) => String(record(entry.event["receipt"])?.["actionKind"] ?? "unknown")),
            assistantRevisionId: eventField(chat, "assistant_committed", "revisionId"),
            clientAborted: chat.clientAborted,
            events: chat.events.map((entry) => ({
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
      input: {
        clientEventId: submission.clientEventId,
        clientTurnId: submission.clientTurnId,
        locale: submission.locale,
        text: submission.text,
        timezone: submission.timezone,
      },
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
          const messages = record(request.body)?.["input"];
          const last = Array.isArray(messages) ? record(messages.at(-1)) : null;
          return {
            conversationTurn:
              last?.["role"] === "user" && last["content"] === submission.text,
            sequence: request.sequence,
            strings,
          };
        }),
      type,
    };
    steps.push(step);
    input.onStep?.(step);
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
    async finish() {
      if (aborted) await new Promise((resolve) => setTimeout(resolve, 500));
      const identity = gitIdentity();
      const backgroundProviderStrings: string[] = [];
      for (const request of stub.requests().slice(seedRequestsBefore)) {
        if (request.stepLabel === null) collectStrings(request.body, backgroundProviderStrings);
      }
      return {
        backgroundProviderStrings,
        caseId: fixture.id,
        environmentErrors: [],
        finalHistory: await readSessions(),
        identity: {
          fixtureSha256: input.fixtureSha256,
          fixtureVersion: fixture.fixtureVersion,
          gitCommit: identity.commit,
          gitDirty: identity.dirty,
          model: environment.model,
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
        ...(step.providerFault ? { providerFault: step.providerFault } : {}),
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
      ...(step.locale ? { locale: step.locale } : {}),
      ...(step.providerFault ? { providerFault: step.providerFault } : {}),
      ...(step.timezone ? { timezone: step.timezone } : {}),
    });
  }
  if (step.type === "resend") return session.resend(step.id, step.of, at);
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
