import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import type { EpisodeProposal } from "@sayhear/application";
import { EPISODE_ADMISSION_POLICY_VERSION } from "@sayhear/application";
import {
  asDailySessionId,
  asEvidenceItemId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";
import { PostgresEpisodeRepository } from "@sayhear/data";

/**
 * Issue #256: the `continue_episode` path runs two conditional UPDATEs (mark the
 * base version superseded and advance `episodes.current_version_id`). Neither
 * used to check `rowCount`, so a stale base that avoided a revision/supersedes
 * collision could no-op and still commit a divergent lineage.
 *
 * That state is not reachable through the current public API, so this test
 * injects the zero-row UPDATE result with a fake `PoolClient` and asserts the
 * admission transaction fails closed: `fenced` + `ROLLBACK`, with no later
 * writes (no candidate row, no build-run outcome) escaping.
 */

const OWNER = "01990000-0000-7000-8000-000000000001";
const SESSION = "01990000-0000-7000-8000-000000000002";
const EVIDENCE = "01990000-0000-7000-8000-000000000003";
const EVIDENCE_REVISION = "01990000-0000-7000-8000-000000000004";
const EPISODE = "01990000-0000-7000-8000-000000000005";
const BASE_VERSION = "01990000-0000-7000-8000-000000000006";
const SUCCESSOR_VERSION = "01990000-0000-7000-8000-000000000007";
const GENERATION_COMMAND = "01990000-0000-7000-8000-000000000008";
const MODEL_RUN_ATTEMPT = "01990000-0000-7000-8000-000000000009";
const KIND = "sh.episode.trip";
const ANCHOR = { start: { date: "2026-09-09", precision: "exact" } } as const;

type FakeResult = Readonly<{ rows: readonly unknown[]; rowCount: number }>;

type Matcher = Readonly<{
  match: (sql: string) => boolean;
  result: FakeResult;
}>;

function result(rows: readonly unknown[] = []): FakeResult {
  return { rows, rowCount: rows.length };
}

/**
 * Reaches a deterministic `continue_episode` plan for one frozen active Episode
 * and lets the caller decide which conditional UPDATE reports zero rows.
 */
function fakeClient(input: {
  supersedeRowCount: number;
  pointerRowCount: number;
}): PoolClient & { executed: string[] } {
  const executed: string[] = [];
  const matchers: Matcher[] = [
    {
      match: (sql) => sql.includes("SELECT attempt.status"),
      result: result([{ status: "running" }]),
    },
    {
      match: (sql) => sql.includes("FROM app_users WHERE user_id"),
      result: result([{ status: "active", data_epoch: "1" }]),
    },
    {
      match: (sql) => sql.includes("FROM daily_sessions"),
      result: result([{ source_revision: "1" }]),
    },
    {
      match: (sql) => sql.includes("FROM model_role_rollout_pins"),
      result: result([{ rollout_pin: "fake-episode-pin:v1" }]),
    },
    {
      match: (sql) => sql.includes("FROM episode_build_runs"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("FROM evidence_source_snapshots"),
      result: result([{ evidence_source_snapshot_id: "fake-snapshot" }]),
    },
    {
      match: (sql) => sql.includes("item.locator_type"),
      result: result([
        {
          evidence_item_id: EVIDENCE,
          locator_type: "whole_revision",
          locator_key: "1:0",
          source_status: "final",
          revision_id: EVIDENCE_REVISION,
          canonical_text: "I fly to Tokyo on September 9 for a business trip.",
          locale: "en-US",
        },
      ]),
    },
    {
      match: (sql) => sql.includes("v.revision AS current_revision"),
      result: result([
        {
          episode_id: EPISODE,
          episode_kind_id: KIND,
          current_version_id: BASE_VERSION,
          current_revision: 1,
          label: "Tokyo business trip",
          content: {
            kind: KIND,
            label: "Tokyo business trip",
            temporalAnchor: ANCHOR,
            phase: "planned",
            kindFields: { destination: "Tokyo" },
          },
        },
      ]),
    },
    {
      match: (sql) => sql.includes("SELECT l.episode_version_id, l.entity_id"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("SELECT entity_id FROM entities"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("FROM episode_candidates"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("FROM episode_evidence_links l"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("SELECT l.entity_id"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_versions"),
      result: result([{ episode_version_id: SUCCESSOR_VERSION }]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_evidence_links"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_candidate_evidence_links"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_candidate_entity_links"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_candidates"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("INSERT INTO episode_build_runs"),
      result: result([]),
    },
    {
      match: (sql) => sql.includes("UPDATE episode_versions SET status = 'superseded'"),
      result: { rows: [], rowCount: input.supersedeRowCount },
    },
    {
      match: (sql) => sql.includes("UPDATE episodes SET current_version_id = $3"),
      result: { rows: [], rowCount: input.pointerRowCount },
    },
  ];

  const client = {
    executed,
    query: async (sql: string): Promise<FakeResult> => {
      executed.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return result([]);
      }
      const matcher = matchers.find((candidate) => candidate.match(sql));
      if (!matcher) {
        throw new Error(`unexpected query in fake client: ${sql}`);
      }
      return matcher.result;
    },
    release: () => {},
  };
  return client as unknown as PoolClient & { executed: string[] };
}

function continuationInput() {
  const proposal: EpisodeProposal = {
    proposedKind: KIND,
    label: "Tokyo business trip",
    temporalAnchor: ANCHOR,
    phase: "ongoing",
    kindFields: { destination: "Tokyo" },
    citedEvidenceItemIds: [asEvidenceItemId(EVIDENCE)],
    realWorldOccurrence: true,
    explicitNewOccurrence: false,
  };
  return {
    userId: asUserId(OWNER),
    dailySessionId: asDailySessionId(SESSION),
    sourceRevision: 1,
    policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
    expectedDataEpoch: 1,
    generationCommandId: asGenerationCommandId(GENERATION_COMMAND),
    modelRunAttemptId: asModelRunAttemptId(MODEL_RUN_ATTEMPT),
    proposals: [proposal],
    dedupeFingerprintSecret: "unit-episode-secret",
  };
}

async function run(
  rowCounts: Readonly<{ supersedeRowCount: number; pointerRowCount: number }>,
) {
  const client = fakeClient(rowCounts);
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const repository = new PostgresEpisodeRepository(pool);
  const outcome = await repository.commitEpisodeAdmission(continuationInput());
  return { client, outcome };
}

describe("Episode continuation rowCount fence (issue #256)", () => {
  function expectFencedWithoutWrites(
    client: { executed: string[] },
    outcome: Awaited<ReturnType<PostgresEpisodeRepository["commitEpisodeAdmission"]>>,
  ): void {
    expect(outcome).toEqual({
      outcome: "fenced",
      reason: "continuation_base_stale",
    });
    expect(client.executed.filter((sql) => sql === "COMMIT")).toHaveLength(0);
    expect(client.executed.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    // The successor insert (and any link writes) already ran before the fence,
    // but the rollback discards them; no candidate or build-run outcome write
    // ever runs after the fence.
    expect(
      client.executed.some((sql) =>
        sql.startsWith("INSERT INTO episode_candidates"),
      ),
    ).toBe(false);
    expect(
      client.executed.some((sql) => sql.startsWith("INSERT INTO episode_build_runs")),
    ).toBe(false);
  }

  it("fences and rolls back when the base version is no longer current", async () => {
    const { client, outcome } = await run({
      supersedeRowCount: 0,
      pointerRowCount: 1,
    });

    expectFencedWithoutWrites(client, outcome);
  });

  it("fences and rolls back when the episode pointer no longer equals the base", async () => {
    const { client, outcome } = await run({
      supersedeRowCount: 1,
      pointerRowCount: 0,
    });

    expectFencedWithoutWrites(client, outcome);
  });

  it("still commits when both conditional UPDATEs advance the base", async () => {
    const { client, outcome } = await run({
      supersedeRowCount: 1,
      pointerRowCount: 1,
    });

    expect(outcome).toMatchObject({ outcome: "committed", acceptedCount: 1 });
    expect(client.executed.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(client.executed.filter((sql) => sql === "ROLLBACK")).toHaveLength(0);
  });
});
