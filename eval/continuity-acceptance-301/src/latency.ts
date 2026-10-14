import { createAcceptanceEnvironment } from "./environment";
import type { CaseFixture, ProviderFaultSpec, ToolCallScript } from "./fixture";
import type { IsolationTarget } from "./isolation";
import { openCaseSession } from "./runner";

/**
 * Same-method latency evidence for the chat path (#319, absorbing #312).
 *
 * Every profile goes through the real chat route against the stand-in
 * Provider, so the numbers are SayHear's own: acceptance, Context, the
 * Decision, a Trust Action or a history review, the final reply, persistence
 * and transport. The Provider's time is whatever the stub is told to take, is
 * recorded per request, and is subtracted to show what SayHear itself added.
 *
 * What this is NOT: it says nothing about a real model's thinking time, the
 * 3 s / 10 s limits with a real model, or browser rendering. That is T08's
 * run; this report is for comparing the same fixture and the same stub timing
 * before and after a change, never as an average that hides a slow sample.
 */

export type LatencyOptions = Readonly<{
  /** Budget for the app under test; omit to use the deterministic default. */
  requestBudgetMs?: number;
  /** Delay the stub adds before the first byte of EVERY Provider call. */
  providerDelayMs: number;
  /** Warm repeats after the first (cold) run of each profile. */
  repeats: number;
  /** How long the stalled-Provider profile hangs; 0 skips the profile. */
  stallMs: number;
  target: IsolationTarget;
}>;

export type LatencyRun = Readonly<{
  clientFirstTextMs: number | null;
  clientCommittedMs: number | null;
  clientStreamClosedMs: number;
  providerCalls: number;
  providerTimeMs: number;
  /** Stream closed minus the stub's own time, for sequential Provider calls. */
  sayHearOverheadMs: number;
  terminal: string | null;
  failureCategory: string | null;
}>;

export type LatencyProfileReport = Readonly<{
  description: string;
  id: string;
  runs: readonly LatencyRun[];
}>;

export type LatencyReport = Readonly<{
  options: Readonly<{
    budgetMs: number | null;
    providerDelayMs: number;
    repeats: number;
    stallMs: number;
  }>;
  profiles: readonly LatencyProfileReport[];
  schemaVersion: "continuity-latency:v1";
}>;

const FIXTURE: CaseFixture = {
  defaults: { locale: "en-US", timezone: "America/Denver" },
  fixtureVersion: "latency-1",
  history: [
    {
      at: "2026-09-09T22:10:00.000Z",
      assistant: "Pie on the curb with your sister sounds like the best part of the day.",
      key: "market",
      user: "I went to the farmers market with my sister Dani and we split a huge peach pie on the curb.",
    },
    {
      at: "2026-09-09T22:20:00.000Z",
      assistant: "A hike your dad used to take you on carries a lot with it.",
      key: "hike",
      user: "Then we talked about doing the long ridge hike in October, the one our dad used to take us on.",
    },
    {
      at: "2026-09-10T15:00:00.000Z",
      assistant: "Thank you for telling me; I have corrected my understanding of it.",
      key: "fix",
      user: "No wait, that is wrong: the pie was at the Saturday market, not the Sunday one.",
    },
  ],
  id: "LAT",
  languageVariant: "en",
  schemaVersion: "continuity-acceptance-fixture:v1",
  stage: "development",
  steps: [],
};

type Profile = Readonly<{
  description: string;
  id: string;
  /** Extra stub behavior for this profile's step. */
  historyReview?: Readonly<{ endDate: string; startDate: string }>;
  stall?: boolean;
  text: string;
  toolCall?: ToolCallScript;
}>;

const PROFILES: readonly Profile[] = [
  {
    description: "Ordinary question answered from the default background.",
    id: "ordinary",
    text: "How was my week looking so far?",
  },
  {
    description: "Cross-day recall: Decision selects the history review, then a History Answer is generated.",
    historyReview: { endDate: "2026-09-09", startDate: "2026-09-09" },
    id: "cross_day_recall",
    text: "What did I tell you on the ninth about the market?",
  },
  {
    description: "A needed Trust Action: Decision selects a memory correction that finds no target, then Finalization replies (the #312 shape).",
    id: "trust_action",
    text: "That memory about the market is wrong, please fix it.",
    toolCall: { argumentsJson: JSON.stringify({ targetAnchor: "the market" }), name: "memory_correction" },
  },
  {
    description: "A recall question while history holds a correction: the control wording in history must not trigger a state Action (judged for real by T08).",
    historyReview: { endDate: "2026-09-10", startDate: "2026-09-10" },
    id: "recall_with_correction_in_history",
    text: "Remind me what I said about the market on the tenth.",
  },
];

function round(value: number): number {
  return Math.round(value);
}

export async function runLatencyProfiles(options: LatencyOptions): Promise<LatencyReport> {
  const environment = await createAcceptanceEnvironment({
    initialNow: new Date("2026-09-09T20:00:00.000Z"),
    ...(options.requestBudgetMs === undefined ? {} : { requestBudgetMs: options.requestBudgetMs }),
    target: options.target,
  });
  try {
    const session = await openCaseSession({
      environment,
      fixture: FIXTURE,
      fixtureSha256: "latency",
      mode: "deterministic",
    });
    const profiles: LatencyProfileReport[] = [];
    let clock = Date.parse("2026-09-12T16:00:00.000Z");
    const next = () => new Date((clock += 90_000));
    const all: readonly Profile[] = [
      ...PROFILES,
      ...(options.stallMs > 0
        ? [
            {
              description: `The Provider stalls for ${options.stallMs} ms before its first byte; the request must stop at its budget, not wait for it.`,
              id: "stalled_provider",
              stall: true,
              text: "Are you still there?",
            } satisfies Profile,
          ]
        : []),
    ];
    for (const profile of all) {
      const runs: LatencyRun[] = [];
      const repeats = profile.stall ? 1 : options.repeats + 1;
      for (let index = 0; index < repeats; index += 1) {
        const fault: ProviderFaultSpec | undefined = profile.stall
          ? { delayBeforeFirstChunkMs: options.stallMs }
          : options.providerDelayMs > 0
            ? { delayBeforeFirstChunkMs: options.providerDelayMs }
            : undefined;
        const step = await session.say({
          at: next(),
          id: `${profile.id}-${index}`,
          text: `${profile.text} (${index + 1})`,
          ...(fault ? { providerFault: fault } : {}),
          ...(profile.historyReview ? { historyReview: profile.historyReview } : {}),
          ...(profile.toolCall ? { toolCall: profile.toolCall } : {}),
        });
        const chat = step.chat;
        const label = `${profile.id}-${index}`;
        const calls = environment.stub.requests().filter((request) => request.stepLabel === label);
        const providerTime = calls.reduce((total, call) => total + (call.durationMs ?? 0), 0);
        const last = chat?.events.at(-1);
        runs.push({
          clientCommittedMs: chat?.timing.committedMs == null ? null : round(chat.timing.committedMs),
          clientFirstTextMs:
            chat?.timing.firstVisibleTextMs == null ? null : round(chat.timing.firstVisibleTextMs),
          clientStreamClosedMs: round(chat?.timing.streamClosedMs ?? 0),
          failureCategory: last?.category ?? null,
          providerCalls: calls.length,
          providerTimeMs: round(providerTime),
          sayHearOverheadMs: round((chat?.timing.streamClosedMs ?? 0) - providerTime),
          terminal: chat?.terminalEvent ?? null,
        });
      }
      profiles.push({ description: profile.description, id: profile.id, runs });
    }
    return {
      options: {
        budgetMs: options.requestBudgetMs ?? null,
        providerDelayMs: options.providerDelayMs,
        repeats: options.repeats,
        stallMs: options.stallMs,
      },
      profiles,
      schemaVersion: "continuity-latency:v1",
    };
  } finally {
    await environment.dispose().catch(() => {});
  }
}

export function renderLatencyMarkdown(report: LatencyReport): string {
  const lines = [
    "# Chat latency profile (stand-in Provider)",
    "",
    `Stub delay per Provider call: ${report.options.providerDelayMs} ms · stall: ${report.options.stallMs} ms · budget under test: ${report.options.budgetMs ?? "deterministic default"} ms · warm repeats: ${report.options.repeats}`,
    "",
    "Client times are CLI network timings from the moment the request leaves the CLI. \"SayHear overhead\" is stream-closed minus the stub's own time, so it covers acceptance, Context, Decision/Action/Finalization orchestration, persistence and transport. This report says nothing about a real model's thinking time.",
    "",
    "| profile | run | first text ms | committed ms | stream closed ms | provider calls | provider ms | SayHear overhead ms | terminal |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const profile of report.profiles) {
    profile.runs.forEach((run, index) => {
      lines.push(
        `| ${profile.id} | ${index === 0 ? "first" : `warm ${index}`} | ${run.clientFirstTextMs ?? "—"} | ${run.clientCommittedMs ?? "—"} | ${run.clientStreamClosedMs} | ${run.providerCalls} | ${run.providerTimeMs} | ${run.sayHearOverheadMs} | ${run.terminal ?? "—"}${run.failureCategory ? ` (${run.failureCategory})` : ""} |`,
      );
    });
  }
  lines.push(
    "",
    "Warm runs only (the first run of a profile is listed above but excluded here). The maximum is shown beside the median so a slow sample is never hidden by an average.",
    "",
    "| profile | warm runs | median closed ms | max closed ms | median overhead ms | max overhead ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  const median = (values: readonly number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]!
      : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  };
  for (const profile of report.profiles) {
    const warm = profile.runs.slice(1);
    if (warm.length === 0) continue;
    const closed = warm.map((run) => run.clientStreamClosedMs);
    const overhead = warm.map((run) => run.sayHearOverheadMs);
    lines.push(
      `| ${profile.id} | ${warm.length} | ${median(closed)} | ${Math.max(...closed)} | ${median(overhead)} | ${Math.max(...overhead)} |`,
    );
  }
  lines.push("", ...report.profiles.map((profile) => `- \`${profile.id}\`: ${profile.description}`));
  return `${lines.join("\n")}\n`;
}
