import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PrWorkCoordinationStore,
  acceptResult,
  attachSession,
  readWork,
  recordFinding,
  releaseWork,
  reserveWork,
  type ProbeWorker,
  type ReserveInput,
  type TrustedLedger,
} from "../scripts/pr-work-coordination.ts";

const REPO = 1312399710;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const SCOPE_A = "c".repeat(64);
const SCOPE_B = "d".repeat(64);
const CHANGE_A = "e".repeat(64);
const OPEN_LEDGER: TrustedLedger = {
  roundsConsumed: 0,
  paused: false,
  historyConsistent: true,
  latestReviewedHead: HEAD_A,
};

const stopped: ProbeWorker = async () => "stopped";
const running: ProbeWorker = async () => "running";
const unknown: ProbeWorker = async () => "unknown";

async function makeStore() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "sayhear-prwork-"),
  );
  const stateDir = join(root, "state");
  return { root, store: new PrWorkCoordinationStore({ stateDir }) };
}

function reserveArgs(
  pr: number,
  tag: string,
  overrides: Partial<ReserveInput> = {},
): ReserveInput {
  return {
    repositoryId: REPO,
    pullRequestNumber: pr,
    role: "implementation",
    startHead: HEAD_A,
    scopeDigest: SCOPE_A,
    changeDigest: CHANGE_A,
    worktree: `/tmp/sayhear-prwork-${tag}-wt`,
    taskFile: `/tmp/sayhear-prwork-${tag}-task.md`,
    ledger: OPEN_LEDGER,
    ...overrides,
  };
}

async function reserveAttached(pr: number, tag: string) {
  const { root, store } = await makeStore();
  const reserved = await reserveWork(store, reserveArgs(pr, tag));
  if (!reserved.ok || reserved.record.owner === null) {
    throw new Error("reservation must succeed");
  }
  const token = reserved.record.owner.token;
  const attached = await attachSession(store, {
    repositoryId: REPO,
    pullRequestNumber: pr,
    ownerToken: token,
    startHead: HEAD_A,
    scopeDigest: SCOPE_A,
    role: "implementation",
    sessionId: `sess-${tag}`,
  });
  if (!attached.ok) throw new Error("attach must succeed");
  return { root, store, token, sessionId: `sess-${tag}` };
}

/** A real pid that is conclusively dead (child already reaped). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("no child pid");
  await new Promise<void>((done) => {
    child.on("exit", () => done());
    child.on("error", () => done());
  });
  try {
    process.kill(pid, 0);
    throw new Error("child unexpectedly alive");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return pid;
}

function resolveModule(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "pr-work-coordination.ts",
  );
}

interface ContenderRun {
  ok: boolean;
  token: string | null;
  reason: string | null;
}

function spawnContender(
  workerPath: string,
  stateDir: string,
  args: ReserveInput,
): Promise<ContenderRun> {
  return new Promise((done) => {
    const child = spawn(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [workerPath],
      {
        env: {
          ...process.env,
          SAYHEAR_STATE_DIR: stateDir,
          SAYHEAR_RESERVE_ARGS: JSON.stringify(args),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", () => done({ ok: false, token: null, reason: `spawn_failed:${err}` }));
    child.on("exit", (code) => {
      if (code !== 0) {
        done({ ok: false, token: null, reason: `exit_${code}:${err.slice(0, 200)}` });
        return;
      }
      try {
        done(JSON.parse(out) as ContenderRun);
      } catch {
        done({ ok: false, token: null, reason: `bad_output:${out.slice(0, 200)}` });
      }
    });
  });
}

describe("single writer under real contention", () => {
  it("concurrent reserves elect exactly one owner; a different PR proceeds", async () => {
    const { store } = await makeStore();
    const first = new PrWorkCoordinationStore({ stateDir: store.stateDir });
    const second = new PrWorkCoordinationStore({ stateDir: store.stateDir });
    const [a, b] = await Promise.all([
      reserveWork(first, reserveArgs(11, "race-a")),
      reserveWork(second, reserveArgs(11, "race-b")),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok)!;
    const winner = winners[0]!;
    if (loser.ok || !winner.ok) throw new Error("exactly one winner");
    expect(loser.reason).toBe("occupied");
    if (
      loser.record === null ||
      loser.record.owner === null ||
      winner.record.owner === null
    ) {
      throw new Error("both outcomes must expose the single owner");
    }
    expect(loser.record.owner.token).toBe(winner.record.owner.token);

    const other = await reserveWork(first, reserveArgs(12, "other-pr"));
    if (!other.ok) throw new Error("a different PR must proceed");
    expect(other.record.owner?.token).not.toBe(winner.record.owner?.token);
  });

  it("N separate processes against a dead-pid lock elect exactly one writer", async () => {
    const { root, store } = await makeStore();
    await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
    const lockDir = `${store.recordPath(REPO, 14)}.lock`;
    const pid = await deadPid();
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid, nonce: "dead-holder" }),
    );
    const workerPath = join(root, "contender.mts");
    await writeFile(
      workerPath,
      [
        `import { PrWorkCoordinationStore, reserveWork } from ${JSON.stringify(resolveModule())};`,
        `const store = new PrWorkCoordinationStore({ stateDir: process.env.SAYHEAR_STATE_DIR as string });`,
        `const outcome = await reserveWork(store, JSON.parse(process.env.SAYHEAR_RESERVE_ARGS as string));`,
        `process.stdout.write(JSON.stringify({ ok: outcome.ok, token: outcome.ok ? outcome.record.owner?.token ?? null : null, reason: outcome.ok ? null : outcome.reason }));`,
        ``,
      ].join("\n"),
    );
    const contenders = 6;
    const runs = await Promise.all(
      Array.from({ length: contenders }, (_, i) =>
        spawnContender(workerPath, store.stateDir, reserveArgs(14, `xproc-${i}`)),
      ),
    );
    const winners = runs.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.token).toMatch(/^[0-9a-f]{32}$/);
    const settled = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 14,
    });
    expect(settled?.owner?.token).toBe(winners[0]?.token);
  });
});

describe("null-session gap", () => {
  it("blocks a second writer until the token holder releases the gap", async () => {
    const { store } = await makeStore();
    const first = await reserveWork(store, reserveArgs(21, "gap"));
    if (!first.ok || first.record.owner === null) {
      throw new Error("initial reservation must succeed");
    }
    expect(first.record.owner.sessionId).toBeNull();
    const token = first.record.owner.token;

    const second = await reserveWork(store, reserveArgs(21, "gap-retry"));
    if (second.ok) throw new Error("null-session gap must block");
    expect(second.reason).toBe("occupied");

    // Without a token the sessionless gap never releases, whatever the
    // probe says; the probe is not even consulted.
    for (const probe of [running, unknown, stopped] as const) {
      let probed = false;
      const watching: ProbeWorker = async (owner) => {
        probed = true;
        return probe(owner);
      };
      const denied = await releaseWork(
        store,
        { repositoryId: REPO, pullRequestNumber: 21 },
        watching,
      );
      if (denied.ok) throw new Error("a tokenless release must keep occupancy");
      expect(denied.reason).toBe("token_mismatch");
      expect(denied.record?.owner?.token).toBe(token);
      expect(probed).toBe(false);
    }

    // A foreign token never releases the gap either.
    const foreign = await releaseWork(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 21,
        ownerToken: "1".repeat(32),
      },
      stopped,
    );
    if (foreign.ok) throw new Error("a foreign token must not release");
    expect(foreign.reason).toBe("token_mismatch");
    expect(foreign.record?.owner?.token).toBe(token);

    // The token holder releases the sessionless gap with no probe call.
    let probed = false;
    const watching: ProbeWorker = async () => {
      probed = true;
      return "stopped";
    };
    const cleared = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 21, ownerToken: token },
      watching,
    );
    if (!cleared.ok || !cleared.released) {
      throw new Error("the token holder must clear the sessionless gap");
    }
    expect(probed).toBe(false);
    expect(cleared.record?.owner).toBeNull();
    const retry = await reserveWork(store, reserveArgs(21, "gap-after"));
    if (!retry.ok) throw new Error("must proceed after holder release");
    expect(retry.record.owner?.token).not.toBe(token);
  });

  it("an undispatched predicate of false refuses inside the transaction; bound owners skip it", async () => {
    const { store } = await makeStore();
    const first = await reserveWork(store, reserveArgs(22, "predicate"));
    if (!first.ok || first.record.owner === null) {
      throw new Error("initial reservation must succeed");
    }
    const token = first.record.owner.token;
    // Predicate false: refused as dispatched, owner retained.
    let calls = 0;
    const refused = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 22, ownerToken: token },
      stopped,
      async () => {
        calls += 1;
        return false;
      },
    );
    if (refused.ok) throw new Error("a dispatched gap must not release");
    expect(refused.reason).toBe("dispatched_unattached");
    expect(refused.record?.owner?.token).toBe(token);
    expect(calls).toBe(1);
    // Predicate true: the same holder releases.
    const cleared = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 22, ownerToken: token },
      stopped,
      async () => true,
    );
    if (!cleared.ok || !cleared.released) {
      throw new Error("an undispatched gap must clear");
    }

    // Bound owners never consult the predicate: the probe path decides.
    const { store: boundStore, token: boundToken } = await reserveAttached(23, "predicate-bound");
    let boundCalls = 0;
    const denied = await releaseWork(
      boundStore,
      { repositoryId: REPO, pullRequestNumber: 23, ownerToken: boundToken },
      running,
      async () => {
        boundCalls += 1;
        return true;
      },
    );
    if (denied.ok) throw new Error("a running worker must keep occupancy");
    expect(denied.reason).toBe("worker_running");
    expect(boundCalls).toBe(0);
  });
});

describe("identity and late results", () => {
  it("token/head/scope mismatches reject; late live head retains pointers", async () => {
    const { store, token, sessionId } = await reserveAttached(31, "id");
    const base = {
      repositoryId: REPO,
      pullRequestNumber: 31,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation" as const,
      sessionId,
    };
    const bad = async (input: {
      ownerToken?: string;
      startHead?: string;
      scopeDigest?: string;
      role?: "implementation" | "code-review";
    }) => {
      const outcome = await attachSession(store, { ...base, ...input });
      if (outcome.ok) throw new Error("mismatched attach must fail");
      return outcome.reason;
    };
    expect(await bad({ ownerToken: "1".repeat(32) })).toBe("token_mismatch");
    expect(await bad({ startHead: HEAD_B })).toBe("head_mismatch");
    expect(await bad({ scopeDigest: SCOPE_B })).toBe("scope_mismatch");
    expect(await bad({ role: "code-review" })).toBe("role_mismatch");

    const late = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 31,
        ownerToken: token,
        sessionId,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_B,
      },
      stopped,
    );
    if (late.ok) throw new Error("late head must be rejected");
    expect(late.reason).toBe("live_head_mismatch");
    if (late.record === null || late.record.owner === null) {
      throw new Error("rejection must retain the record");
    }
    expect(late.record.owner.token).toBe(token);
    expect(late.record.owner.worktree).toBe("/tmp/sayhear-prwork-id-wt");
    expect(late.record.phase).toBe("running");

    const busy = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 31,
        ownerToken: token,
        sessionId,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      running,
    );
    if (busy.ok) throw new Error("running worker must block accept");
    expect(busy.reason).toBe("worker_running");

    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 31,
        ownerToken: token,
        sessionId,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("matching stopped result must verify");
    expect(accepted.record.phase).toBe("verifying");
  });
});

describe("controller ledger gates new reservations", () => {
  it("paused, inconsistent, or >=3 refuse first, before occupied", async () => {
    const { store } = await makeStore();
    const paused = await reserveWork(
      store,
      reserveArgs(41, "ledger", {
        ledger: { roundsConsumed: 0, paused: true, historyConsistent: true, latestReviewedHead: HEAD_A },
      }),
    );
    if (paused.ok) throw new Error("paused ledger must refuse");
    expect(paused.reason).toBe("paused");

    const inconsistent = await reserveWork(
      store,
      reserveArgs(41, "ledger", {
        ledger: { roundsConsumed: 0, paused: false, historyConsistent: false, latestReviewedHead: HEAD_A },
      }),
    );
    if (inconsistent.ok) throw new Error("inconsistent ledger must refuse");
    expect(inconsistent.reason).toBe("history_inconsistent");

    const exhausted = await reserveWork(
      store,
      reserveArgs(41, "ledger", {
        ledger: { roundsConsumed: 3, paused: false, historyConsistent: true, latestReviewedHead: HEAD_A },
      }),
    );
    if (exhausted.ok) throw new Error("exhausted ledger must refuse");
    expect(exhausted.reason).toBe("rounds_exhausted");

    // A ledger one round short of the cap still allows a writer.
    const lastRound = await reserveWork(
      store,
      reserveArgs(42, "ledger-two", {
        ledger: { roundsConsumed: 2, paused: false, historyConsistent: true, latestReviewedHead: HEAD_A },
      }),
    );
    if (!lastRound.ok) throw new Error("roundsConsumed 2 must still reserve");
    expect(lastRound.record.owner?.sessionId).toBeNull();

    const open = await reserveWork(store, reserveArgs(41, "ledger"));
    if (!open.ok) throw new Error("open ledger must reserve");

    const blocked = await reserveWork(
      store,
      reserveArgs(41, "ledger-retry", {
        startHead: HEAD_B,
        ledger: { roundsConsumed: 9, paused: true, historyConsistent: false, latestReviewedHead: HEAD_A },
      }),
    );
    if (blocked.ok) throw new Error("permanent reasons precede occupied");
    expect(blocked.reason).toBe("paused");
  });
});

describe("sessions", () => {
  it("implementation resumes the same session; a different one conflicts", async () => {
    const { store, token, sessionId } = await reserveAttached(51, "impl");
    const base = {
      repositoryId: REPO,
      pullRequestNumber: 51,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation" as const,
    };
    const resumed = await attachSession(store, { ...base, sessionId });
    if (!resumed.ok || !resumed.resumed) {
      throw new Error("same session must resume");
    }
    const conflict = await attachSession(store, {
      ...base,
      sessionId: "sess-other",
    });
    if (conflict.ok) throw new Error("another session must conflict");
    expect(conflict.reason).toBe("session_conflict");
  });

  it("implementation may resume its original session after release + new reservation", async () => {
    const { store } = await makeStore();
    const again = new PrWorkCoordinationStore({ stateDir: store.stateDir });
    const first = await reserveWork(store, reserveArgs(52, "impl-cycle"));
    if (!first.ok || first.record.owner === null) {
      throw new Error("first reservation must succeed");
    }
    const token = first.record.owner.token;
    const attached = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 52,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-cycle",
    });
    if (!attached.ok) throw new Error("attach must succeed");
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 52, ownerToken: token },
      stopped,
    );
    if (!released.ok || !released.released) {
      throw new Error("stopped release must clear");
    }
    const second = await reserveWork(again, reserveArgs(52, "impl-cycle-2"));
    if (!second.ok || second.record.owner === null) {
      throw new Error("second reservation must succeed");
    }
    expect(second.record.owner.token).not.toBe(token);
    const reattached = await attachSession(again, {
      repositoryId: REPO,
      pullRequestNumber: 52,
      ownerToken: second.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-cycle",
    });
    // The original implementation session may rebind under the new owner
    // (head/scope rechecked above) without growing the session history.
    if (!reattached.ok || reattached.resumed) {
      throw new Error("the original implementation session must rebind");
    }
    expect(reattached.record.seenSessions).toHaveLength(1);
    expect(reattached.record.seenSessions[0]).toEqual({
      id: "sess-cycle",
      role: "implementation",
      model: null,
    });

    const conflict = await attachSession(again, {
      repositoryId: REPO,
      pullRequestNumber: 52,
      ownerToken: second.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-cycle-2",
    });
    // A different session never silently replaces the bound one.
    if (conflict.ok) throw new Error("another session must conflict");
    expect(conflict.reason).toBe("session_conflict");
    const resumed = await attachSession(again, {
      repositoryId: REPO,
      pullRequestNumber: 52,
      ownerToken: second.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-cycle",
    });
    if (!resumed.ok || !resumed.resumed) {
      throw new Error("its own current session must resume");
    }
  });

  it("a code-review owner completes its own work under its own session", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(
      store,
      reserveArgs(53, "review-owner", { role: "code-review" }),
    );
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("code-review reservation must succeed");
    }
    const token = reserved.record.owner.token;
    const attached = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 53,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: "sess-review",
    });
    if (!attached.ok) throw new Error("code-review attach must succeed");
    const noted = await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 53,
      ownerToken: token,
      key: "nit",
      status: "confirmed",
      evidence: "line 12",
    });
    if (!noted.ok) throw new Error("review owner must record findings");
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 53,
        ownerToken: token,
        sessionId: "sess-review",
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("review owner must complete its work");
    expect(accepted.record.phase).toBe("verifying");
  });
});

describe("findings disposition", () => {
  it("confirmed finding reappearing after an accepted fix reports repeated", async () => {
    const { store, token } = await reserveAttached(61, "repeat");
    const input = {
      repositoryId: REPO,
      pullRequestNumber: 61,
      ownerToken: token,
      key: "missing-guard",
      status: "confirmed" as const,
      evidence: "repro on controlled PR",
      repairDirective: "restore the guard",
    };
    const first = await recordFinding(store, input);
    if (!first.ok || first.repeated) {
      throw new Error("first confirmation is not a repeat");
    }
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 61,
        ownerToken: token,
        sessionId: "sess-repeat",
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("fix result must be accepted");
    const again = await recordFinding(store, {
      ...input,
      evidence: "same guard missing after fix",
    });
    if (!again.ok || !again.repeated) {
      throw new Error("reappearing confirmed finding must report repeated");
    }
    // The escalation latch is sticky in storage but `repeated` is reported
    // only for an incoming confirmed disposition: a later refutation returns
    // false while preserving the stored repeat, so a re-confirm still
    // reports true.
    const refuted = await recordFinding(store, {
      ...input,
      status: "refuted",
      evidence: "not actually missing",
    });
    if (!refuted.ok || refuted.repeated) {
      throw new Error("a refuted disposition must not report repeated");
    }
    expect(refuted.record.findings.find((f) => f.key === "missing-guard")?.repeatedAfterFix).toBe(true);
    const reconfirmed = await recordFinding(store, {
      ...input,
      evidence: "confirmed again after refutation",
    });
    if (!reconfirmed.ok || !reconfirmed.repeated) {
      throw new Error("re-confirm must still report the latched repeat");
    }
  });

  it("multibyte evidence near the byte budget is refused structurally", async () => {
    const { store, token } = await reserveAttached(62, "sizes");
    for (let i = 0; i < 3; i += 1) {
      const outcome = await recordFinding(store, {
        repositoryId: REPO,
        pullRequestNumber: 62,
        ownerToken: token,
        key: `pad-${i}`,
        status: "refuted",
        evidence: "好".repeat(4000),
      });
      if (!outcome.ok) throw new Error(`pad finding ${i} must fit`);
    }
    const oversize = await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 62,
      ownerToken: token,
      key: "overflow",
      status: "confirmed",
      evidence: "好".repeat(24000),
    });
    if (oversize.ok) throw new Error("oversize finding must be refused");
    expect(oversize.reason).toBe("too_large");
    const settled = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 62,
    });
    expect(settled?.findings).toHaveLength(3);
  });

  it("a re-record before any accept is not repeated, and a code-review accept does not arm it", async () => {
    const { store, token } = await reserveAttached(63, "preaccept");
    const input = {
      repositoryId: REPO,
      pullRequestNumber: 63,
      ownerToken: token,
      key: "race-cond",
      status: "confirmed" as const,
      evidence: "seen in review",
    };
    const first = await recordFinding(store, input);
    if (!first.ok || first.repeated) {
      throw new Error("first confirmation is not a repeat");
    }
    // Re-confirming the same key before any accepted fix must stay false.
    const again = await recordFinding(store, { ...input, evidence: "still seen" });
    if (!again.ok || again.repeated) {
      throw new Error("re-record before any accept must not report repeated");
    }
    await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 63,
        ownerToken: token,
        sessionId: "sess-preaccept",
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    const third = await recordFinding(store, { ...input, evidence: "third look" });
    if (!third.ok || !third.repeated) {
      throw new Error("re-record after an accepted implementation fix repeats");
    }
    // The repeat signal is sticky: a retried record still reports it.
    const retried = await recordFinding(store, { ...input, evidence: "retry" });
    if (!retried.ok || !retried.repeated) {
      throw new Error("the repeat signal must survive a retry");
    }

    // A code-review accept must not arm findings as fixed.
    const review = await reserveWork(
      store,
      reserveArgs(64, "review-arm", { role: "code-review" }),
    );
    if (!review.ok || review.record.owner === null) {
      throw new Error("review reservation must succeed");
    }
    const reviewToken = review.record.owner.token;
    const reviewAttach = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 64,
      ownerToken: reviewToken,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: "sess-review-arm",
    });
    if (!reviewAttach.ok) throw new Error("review attach must succeed");
    await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 64,
      ownerToken: reviewToken,
      key: "review-only",
      status: "confirmed",
      evidence: "reviewer confirmed",
    });
    const reviewAccept = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 64,
        ownerToken: reviewToken,
        sessionId: "sess-review-arm",
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!reviewAccept.ok) throw new Error("review accept must succeed");
    const armed = reviewAccept.record.findings.find(
      (f) => f.key === "review-only",
    );
    expect(armed?.fixedAccepted).toBe(false);
    const repeatAfterReview = await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 64,
      ownerToken: reviewToken,
      key: "review-only",
      status: "confirmed",
      evidence: "reviewer confirmed again",
    });
    if (!repeatAfterReview.ok || repeatAfterReview.repeated) {
      throw new Error("a code-review accept must not arm the repeat signal");
    }
  });

  it("a session id seen for this PR is refused for a later code-review attach", async () => {
    const { store } = await makeStore();
    const impl = await reserveWork(store, reserveArgs(65, "seen-impl"));
    if (!impl.ok || impl.record.owner === null) {
      throw new Error("implementation reservation must succeed");
    }
    const implToken = impl.record.owner.token;
    const implAttach = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 65,
      ownerToken: implToken,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-shared",
    });
    if (!implAttach.ok) throw new Error("implementation attach must succeed");
    await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 65, ownerToken: implToken },
      stopped,
    );

    const review = await reserveWork(
      store,
      reserveArgs(65, "seen-review", { role: "code-review" }),
    );
    if (!review.ok || review.record.owner === null) {
      throw new Error("review reservation must succeed");
    }
    const recycled = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 65,
      ownerToken: review.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: "sess-shared",
    });
    if (recycled.ok) throw new Error("a seen session id must not be reused");
    expect(recycled.reason).toBe("stale_review_session");

    const fresh = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 65,
      ownerToken: review.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: "sess-review-new",
    });
    if (!fresh.ok) throw new Error("a fresh review session must attach");

    // An implementation owner may never reuse a review-role session id.
    await releaseWork(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 65,
        ownerToken: review.record.owner.token,
      },
      stopped,
    );
    const implAgain = await reserveWork(store, reserveArgs(65, "seen-impl-2"));
    if (!implAgain.ok || implAgain.record.owner === null) {
      throw new Error("implementation reservation must succeed");
    }
    const implReuse = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 65,
      ownerToken: implAgain.record.owner.token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-review-new",
    });
    if (implReuse.ok) throw new Error("a review-role id must not be reused");
    expect(implReuse.reason).toBe("stale_review_session");
  });

  it("a 65th distinct finding is refused structurally and leaves the record unchanged", async () => {
    const { store, token } = await reserveAttached(68, "cap");
    for (let i = 0; i < 64; i += 1) {
      const outcome = await recordFinding(store, {
        repositoryId: REPO,
        pullRequestNumber: 68,
        ownerToken: token,
        key: `cap-${i}`,
        status: "refuted",
        evidence: `e${i}`,
      });
      if (!outcome.ok) throw new Error(`finding ${i} must fit`);
    }
    const before = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 68,
    });
    const refused = await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 68,
      ownerToken: token,
      key: "cap-64",
      status: "confirmed",
      evidence: "over the key cap",
    });
    if (refused.ok) throw new Error("the 65th distinct key must be refused");
    expect(refused.reason).toBe("too_large");
    const after = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 68,
    });
    expect(after?.findings).toHaveLength(64);
    expect(after).toEqual(before);
    // Updating an existing key at the limit stays allowed.
    const updated = await recordFinding(store, {
      repositoryId: REPO,
      pullRequestNumber: 68,
      ownerToken: token,
      key: "cap-0",
      status: "confirmed",
      evidence: "update at the cap",
    });
    if (!updated.ok || updated.repeated) {
      throw new Error("existing-key update at the limit must succeed");
    }
    expect(updated.record.findings).toHaveLength(64);
  });

  it("re-attaching after verifying is refused", async () => {
    const { store, token, sessionId } = await reserveAttached(66, "verified");
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 66,
        ownerToken: token,
        sessionId,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("accept must succeed");
    const reattach = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 66,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId,
    });
    if (reattach.ok) throw new Error("re-attach after verifying must be refused");
    expect(reattach.reason).toBe("stale_review_session");
  });
});

describe("overlapping runs", () => {
  it("no probe window on the sessionless path: a would-be racing attach never lands", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(67, "overlap"));
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("reservation must succeed");
    }
    const token = reserved.record.owner.token;
    // The sessionless holder release never invokes the probe, so an attach
    // smuggled into the probe callback (the old race) cannot land: the gap
    // clears and the callback never runs.
    let raced = false;
    const probe: ProbeWorker = async () => {
      raced = true;
      await attachSession(store, {
        repositoryId: REPO,
        pullRequestNumber: 67,
        ownerToken: token,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        role: "implementation",
        sessionId: "sess-overlap",
      });
      return "stopped";
    };
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 67, ownerToken: token },
      probe,
    );
    if (!released.ok || !released.released) {
      throw new Error("the sessionless holder release must clear the gap");
    }
    expect(raced).toBe(false);
    expect(released.record?.owner).toBeNull();
    const retry = await reserveWork(store, reserveArgs(67, "overlap-2"));
    if (!retry.ok) throw new Error("must proceed after holder release");
  });

  it("a same-session re-attach between snapshot and probe blocks release", async () => {
    const { store, token, sessionId } = await reserveAttached(69, "regen-rel");
    // The probe runs outside the lock; a same-session resume landing there
    // bumps generation without changing token/session/phase, so only the
    // generation compare can refuse the stale stopped proof.
    let reattachState: { result: Awaited<ReturnType<typeof attachSession>> | null } = { result: null };
    let raced = false;
    const probe: ProbeWorker = async () => {
      if (!raced) {
        raced = true;
        reattachState.result = await attachSession(store, {
          repositoryId: REPO,
          pullRequestNumber: 69,
          ownerToken: token,
          startHead: HEAD_A,
          scopeDigest: SCOPE_A,
          role: "implementation",
          sessionId,
        });
      }
      return "stopped";
    };
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 69, ownerToken: token },
      probe,
    );
    // resolveProbe swallows probe throws as unknown, so the attach must be
    // asserted here: a failed re-attach would otherwise false-pass below.
    const reattached = reattachState.result;
    if (reattached === null) throw new Error("probe must run the re-attach");
    if (!reattached.ok || !reattached.resumed) {
      throw new Error("same-session re-attach must resume");
    }
    if (released.ok) throw new Error("stale stopped proof must not release a resumed writer");
    expect(released.reason).toBe("worker_unknown");
    expect(released.record?.owner?.token).toBe(token);
    expect(released.record?.owner?.sessionId).toBe(sessionId);
    const settled = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 69,
    });
    expect(settled?.owner?.token).toBe(token);
    const blocked = await reserveWork(store, reserveArgs(69, "regen-rel-2"));
    if (blocked.ok) throw new Error("the resumed owner must block a new writer");
    expect(blocked.reason).toBe("occupied");
  });

  it("a same-session re-attach between snapshot and probe blocks accept", async () => {
    const { store, token, sessionId } = await reserveAttached(70, "regen-acc");
    let reattachState: { result: Awaited<ReturnType<typeof attachSession>> | null } = { result: null };
    let raced = false;
    const probe: ProbeWorker = async () => {
      if (!raced) {
        raced = true;
        reattachState.result = await attachSession(store, {
          repositoryId: REPO,
          pullRequestNumber: 70,
          ownerToken: token,
          startHead: HEAD_A,
          scopeDigest: SCOPE_A,
          role: "implementation",
          sessionId,
        });
      }
      return "stopped";
    };
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 70,
        ownerToken: token,
        sessionId,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      probe,
    );
    // resolveProbe swallows probe throws as unknown, so the attach must be
    // asserted here: a failed re-attach would otherwise false-pass below.
    const reattached = reattachState.result;
    if (reattached === null) throw new Error("probe must run the re-attach");
    if (!reattached.ok || !reattached.resumed) {
      throw new Error("same-session re-attach must resume");
    }
    if (accepted.ok) throw new Error("stale stopped proof must not accept for a resumed writer");
    expect(accepted.reason).toBe("worker_unknown");
    expect(accepted.record?.owner?.token).toBe(token);
    expect(accepted.record?.phase).toBe("running");
  });
});

describe("filesystem safety", () => {
  it("uses 0700 dirs and 0600 files; malformed identity never touches disk", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(71, "modes"));
    if (!reserved.ok) throw new Error("reservation must succeed");
    expect((await stat(store.stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.recordPath(REPO, 71))).mode & 0o777).toBe(0o600);
    await expect(
      reserveWork(store, reserveArgs(72, "bad", { startHead: "short" })),
    ).rejects.toMatchObject({ name: "PrWorkCoordinationError" });
    // No record file may exist for a rejected identity.
    expect(await readWork(store, { repositoryId: REPO, pullRequestNumber: 72 })).toBeNull();
  });

  it("corrupt JSON fails closed and keeps its bytes", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(73, "corrupt"));
    if (!reserved.ok) throw new Error("reservation must succeed");
    await writeFile(store.recordPath(REPO, 73), "{not json");
    const outcome = await reserveWork(store, reserveArgs(73, "corrupt-retry"));
    if (outcome.ok) throw new Error("corrupt record must fail closed");
    expect(outcome.reason).toBe("corrupt");
    expect(await readFile(store.recordPath(REPO, 73), "utf8")).toBe(
      "{not json",
    );
  });

  it("symlinked record and state paths are untrusted", async () => {
    const { root, store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(74, "link"));
    if (!reserved.ok) throw new Error("reservation must succeed");
    const target = join(root, "external.json");
    await writeFile(target, "{}");
    await rm(store.recordPath(REPO, 74));
    await symlink(target, store.recordPath(REPO, 74));
    expect((await lstat(store.recordPath(REPO, 74))).isSymbolicLink()).toBe(
      true,
    );
    const outcome = await reserveWork(
      store,
      reserveArgs(74, "link-retry", { startHead: HEAD_B }),
    );
    if (outcome.ok) throw new Error("symlinked record must fail closed");
    expect(outcome.reason).toBe("untrusted");

    const realDir = join(root, "real-state");
    await mkdir(realDir, { recursive: true });
    const linked = new PrWorkCoordinationStore({
      stateDir: join(root, "linked-state"),
    });
    await cp(realDir, linked.stateDir, { recursive: true });
    await rm(linked.stateDir, { recursive: true });
    await symlink(realDir, linked.stateDir);
    await expect(
      readWork(linked, { repositoryId: REPO, pullRequestNumber: 74 }),
    ).rejects.toMatchObject({ name: "PrWorkCoordinationError" });
  });

  it("a lock without complete metadata stays unknown until removed by hand", async () => {
    const { store } = await makeStore();
    await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
    const lockDir = `${store.recordPath(REPO, 75)}.lock`;
    await mkdir(lockDir);
    try {
      await expect(
        reserveWork(store, reserveArgs(75, "ambiguous")),
      ).rejects.toMatchObject({ name: "PrWorkCoordinationError" });
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
    const retry = await reserveWork(store, reserveArgs(75, "ambiguous-retry"));
    if (!retry.ok) {
      throw new Error("record must be writable once the stray lock is gone");
    }
  });

  it("a dead lock is not reclaimed while a stale .reclaim guard exists", async () => {
    const { store } = await makeStore();
    await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
    const pid = await deadPid();
    const lockDir = `${store.recordPath(REPO, 76)}.lock`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid, nonce: "dead-holder" }),
    );
    // A reclaimer killed while holding the guard leaves it behind; reclaim then
    // fails closed instead of stealing the lock.
    await mkdir(`${lockDir}.reclaim`, { recursive: true });
    await expect(
      reserveWork(store, reserveArgs(76, "guarded")),
    ).rejects.toMatchObject({
      name: "PrWorkCoordinationError",
      code: "lock_unknown",
    });
    await rm(`${lockDir}.reclaim`, { recursive: true, force: true });
    const retry = await reserveWork(store, reserveArgs(76, "guarded-retry"));
    if (!retry.ok) throw new Error("reclaim must succeed once the guard is gone");
  });

  it("a live-pid lock is never reclaimed", async () => {
    const { store } = await makeStore();
    await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    const pid = live.pid;
    if (pid === undefined) throw new Error("no child pid");
    try {
      const lockDir = `${store.recordPath(REPO, 77)}.lock`;
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid, nonce: "live-holder" }),
      );
      await expect(
        reserveWork(store, reserveArgs(77, "livelock")),
      ).rejects.toMatchObject({
        name: "PrWorkCoordinationError",
        code: "lock_unknown",
      });
    } finally {
      live.kill("SIGKILL");
      await new Promise<void>((done) => {
        live.on("exit", () => done());
        live.on("error", () => done());
      });
    }
  });
});

describe("byte budget on every write path", () => {
  it("a near-full record refuses the growing write as too_large and stays readable", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(81, "budget"));
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("reservation must succeed");
    }
    const token = reserved.record.owner.token;
    // Fill close to the writer's own limit; every accepted write must keep
    // the record readable.
    let filled = 0;
    for (let i = 0; i < 8; i += 1) {
      const outcome = await recordFinding(store, {
        repositoryId: REPO,
        pullRequestNumber: 81,
        ownerToken: token,
        key: `pad-${i}`,
        status: "refuted",
        evidence: "好".repeat(14_000),
      });
      if (!outcome.ok) {
        expect(outcome.reason).toBe("too_large");
        break;
      }
      filled += 1;
    }
    expect(filled).toBeGreaterThan(0);
    const readable = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 81,
    });
    expect(readable?.findings).toHaveLength(filled);
    // A subsequent attach (which adds a session id to that record) is refused
    // structurally rather than corrupting it.
    const attach = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 81,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "s".repeat(256),
    });
    if (!attach.ok) expect(attach.reason).toBe("too_large");
    expect(
      (await readWork(store, { repositoryId: REPO, pullRequestNumber: 81 }))
        ?.version,
    ).toBe(1);
  });
});

describe("review binding and repeat escalation (P2-1/P2-2)", () => {
  it("refuses implementation reserve unless the controller review covers the head", async () => {
    const { store } = await makeStore();
    const unreviewed = await reserveWork(
      store,
      reserveArgs(91, "unreviewed", {
        ledger: { roundsConsumed: 0, paused: false, historyConsistent: true, latestReviewedHead: null },
      }),
    );
    if (unreviewed.ok) throw new Error("null reviewed head must refuse");
    expect(unreviewed.reason).toBe("review_not_recorded");
    const stale = await reserveWork(
      store,
      reserveArgs(91, "stale-review", {
        ledger: { roundsConsumed: 0, paused: false, historyConsistent: true, latestReviewedHead: HEAD_B },
      }),
    );
    if (stale.ok) throw new Error("a review for another head must refuse");
    expect(stale.reason).toBe("review_not_recorded");
    const fresh = await reserveWork(store, reserveArgs(91, "reviewed"));
    if (!fresh.ok) throw new Error("a review covering the head must reserve");
  });

  it("code-review reservations bypass the review binding", async () => {
    const { store } = await makeStore();
    const out = await reserveWork(
      store,
      reserveArgs(92, "review-bypass", {
        role: "code-review",
        ledger: { roundsConsumed: 0, paused: false, historyConsistent: true, latestReviewedHead: null },
      }),
    );
    if (!out.ok) throw new Error("code-review must bypass the review binding");
  });

  it("a repeated finding after an accepted fix blocks the next implementation reserve", async () => {
    const { store, token } = await reserveAttached(93, "repeat-block");
    const input = {
      repositoryId: REPO,
      pullRequestNumber: 93,
      ownerToken: token,
      key: "missing-guard",
      status: "confirmed" as const,
      evidence: "repro on controlled PR",
    };
    const first = await recordFinding(store, input);
    if (!first.ok || first.repeated) throw new Error("first confirmation is not a repeat");
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: 93,
        ownerToken: token,
        sessionId: "sess-repeat-block",
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("fix result must be accepted");
    const again = await recordFinding(store, { ...input, evidence: "same guard missing after fix" });
    if (!again.ok || !again.repeated) throw new Error("reappearance must report repeated");
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 93, ownerToken: token },
      stopped,
    );
    if (!released.ok || !released.released) throw new Error("stopped release must clear");
    const next = await reserveWork(store, reserveArgs(93, "repeat-block-2"));
    if (next.ok) throw new Error("a repeated finding must block the next implementation fix");
    expect(next.reason).toBe("repeated_finding");
    // The refusal preserves the record: findings and history are intact.
    expect(next.record?.findings.some((finding) => finding.repeatedAfterFix)).toBe(true);
  });
});

describe("worker model pinning (P2-3)", () => {
  it("records the attach model and refuses a resume on a changed model", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(94, "model-pin"));
    if (!reserved.ok || reserved.record.owner === null) throw new Error("reservation must succeed");
    const token = reserved.record.owner.token;
    const attach = (sessionId: string, model: string | null) =>
      attachSession(store, {
        repositoryId: REPO,
        pullRequestNumber: 94,
        ownerToken: token,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        role: "implementation",
        sessionId,
        ...(model === null ? {} : { model }),
      });
    const first = await attach("sess-model", "magpie/group/group#high");
    if (!first.ok || first.resumed) throw new Error("first attach must succeed");
    expect(first.record.owner?.model).toBe("magpie/group/group#high");
    const same = await attach("sess-model", "magpie/group/group#high");
    if (!same.ok || !same.resumed) throw new Error("same-model resume must succeed");
    const changed = await attach("sess-model", "magpie/group/other#low");
    if (changed.ok) throw new Error("a changed model must refuse");
    expect(changed.reason).toBe("model_changed");
    // The refusal preserves the owner and its files-side state.
    expect(changed.record?.owner?.sessionId).toBe("sess-model");
    expect(changed.record?.owner?.model).toBe("magpie/group/group#high");
  });
});

describe("sessionless release edge cases (#389)", () => {
  it("a session attached before the holder release keeps the probe path", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(95, "attach-race"));
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("reservation must succeed");
    }
    const token = reserved.record.owner.token;
    // A session attached after the snapshot means the owner is now bound:
    // the holder release must take the normal probe path (no bypass) and
    // clear only with stopped proof.
    const attached = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 95,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "implementation",
      sessionId: "sess-late",
    });
    if (!attached.ok) throw new Error("attach must succeed");
    let probed = false;
    const watching: ProbeWorker = async () => {
      probed = true;
      return "stopped";
    };
    const outcome = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 95, ownerToken: token },
      watching,
    );
    if (!outcome.ok || !outcome.released) {
      throw new Error("bound holder release with stopped proof must clear");
    }
    expect(probed).toBe(true);
  });

  it("a bound-owner release still probes after the sessionless fast path lands", async () => {
    const { store, token } = await reserveAttached(96, "bound-probe");
    for (const [probe, reason] of [
      [running, "worker_running"],
      [unknown, "worker_unknown"],
    ] as const) {
      const denied = await releaseWork(
        store,
        { repositoryId: REPO, pullRequestNumber: 96, ownerToken: token },
        probe,
      );
      if (denied.ok) throw new Error(`${reason} must keep occupancy`);
      expect(denied.reason).toBe(reason);
    }
    const cleared = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 96, ownerToken: token },
      stopped,
    );
    if (!cleared.ok || !cleared.released) {
      throw new Error("stopped proof must clear the bound owner");
    }
  });

  it("concurrent attach vs holder release never frees a bound owner", async () => {
    // The sessionless release takes no probe window, so a real
    // snapshot/commit race cannot be injected deterministically; instead
    // race attach against release and assert every outcome is safe: either
    // the release won before any session existed, or the attach won (or the
    // owner was already cleared) — never "released while bound".
    for (let round = 0; round < 10; round += 1) {
      const pr = 900 + round;
      const { store } = await makeStore();
      const reserved = await reserveWork(store, reserveArgs(pr, `race-${round}`));
      if (!reserved.ok || reserved.record.owner === null) {
        throw new Error("reservation must succeed");
      }
      const token = reserved.record.owner.token;
      const input = { repositoryId: REPO, pullRequestNumber: pr, ownerToken: token };
      const base = {
        repositoryId: REPO,
        pullRequestNumber: pr,
        ownerToken: token,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        role: "implementation" as const,
      };
      const [attached, outcome] = await Promise.all([
        attachSession(store, { ...base, sessionId: `sess-race-${round}` }),
        releaseWork(store, input, stopped),
      ]);
      // The safety invariant: never "released while a bound owner is
      // retained". Both released orders are safe: either the release won
      // outright (losing attach finds no owner) or the attach won first and
      // the release cleared via the stopped-probe bound path. Either way the
      // final owner is null. A refused release must retain the bound owner.
      const settled = await readWork(store, {
        repositoryId: REPO,
        pullRequestNumber: pr,
      });
      if (outcome.ok && outcome.released) {
        expect(settled?.owner).toBeNull();
      } else if (!outcome.ok && outcome.reason === "worker_unknown") {
        // Release lost to a now-bound owner: occupancy retained.
        expect(attached.ok).toBe(true);
        expect(settled?.owner?.sessionId).toBe(`sess-race-${round}`);
        const blocked = await reserveWork(store, reserveArgs(pr, `race-${round}-retry`));
        if (blocked.ok) throw new Error("the bound owner must block");
        expect(blocked.reason).toBe("occupied");
      } else {
        throw new Error(`unexpected race outcome: ${JSON.stringify(outcome)}`);
      }
    }
  });
});

describe("already-reviewed refusal (#389)", () => {
  const reviewLedger: TrustedLedger = {
    roundsConsumed: 0,
    paused: false,
    historyConsistent: true,
    latestReviewedHead: null,
  };

  async function acceptReview(pr: number, tag: string) {
    const { store } = await makeStore();
    const reserved = await reserveWork(
      store,
      reserveArgs(pr, tag, { role: "code-review", ledger: reviewLedger }),
    );
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("code-review reservation must succeed");
    }
    const token = reserved.record.owner.token;
    const attached = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: pr,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: `sess-review-${tag}`,
    });
    if (!attached.ok) throw new Error("code-review attach must succeed");
    const accepted = await acceptResult(
      store,
      {
        repositoryId: REPO,
        pullRequestNumber: pr,
        ownerToken: token,
        sessionId: `sess-review-${tag}`,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        liveHead: HEAD_A,
      },
      stopped,
    );
    if (!accepted.ok) throw new Error("code-review accept must succeed");
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: pr, ownerToken: token },
      stopped,
    );
    if (!released.ok || !released.released) {
      throw new Error("release after accept must clear");
    }
    return { store };
  }

  it("code-review reserve for the same head + changeDigest is refused after accept", async () => {
    const { store } = await acceptReview(97, "dup");
    const dup = await reserveWork(
      store,
      reserveArgs(97, "dup-2", { role: "code-review", ledger: reviewLedger }),
    );
    if (dup.ok) throw new Error("a duplicate reviewer must be refused");
    expect(dup.reason).toBe("already_reviewed");
    expect(dup.record?.owner).toBeNull();
  });

  it("explicit re-review bypasses only already_reviewed; other checks still apply", async () => {
    const { store } = await acceptReview(98, "rereview");
    const again = await reserveWork(
      store,
      reserveArgs(98, "rereview-2", {
        role: "code-review",
        ledger: reviewLedger,
        reReview: true,
      }),
    );
    if (!again.ok || again.record.owner === null) {
      throw new Error("an explicit re-review must reserve");
    }
    // Non-boolean reReview is rejected structurally.
    await expect(
      reserveWork(
        store,
        reserveArgs(98, "rereview-bad", {
          role: "code-review",
          ledger: reviewLedger,
          reReview: "yes" as unknown as boolean,
        }),
      ),
    ).rejects.toMatchObject({ name: "PrWorkCoordinationError" });
  });

  it("a different changeDigest reserves; an implementation reservation is unaffected", async () => {
    const { store } = await acceptReview(99, "evolve");
    const changed = await reserveWork(
      store,
      reserveArgs(99, "evolve-2", {
        role: "code-review",
        ledger: reviewLedger,
        changeDigest: "f".repeat(64),
      }),
    );
    if (!changed.ok) throw new Error("a changed tree must allow a new review");
    const impl = await reserveWork(store, reserveArgs(100, "impl-unaffected"));
    if (!impl.ok) throw new Error("implementation reservations ignore review memory");
  });

  it("a legacy record without acceptedReviews parses and reserves", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(
      store,
      reserveArgs(101, "legacy", { role: "code-review", ledger: reviewLedger }),
    );
    if (!reserved.ok) throw new Error("initial reservation must succeed");
    // Strip the field to simulate a record written before this change.
    const path = store.recordPath(REPO, 101);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete raw.acceptedReviews;
    await writeFile(path, JSON.stringify(raw));
    const settled = await readWork(store, {
      repositoryId: REPO,
      pullRequestNumber: 101,
    });
    expect(settled?.acceptedReviews).toEqual([]);
    // Owner still held: a second reserve is occupied, not already_reviewed.
    const blocked = await reserveWork(
      store,
      reserveArgs(101, "legacy-2", { role: "code-review", ledger: reviewLedger }),
    );
    if (blocked.ok) throw new Error("the legacy owner must still block");
    expect(blocked.reason).toBe("occupied");
  });

  it("malformed acceptedReviews fail closed; the list caps at 20, oldest dropped", async () => {
    const { store } = await makeStore();
    const good = { head: HEAD_A, changeDigest: CHANGE_A, sessionId: "sess-ok" };
    const variants: Array<[string, unknown]> = [
      ["non-array", {}],
      ["overlong", Array.from({ length: 21 }, () => ({ ...good }))],
      ["unknown field", [{ ...good, extra: 1 }]],
      ["bad head hex", [{ ...good, head: "z".repeat(40) }]],
      ["short head", [{ ...good, head: "a".repeat(39) }]],
      ["uppercase head", [{ ...good, head: "A".repeat(40) }]],
      ["bad digest", [{ ...good, changeDigest: "q".repeat(64) }]],
      ["empty session", [{ ...good, sessionId: "" }]],
    ];
    for (const [index, [label, acceptedReviews]] of variants.entries()) {
      const pr = 1100 + index;
      const reserved = await reserveWork(
        store,
        reserveArgs(pr, `parse-${index}`, { role: "code-review", ledger: reviewLedger }),
      );
      if (!reserved.ok) throw new Error("reservation must succeed");
      const path = store.recordPath(REPO, pr);
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      raw.acceptedReviews = acceptedReviews;
      await writeFile(path, JSON.stringify(raw));
      const outcome = await reserveWork(
        store,
        reserveArgs(pr, `parse-${index}-retry`, { role: "code-review", ledger: reviewLedger }),
      );
      if (outcome.ok) throw new Error(`${label} must fail closed`);
      expect(outcome.reason, label).toBe("corrupt");
      expect(outcome.record).toBeNull();
    }
    // Cap: 21 sequential accepts keep the newest 20.
    const capPr = 1200;
    const capStore = store;
    const seen: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const digest = i.toString(16).padStart(64, "0");
      const r = await reserveWork(
        capStore,
        reserveArgs(capPr, `cap-${i}`, { role: "code-review", ledger: reviewLedger, changeDigest: digest }),
      );
      if (!r.ok || r.record.owner === null) throw new Error(`reserve ${i} must succeed`);
      const token = r.record.owner.token;
      const sid = `sess-cap-${i}`;
      const attached = await attachSession(capStore, {
        repositoryId: REPO,
        pullRequestNumber: capPr,
        ownerToken: token,
        startHead: HEAD_A,
        scopeDigest: SCOPE_A,
        role: "code-review",
        sessionId: sid,
      });
      if (!attached.ok) throw new Error(`attach ${i} must succeed`);
      const accepted = await acceptResult(
        capStore,
        {
          repositoryId: REPO,
          pullRequestNumber: capPr,
          ownerToken: token,
          sessionId: sid,
          startHead: HEAD_A,
          scopeDigest: SCOPE_A,
          liveHead: HEAD_A,
        },
        stopped,
      );
      if (!accepted.ok) throw new Error(`accept ${i} must succeed`);
      seen.push(digest);
      const released = await releaseWork(
        capStore,
        { repositoryId: REPO, pullRequestNumber: capPr, ownerToken: token },
        stopped,
      );
      if (!released.ok || !released.released) throw new Error(`release ${i} must clear`);
    }
    const settled = await readWork(capStore, { repositoryId: REPO, pullRequestNumber: capPr });
    expect(settled?.acceptedReviews).toHaveLength(20);
    expect(settled?.acceptedReviews.map((e) => e.changeDigest)).toEqual(seen.slice(1));
  });

  it("a repeat accept for the same head + session appends no duplicate", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(
      store,
      reserveArgs(1300, "dedup", { role: "code-review", ledger: reviewLedger }),
    );
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("reservation must succeed");
    }
    const token = reserved.record.owner.token;
    const attached = await attachSession(store, {
      repositoryId: REPO,
      pullRequestNumber: 1300,
      ownerToken: token,
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      role: "code-review",
      sessionId: "sess-dedup",
    });
    if (!attached.ok) throw new Error("attach must succeed");
    const input = {
      repositoryId: REPO,
      pullRequestNumber: 1300,
      ownerToken: token,
      sessionId: "sess-dedup",
      startHead: HEAD_A,
      scopeDigest: SCOPE_A,
      liveHead: HEAD_A,
    };
    const first = await acceptResult(store, input, stopped);
    if (!first.ok) throw new Error("first accept must succeed");
    expect(first.record.acceptedReviews).toHaveLength(1);
    // The phase is now verifying; a second accept call with the same
    // identity must still succeed structurally but add no duplicate entry.
    const again = await acceptResult(store, input, stopped);
    if (!again.ok) throw new Error("repeat accept must succeed");
    expect(again.record.acceptedReviews).toHaveLength(1);
    expect(again.record.acceptedReviews[0]).toEqual({
      head: HEAD_A,
      changeDigest: CHANGE_A,
      sessionId: "sess-dedup",
    });
  });

  it("an owner held for re-review reports occupied, not already_reviewed", async () => {
    const { store } = await acceptReview(1400, "prec");
    const re = await reserveWork(
      store,
      reserveArgs(1400, "prec-1", {
        role: "code-review",
        ledger: reviewLedger,
        reReview: true,
      }),
    );
    if (!re.ok) throw new Error("re-review must reserve");
    const dup = await reserveWork(
      store,
      reserveArgs(1400, "prec-2", {
        role: "code-review",
        ledger: reviewLedger,
        reReview: true,
      }),
    );
    if (dup.ok) throw new Error("the held re-review owner must block");
    expect(dup.reason).toBe("occupied");
    const plain = await reserveWork(
      store,
      reserveArgs(1400, "prec-3", { role: "code-review", ledger: reviewLedger }),
    );
    if (plain.ok) throw new Error("the held owner must block plain reserves too");
    expect(plain.reason).toBe("occupied");
  });
});
