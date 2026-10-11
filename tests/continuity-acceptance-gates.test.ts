import { describe, expect, it } from "vitest";

import {
  planRun,
  remainingBudget,
  type CostLedger,
} from "../eval/continuity-acceptance-301/src/budget";
import {
  IsolationError,
  assertSyntheticOwner,
  resolveIsolationTarget,
} from "../eval/continuity-acceptance-301/src/isolation";

const LOCAL = "postgresql://localhost:5432/sayhear_test_t00";
const LOCAL_MARKER = "postgresql://localhost:5432/sayhear_marker_t00";

describe("continuity acceptance isolation gate", () => {
  it("accepts a loopback synthetic test database pair", () => {
    const target = resolveIsolationTarget({
      TEST_DATABASE_URL: LOCAL,
      TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
    });
    expect(target.databaseName).toBe("sayhear_test_t00");
    expect(target.markerDatabaseName).toBe("sayhear_marker_t00");

    expect(
      resolveIsolationTarget({
        TEST_DATABASE_URL: "postgresql://sayhear:sayhear@127.0.0.1:5432/sayhear_test",
        TEST_PURGE_MARKER_DATABASE_URL:
          "postgresql://sayhear:sayhear@127.0.0.1:5433/sayhear_purge_marker_test",
      }).databaseName,
    ).toBe("sayhear_test");
  });

  it("prefers the dedicated acceptance variables over the shared test ones", () => {
    expect(
      resolveIsolationTarget({
        SAYHEAR_ACCEPTANCE_DATABASE_URL: "postgresql://localhost/sayhear_acceptance_a",
        SAYHEAR_ACCEPTANCE_MARKER_DATABASE_URL: "postgresql://localhost/sayhear_marker_a",
        TEST_DATABASE_URL: LOCAL,
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      }).databaseName,
    ).toBe("sayhear_acceptance_a");
  });

  it("never falls back to the application's own DATABASE_URL", () => {
    expect(() =>
      resolveIsolationTarget({
        DATABASE_URL: LOCAL,
        PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      }),
    ).toThrow(IsolationError);
  });

  it("refuses a database that is also the configured application database", () => {
    expect(() =>
      resolveIsolationTarget({
        DATABASE_URL: "postgresql://localhost:5432/sayhear_test_t00?sslmode=disable",
        TEST_DATABASE_URL: LOCAL,
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      }),
    ).toThrow(/application database/);
  });

  it("refuses remote hosts and non-synthetic database names", () => {
    for (const url of [
      "postgresql://user:secret@ep-cool-name.us-east-2.aws.neon.tech/sayhear_test",
      "postgresql://localhost:5432/sayhear",
      "postgresql://localhost:5432/sayhear_production",
      "postgresql://localhost:5432/postgres",
      "not a url",
    ]) {
      expect(() =>
        resolveIsolationTarget({
          TEST_DATABASE_URL: url,
          TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
        }),
      ).toThrow(IsolationError);
    }
  });

  it("judges the host the driver will really connect to, not the one written before the path", () => {
    // PostgreSQL connection strings let a query parameter replace the host or
    // port; the URL below reads as localhost and connects to a remote server.
    for (const url of [
      "postgresql://localhost/sayhear_test?host=db.prod.example.com",
      "postgresql://localhost:5432/sayhear_test?host=db.prod.example.com&sslmode=require",
      "postgresql://localhost/sayhear_test?hostaddr=10.0.0.7",
      "postgresql://localhost/sayhear_test?port=6543",
      "postgresql://localhost/sayhear_test?HOST=db.prod.example.com",
      "postgresql://localhost/sayhear_test?service=production",
      // No host at all: the driver would take it from PGHOST.
      "postgresql:///sayhear_test",
      // A socket directory is not the loopback PostgreSQL this runner expects.
      "postgresql://%2Fvar%2Frun%2Fpostgresql/sayhear_test",
    ]) {
      expect(
        () =>
          resolveIsolationTarget({
            TEST_DATABASE_URL: url,
            TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
          }),
        url,
      ).toThrow(IsolationError);
      expect(
        () =>
          resolveIsolationTarget({
            TEST_DATABASE_URL: LOCAL,
            TEST_PURGE_MARKER_DATABASE_URL: url.replace("sayhear_test", "sayhear_marker_x"),
          }),
        `marker ${url}`,
      ).toThrow(IsolationError);
    }
  });

  it("still accepts harmless connection options on a loopback target", () => {
    expect(
      resolveIsolationTarget({
        TEST_DATABASE_URL: "postgresql://localhost:5432/sayhear_test_t00?sslmode=disable&application_name=acceptance",
        TEST_PURGE_MARKER_DATABASE_URL: "postgresql://[::1]:5432/sayhear_marker_t00",
      }).databaseName,
    ).toBe("sayhear_test_t00");
  });

  it("recognises the application database even when it is written with a host parameter", () => {
    expect(() =>
      resolveIsolationTarget({
        DATABASE_URL: "postgresql://placeholder/sayhear_test_t00?host=localhost",
        TEST_DATABASE_URL: LOCAL,
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      }),
    ).toThrow(/application database/);
  });

  it("is not satisfied by a hand-typed confirmation flag", () => {
    expect(() =>
      resolveIsolationTarget({
        SAYHEAR_ACCEPTANCE_ISOLATED: "true",
        SAYHEAR_ACCEPTANCE_I_KNOW_WHAT_I_AM_DOING: "yes",
        TEST_DATABASE_URL: "postgresql://db.internal.example.com/sayhear",
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      }),
    ).toThrow(IsolationError);
  });

  it("never echoes credentials from a rejected URL", () => {
    try {
      resolveIsolationTarget({
        TEST_DATABASE_URL: "postgresql://user:hunter2-secret@db.example.com/sayhear",
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL_MARKER,
      });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("hunter2-secret");
    }
  });

  it("requires the purge marker store to be a different database", () => {
    expect(() =>
      resolveIsolationTarget({
        TEST_DATABASE_URL: LOCAL,
        TEST_PURGE_MARKER_DATABASE_URL: LOCAL,
      }),
    ).toThrow(/separate/);
  });

  it("only treats the run's own synthetic identity as a seedable owner", () => {
    const owned = {
      issuer: "https://acceptance.sayhear.invalid",
      ownerCount: 1,
      runId: "run-1",
      seedCapability: "synthetic-history:v1",
      subject: "continuity-acceptance:run-1",
    };
    expect(() => assertSyntheticOwner(owned, "run-1")).not.toThrow();
    // A real GitHub-issued owner, another run's data, an extra user, or a
    // schema that never recorded the seed capability are all refused.
    for (const other of [
      { ...owned, issuer: "https://github.com", subject: "1234567" },
      { ...owned, runId: "run-2", subject: "continuity-acceptance:run-2" },
      { ...owned, ownerCount: 2 },
      { ...owned, seedCapability: null },
      null,
    ]) {
      expect(() => assertSyntheticOwner(other, "run-1")).toThrow(IsolationError);
    }
  });
});

const LEDGER: CostLedger = {
  capUsdMicros: 10_000_000,
  entries: [],
  model: {
    inputUsdMicrosPerMillionTokens: 1_000_000,
    model: "deepseek-v4.1-flash",
    outputUsdMicrosPerMillionTokens: 2_000_000,
    provider: "opencode-go",
  },
  preconditions: [
    { description: "#307 online acceptance", evidence: "recorded", id: "issue-307", status: "verified" },
  ],
  schemaVersion: "continuity-cost-ledger:v1",
};

const SHAPE = { generationSteps: 3, scheduledScans: 0, seedTurns: 20 };

describe("continuity acceptance model-mode and budget gate", () => {
  it("defaults to deterministic mode with no paid requests", () => {
    const plan = planRun({ environment: {}, ledger: LEDGER, requestedMode: undefined, shape: SHAPE });
    expect(plan.status).toBe("ready");
    expect(plan.mode).toBe("deterministic");
    expect(plan.paidRequestUpperBound).toBe(0);
    expect(plan.estimatedCostUsdMicros).toBe(0);
  });

  it("bounds real-model requests, tokens and cost before anything is sent", () => {
    const plan = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: LEDGER,
      requestedMode: "real-model",
      shape: SHAPE,
    });
    expect(plan.status).toBe("ready");
    // History is replayed through the stub; only follow-up turns are paid.
    // Each may be retried and may need one tool-loop continuation.
    expect(plan.paidRequestUpperBound).toBe(3 * plan.requestsPerStepUpperBound);
    expect(plan.requestsPerStepUpperBound).toBeGreaterThanOrEqual(2);
    expect(plan.inputTokenUpperBound).toBeGreaterThan(0);
    expect(plan.estimatedCostUsdMicros).toBe(
      Math.ceil(
        (plan.inputTokenUpperBound * 1_000_000 + plan.outputTokenUpperBound * 2_000_000) /
          1_000_000,
      ),
    );
    expect(plan.remainingUsdMicros).toBe(10_000_000);

    // Idle gaps trigger the scheduled scan, whose background model roles also
    // call the Provider; they are budgeted rather than left as a surprise.
    const withGaps = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: LEDGER,
      requestedMode: "real-model",
      shape: { ...SHAPE, scheduledScans: 4 },
    });
    expect(withGaps.paidRequestUpperBound).toBeGreaterThan(plan.paidRequestUpperBound);
  });

  it("blocks real-model mode unless it was explicitly enabled", () => {
    const plan = planRun({ environment: {}, ledger: LEDGER, requestedMode: "real-model", shape: SHAPE });
    expect(plan.status).toBe("blocked");
    // Blocked is blocked: it is never quietly downgraded to the stub.
    expect(plan.mode).toBe("real-model");
    expect(plan.blockers.join(" ")).toMatch(/SAYHEAR_ACCEPTANCE_REAL_MODEL/);
  });

  it("blocks real-model mode while a precondition is unverified", () => {
    const plan = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: {
        ...LEDGER,
        preconditions: [{ description: "#307 online acceptance", evidence: null, id: "issue-307", status: "unverified" }],
      },
      requestedMode: "real-model",
      shape: SHAPE,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toMatch(/issue-307/);
  });

  it("blocks when the remaining budget cannot cover the upper bound", () => {
    const spent: CostLedger = {
      ...LEDGER,
      entries: [{ costUsdMicros: 9_999_999, date: "2026-10-09", inputTokens: 1, note: "prior", outputTokens: 1, requests: 1, runId: "r", ticket: "#307" }],
    };
    expect(remainingBudget(spent)).toEqual({ remainingUsdMicros: 1, unknownCostEntries: 0 });
    const plan = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: spent,
      requestedMode: "real-model",
      shape: SHAPE,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toMatch(/budget/i);
  });

  it("keeps calls with unknown cost in the ledger and refuses to guess the remainder", () => {
    const unknown: CostLedger = {
      ...LEDGER,
      entries: [{ costUsdMicros: null, date: "2026-10-09", inputTokens: 2_131, note: "cost not reported", outputTokens: 564, requests: 1, runId: "r", ticket: "#307" }],
    };
    expect(remainingBudget(unknown).unknownCostEntries).toBe(1);
    const plan = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: unknown,
      requestedMode: "real-model",
      shape: SHAPE,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toMatch(/unknown cost/i);
  });

  it("blocks when no price is recorded instead of assuming the run is free", () => {
    const plan = planRun({
      environment: { SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled" },
      ledger: { ...LEDGER, model: { ...LEDGER.model, inputUsdMicrosPerMillionTokens: null } },
      requestedMode: "real-model",
      shape: SHAPE,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.estimatedCostUsdMicros).toBeNull();
    expect(plan.blockers.join(" ")).toMatch(/price/i);
  });

  it("rejects an unknown mode outright", () => {
    expect(() =>
      planRun({ environment: {}, ledger: LEDGER, requestedMode: "fast", shape: SHAPE }),
    ).toThrow(/mode/);
  });
});
