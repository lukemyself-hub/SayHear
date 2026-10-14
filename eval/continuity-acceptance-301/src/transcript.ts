import type { CaseObservation, ObservedStep } from "./observation";

/**
 * A readable account of one real-model run (T08 #321): what the person said,
 * what came back and when, and what the model itself did at the Provider —
 * whether it asked for a history review, with which dates or search clues,
 * how long it reasoned, and what it was charged. It is derived from the
 * stored observation only; it adds no judgement.
 */

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}… (${flat.length} chars)` : flat;
}

export type StepTiming = Readonly<{
  appState: "cold-app" | "warm";
  caseId: string;
  committedMs: number | null;
  firstVisibleTextMs: number | null;
  /** `ordinary` reply, `history` review answer, or a turn with a Trust Action. */
  kind: "ordinary" | "history" | "trust-action";
  liveRequests: number;
  outcome: string;
  outputTokens: number;
  reasoningTokens: number;
  runId: string;
  stepId: string;
  streamClosedMs: number | null;
  withinContract: boolean;
}>;

/**
 * Latency acceptance (ADR-0152, 2026-10-12 revision): a turn is inside the
 * limit when its reply is committed within 15 seconds, and a run passes when
 * at least 90% of the turns sent to the real Provider are. A turn that never
 * committed is outside.
 */
export const COMMIT_LIMIT_MS = 15_000;
export const LATENCY_PASS_SHARE = 0.9;

/** One row per turn the real Provider answered: the formal latency samples. */
export function stepTimings(observation: CaseObservation): StepTiming[] {
  const rows: StepTiming[] = [];
  let previousWasRestart = false;
  for (const step of observation.steps) {
    if (step.type === "restart") {
      previousWasRestart = true;
      continue;
    }
    const own = step.providerRequests.filter((request) => request.conversationTurn);
    const live = step.providerRequests.filter((request) => request.transport === "live");
    if (step.chat && step.type === "say" && own.length > 0 && own.every((request) => request.transport === "live")) {
      const first = step.chat.timing.firstVisibleTextMs;
      const committed = step.chat.timing.committedMs;
      rows.push({
        appState: previousWasRestart ? "cold-app" : "warm",
        caseId: observation.caseId,
        committedMs: committed,
        firstVisibleTextMs: first,
        kind:
          step.chat.actions.length > 0
            ? "trust-action"
            : step.inspection?.historyRecall
              ? "history"
              : "ordinary",
        liveRequests: live.length,
        outcome: step.chat.clientAborted
          ? "client-aborted"
          : (step.chat.terminalEvent ?? "no terminal event"),
        outputTokens: live.reduce((total, request) => total + (request.response?.usage?.outputTokens ?? 0), 0),
        reasoningTokens: live.reduce(
          (total, request) => total + (request.response?.usage?.reasoningTokens ?? 0),
          0,
        ),
        runId: observation.identity.runId,
        stepId: step.id,
        streamClosedMs: step.chat.timing.streamClosedMs,
        withinContract: committed !== null && committed <= COMMIT_LIMIT_MS,
      });
    }
    if (step.type === "say" || step.type === "resend") previousWasRestart = false;
  }
  return rows;
}

function renderStep(step: ObservedStep): string[] {
  const lines: string[] = [`### ${step.id} (${step.type}) at ${step.at}`, ""];
  if (step.input?.text) lines.push(`**Person:** ${step.input.text}`, "");
  if (step.chat) {
    const chat = step.chat;
    lines.push(
      `**SayHear** (${chat.clientAborted ? "client aborted" : (chat.terminalEvent ?? "no terminal event")}; first text ${ms(chat.timing.firstVisibleTextMs)}, committed ${ms(chat.timing.committedMs)}, stream closed ${ms(chat.timing.streamClosedMs)}; CLI network timing):`,
      "",
      chat.streamedText ? `> ${chat.streamedText.replace(/\n/g, "\n> ")}` : "> (no text)",
      "",
    );
    if (chat.actions.length > 0) lines.push(`Actions admitted: ${chat.actions.join(", ")}`, "");
    const failure = chat.events.find((event) => event.category);
    if (failure) lines.push(`Stream failure: ${failure.type} / ${failure.category}`, "");
  }
  const recall = step.inspection?.historyRecall;
  if (recall) {
    lines.push(
      `History review: status ${recall.status}, plan ${recall.planDates ?? "(search)"}, search outcome ${recall.searchOutcome ?? "—"}, sources ${recall.sourceCount}, failure ${recall.failureCode ?? "none"}`,
      "",
    );
  }
  for (const request of step.providerRequests) {
    const response = request.response;
    lines.push(
      `- Provider request #${request.sequence}: ${request.transport ?? "stub"}${request.conversationTurn ? ", this turn" : ", other role"}; tools offered: ${request.toolsOffered?.join(", ") || "none"}`,
    );
    if (response) {
      lines.push(
        `  - HTTP ${response.status ?? "—"}, ${response.outcome}, finish ${response.finishReason ?? "—"}; sent ${ms(response.sentMs)}, first byte ${ms(response.firstByteMs)}, first reasoning ${ms(response.firstReasoningMs)}, first answer text ${ms(response.firstContentMs)}, ended ${ms(response.endedMs)} (app clock, from the adapter's fetch)`,
        `  - usage: in ${response.usage?.inputTokens ?? "unknown"}, out ${response.usage?.outputTokens ?? "unknown"} (reasoning ${response.usage?.reasoningTokens ?? "unknown"}), cached ${response.usage?.cachedTokens ?? "unknown"}`,
      );
      for (const call of response.toolCalls) {
        lines.push(`  - model called \`${call.name}\` with \`${call.arguments}\``);
      }
      if (response.reasoning) {
        lines.push(`  - reasoning (${response.reasoning.length} chars, discarded by the product): ${clip(response.reasoning, 600)}`);
      }
    }
  }
  if (step.problems.length > 0) lines.push("", ...step.problems.map((problem) => `Problem: ${problem}`));
  lines.push("");
  return lines;
}

export function renderTranscript(observation: CaseObservation): string {
  const lines = [
    `# Transcript: ${observation.caseId} (${observation.mode})`,
    "",
    `Run ${observation.identity.runId} · model ${observation.identity.model} · commit ${observation.identity.gitCommit}${observation.identity.gitDirty ? " (dirty)" : ""} · fixture ${observation.identity.fixtureSha256.slice(0, 12)}`,
    "",
    "Seeded history is not repeated here; it is the fixture. Times marked CLI are measured by the client from before the request is sent; times marked app clock are measured inside the app process around the Provider call.",
    "",
  ];
  for (const step of observation.steps) lines.push(...renderStep(step));
  const background = (observation.backgroundRequests ?? []).filter(
    (request) => request.transport === "live",
  );
  if (background.length > 0) {
    lines.push("### Background model roles answered by the real Provider", "");
    for (const request of background) {
      lines.push(
        `- request #${request.sequence}: ${JSON.stringify(clip(request.instructionsStart, 100))}; usage in ${request.response?.usage?.inputTokens ?? "unknown"}, out ${request.response?.usage?.outputTokens ?? "unknown"} (reasoning ${request.response?.usage?.reasoningTokens ?? "unknown"}); ended ${ms(request.response?.endedMs)}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
