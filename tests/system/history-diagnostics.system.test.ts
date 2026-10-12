import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  PostgresInternalInspectionRepository,
  createPostgresAuthAdapter,
} from "@sayhear/data";
import { asGenerationCommandId } from "@sayhear/domain";
import { HISTORY_RECALL_DEFAULT_POLICY } from "@sayhear/application";

import {
  diagnoseStep,
  type DiagnosticEvidence,
  type DiagnosticRecall,
} from "../../eval/continuity-acceptance-301/src/diagnose";
import {
  ASK_AT,
  OWNER,
  U_BAG,
  U_REPAIR,
  askVia,
  createHistoryPathHarness,
  seedLife,
  terminal,
  type HarnessOptions,
} from "../support/history-path-harness";

/**
 * Issue #320: five kinds of fault are told apart from real boundaries. The
 * evidence below is read from what the system recorded (authoritative history,
 * the controlled Inspector, the Provider request that actually left), never
 * from a status code, and the Provider call is named so a conclusion can be
 * traced to the payload it was drawn from.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const harness = createHistoryPathHarness(testDatabaseUrl);

afterEach(async () => {
  await harness.teardown();
}, 15_000);

async function start(options: HarnessOptions = {}): Promise<void> {
  await harness.setup(options);
  await seedLife(harness);
}

type Wanted = Readonly<{ expectedLocalDate: string | null; text: string }>;

async function inspectTurn() {
  const [command] = await harness.rows<{ generation_command_id: string }>(
    `SELECT generation_command_id::text FROM generation_commands
     WHERE created_at >= $1
     ORDER BY (generation_stage = 'history_answer') DESC, created_at DESC LIMIT 1`,
    [new Date(ASK_AT)],
  );
  return new PostgresInternalInspectionRepository(harness.database.pool).findGenerationMetadata({
    generationCommandId: asGenerationCommandId(command!.generation_command_id),
    userId: OWNER,
  });
}

async function evidenceOf(
  wanted: readonly Wanted[],
  verdict: DiagnosticEvidence["semanticVerdict"] = null,
): Promise<DiagnosticEvidence> {
  const metadata = await inspectTurn();
  const texts = await harness.rows<{ canonical_text: string; revision_id: string }>(
    `SELECT revision.canonical_text, revision.conversation_event_revision_id::text AS revision_id
     FROM conversation_events event
     INNER JOIN conversation_event_revisions revision
       ON revision.conversation_event_revision_id = event.current_revision_id`,
  );
  const recall = metadata?.historyRecall ?? null;
  const diagnosticRecall: DiagnosticRecall | null = recall
    ? {
        answerCommandId: recall.answerCommandId,
        enumerationComplete: recall.coverage.enumerationComplete ?? null,
        failureCode: recall.failureCode,
        omitted: recall.coverage.omitted as Readonly<Record<string, number>>,
        role: recall.role,
        searchOutcome: recall.coverage.search?.outcome ?? null,
        sourceRevisionIds: recall.sources.map((source) => source.revisionId),
        status: recall.status,
      }
    : null;
  return {
    authoritativeTexts: texts.map((row) => row.canonical_text),
    recall: diagnosticRecall,
    requests: harness.state.requests.map((request, index) => ({
      instructions: request.instructions,
      messages: request.turns.map((message) => {
        const split = message.indexOf(":");
        return { role: message.slice(0, split), text: message.slice(split + 1) };
      }),
      providerResponseId: request.providerResponseId,
      sequence: index + 1,
      toolsOffered: request.toolsDisabled ? [] : request.functionNames,
    })),
    semanticVerdict: verdict,
    sources: wanted.map((entry) => ({
      expectedLocalDate: entry.expectedLocalDate,
      revisionId: texts.find((row) => row.canonical_text === entry.text)?.revision_id ?? null,
      source: entry.text.slice(0, 6),
      text: entry.text,
    })),
    turn: metadata?.turn
      ? {
          commands: metadata.turn.commands,
          finalDisposition: metadata.turn.finalDisposition,
        }
      : null,
  };
}

const BAG: Wanted = { expectedLocalDate: "2026-08-20", text: U_BAG };
const REPAIR: Wanted = { expectedLocalDate: "2026-08-20", text: U_REPAIR };

describe("a complete read: sources and time arrive; nobody has judged the answer yet", () => {
  it("reports undetermined, traces each conclusion to the Provider call, and lets only a semantic verdict decide", async () => {
    await start();
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");

    const undetermined = diagnoseStep(await evidenceOf([BAG, REPAIR]));
    expect(undetermined.readState).toBe("complete");
    expect(undetermined.payloadReadStatus).toBe("completed");
    expect(undetermined.disagreements).toEqual([]);
    expect(undetermined.sources.map((entry) => entry.fault)).toEqual(["undetermined", "undetermined"]);

    // The trace names the very Provider call: the Inspector's own record of
    // the answer attempt carries the id the Provider answered with.
    const metadata = await inspectTurn();
    const answer = metadata!.turn!.commands.find((command) => command.stage === "history_answer")!;
    expect(answer.providerRequestId).toBe(undetermined.sources[0]!.trace!.providerResponseId);
    expect(undetermined.sources[0]!.trace!.commandStage).toBe("history_answer");
    expect(metadata!.turn!.finalDisposition).toBe("committed");
    expect(metadata!.turn!.commands.map((command) => command.stage)).toEqual(["decision", "history_answer"]);
    expect(metadata!.turn!.commands.every((command) => command.egressDisposition === "completed")).toBe(true);

    // A committed turn and an injected source never imply a generation error.
    expect(diagnoseStep(await evidenceOf([BAG], "pass")).sources[0]!.fault).toBe("none");
    expect(diagnoseStep(await evidenceOf([BAG], "fail")).sources[0]!.fault).toBe("generation_error");
  });
});

describe("empty, partial and failed reads are told apart in the Inspector and in the payload", () => {
  it("empty: the range was fully read and held nothing; the source that exists elsewhere is a selection omission", async () => {
    await start();
    harness.state.review = { start_date: "2026-08-25" };
    await harness.say("八月二十五号我说了什么？", ASK_AT);
    const diagnosis = diagnoseStep(await evidenceOf([BAG]));
    expect(diagnosis.readState).toBe("empty");
    expect(diagnosis.payloadReadStatus).toBe("completed");
    expect(diagnosis.sources[0]!.fault).toBe("selection_omitted");
    expect(diagnosis.sources[0]!.evidence.join("\n")).toContain("enumerationComplete=true");
  });

  it("partial: the read stopped early; the unread source is a selection omission and the payload says partial", async () => {
    await start({ policy: { ...HISTORY_RECALL_DEFAULT_POLICY, maxPages: 1, pageSize: 1 } });
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const diagnosis = diagnoseStep(await evidenceOf([BAG, REPAIR]));
    expect(diagnosis.readState).toBe("partial");
    expect(diagnosis.payloadReadStatus).toBe("partial");
    expect(diagnosis.disagreements).toEqual([]);
    const faults = Object.fromEntries(diagnosis.sources.map((entry, index) => [index, entry.fault]));
    expect(Object.values(faults)).toContain("selection_omitted");
    expect(diagnosis.sources.find((entry) => entry.fault === "selection_omitted")!.evidence.join("\n")).toContain(
      "enumerationComplete=false",
    );
  });

  it("failed: the read itself failed; the fault is a read failure and the payload says failed", async () => {
    await start({
      sourceOverride: () => ({
        async readHistoryRange() {
          return {
            currentConversationRows: 0,
            enumerationComplete: false,
            failure: { code: "source_read_timeout" as const },
            items: [],
            pages: 0,
            readLatencyMs: 2_000,
          };
        },
      }),
    });
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const diagnosis = diagnoseStep(await evidenceOf([BAG]));
    expect(diagnosis.readState).toBe("failed");
    expect(diagnosis.payloadReadStatus).toBe("failed");
    expect(diagnosis.sources[0]!.fault).toBe("read_failed");
    expect(diagnosis.sources[0]!.evidence.join("\n")).toContain("source_read_timeout");
  });
});

describe("the other faults", () => {
  it("no source: words that were never said are not in the authoritative history", async () => {
    await start();
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const diagnosis = diagnoseStep(
      await evidenceOf([{ expectedLocalDate: "2026-08-20", text: "这句话从来没有说过。" }]),
    );
    expect(diagnosis.sources[0]!.fault).toBe("no_source");
  });

  it("time lost: the words arrived but without the time of the day they were said on", async () => {
    await start();
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const evidence = await evidenceOf([BAG]);
    // Remove the day headings of the quoted entries from the payload that
    // actually left, and, in a second case, shift the date: both are a time
    // that did not arrive intact.
    const withoutTimes: DiagnosticEvidence = {
      ...evidence,
      requests: evidence.requests.map((request) => ({
        ...request,
        instructions: request.instructions.replace(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} \(.*\)$/gm, ""),
      })),
    };
    expect(withoutTimes.requests.at(-1)!.instructions).not.toBe(evidence.requests.at(-1)!.instructions);
    expect(diagnoseStep(withoutTimes).sources[0]!.fault).toBe("time_lost");
    const shifted: DiagnosticEvidence = {
      ...evidence,
      sources: evidence.sources.map((source) => ({ ...source, expectedLocalDate: "2026-08-19" })),
    };
    expect(diagnoseStep(shifted).sources[0]!.fault).toBe("time_lost");
    // Untouched, the same payload carries the right time.
    expect(diagnoseStep(evidence).sources[0]!.fault).toBe("undetermined");
  });

  it("selection omission when the Decision took no history branch at all", async () => {
    await start();
    await harness.disableGovernance();
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const diagnosis = diagnoseStep(await evidenceOf([BAG]));
    expect(diagnosis.readState).toBe("unread");
    expect(diagnosis.sources[0]!.fault).toBe("selection_omitted");
    expect(diagnosis.sources[0]!.evidence.join("\n")).toContain("no history branch");
  });
});

describe("the Turn view states how a turn really ended", () => {
  it("shows a blocked answer as blocked and not committed, with the Provider's disposition per command", async () => {
    await start();
    harness.state.hooks.afterAnswerCompile = () => harness.seedForget(U_BAG);
    const events = await askVia(harness, "date");
    expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
    const metadata = await inspectTurn();
    expect(metadata!.turn!.assistantEventCommitted).toBe(false);
    expect(["failed", "interrupted"]).toContain(metadata!.turn!.finalDisposition);
    const answer = metadata!.turn!.commands.find((command) => command.stage === "history_answer")!;
    expect(answer.egressDisposition).toBe("blocked");
    expect(answer.providerRequestId).toBeNull();
    // Nothing of the blocked answer left: only the Decision's request exists.
    expect(harness.state.requests).toHaveLength(1);
  });
});

describe("opening the original words behind a history answer follows the existing capability and step-up rules", () => {
  const SESSION_TOKEN = "history-inspection-session-token";
  const authSessionId = createHash("sha256").update(SESSION_TOKEN, "utf8").digest("hex");

  async function expand(stepUpAt: string | null | "none") {
    const pool = harness.database.pool;
    if (stepUpAt !== "none") {
      await createPostgresAuthAdapter(pool).createSession({
        expires: new Date("2099-01-01T00:00:00.000Z"),
        sessionToken: SESSION_TOKEN,
        userId: OWNER,
      });
      await pool.query(
        `INSERT INTO internal_diagnostic_access_grants (
           session_token_hash, capability, status, step_up_authenticated_at, updated_at
         ) VALUES (decode($1, 'hex'), 'conversation_content:read', 'active', $2, $3)`,
        [authSessionId, stepUpAt, harness.now],
      );
    } else {
      await createPostgresAuthAdapter(pool).createSession({
        expires: new Date("2099-01-01T00:00:00.000Z"),
        sessionToken: SESSION_TOKEN,
        userId: OWNER,
      });
    }
    const [command] = await harness.rows<{ generation_command_id: string }>(
      `SELECT generation_command_id::text FROM generation_commands
       WHERE generation_stage = 'decision' AND created_at >= $1 LIMIT 1`,
      [new Date(ASK_AT)],
    );
    return new PostgresInternalInspectionRepository(pool).inspectConversationContent({
      authSessionId,
      capability: "conversation_content:read",
      generationCommandId: asGenerationCommandId(command!.generation_command_id),
      now: new Date("2026-09-15T02:10:30.000Z"),
      policyVersion: "sensitive-inspection:v1",
      stepUpMaxAgeMs: 10 * 60 * 1_000,
      userId: OWNER,
    });
  }

  it("denies without the capability and reveals neither the query, the people nor the range", async () => {
    await start();
    await askVia(harness, "search");
    const result = await expand("none");
    expect(result).toEqual({ outcome: "denied", reason: "elevated_capability_required" });
    expect(JSON.stringify(result)).not.toContain("帆布包");
  });

  it("denies a stale step-up the same way", async () => {
    await start();
    await askVia(harness, "search");
    const result = await expand("2026-09-15T01:00:00.000Z");
    expect(result).toEqual({ outcome: "denied", reason: "recent_step_up_required" });
  });

  it("returns the original words in the order the model saw them, and leaves out a source excluded since", async () => {
    await start();
    await askVia(harness, "date");
    const allowed = await expand("2026-09-15T02:09:00.000Z");
    if (allowed.outcome !== "allowed") throw new Error("expected the expansion to be allowed");
    expect(allowed.content.historySources.map((source) => `${source.actor}:${source.text}`)).toEqual([
      `user:${U_BAG}`,
      "assistant:缝帆布包这件事听起来很有成就感。",
      `user:${U_REPAIR}`,
      "assistant:先自己补的想法挺踏实。",
    ]);
    await harness.seedForget(U_BAG);
    const afterForget = await new PostgresInternalInspectionRepository(
      harness.database.pool,
    ).inspectConversationContent({
      authSessionId,
      capability: "conversation_content:read",
      generationCommandId: asGenerationCommandId(
        (
          await harness.rows<{ generation_command_id: string }>(
            "SELECT generation_command_id::text FROM generation_commands WHERE generation_stage = 'decision' AND created_at >= $1 LIMIT 1",
            [new Date(ASK_AT)],
          )
        )[0]!.generation_command_id,
      ),
      now: new Date("2026-09-15T02:10:30.000Z"),
      policyVersion: "sensitive-inspection:v1",
      stepUpMaxAgeMs: 10 * 60 * 1_000,
      userId: OWNER,
    });
    if (afterForget.outcome !== "allowed") throw new Error("expected the expansion to be allowed");
    expect(afterForget.content.historySources.map((source) => source.text)).toEqual([
      U_REPAIR,
      "先自己补的想法挺踏实。",
    ]);
  });
});
