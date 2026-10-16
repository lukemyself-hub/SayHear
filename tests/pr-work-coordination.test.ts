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
  it("blocks a second writer until stopped proof clears it", async () => {
    const { store } = await makeStore();
    const first = await reserveWork(store, reserveArgs(21, "gap"));
    if (!first.ok || first.record.owner === null) {
      throw new Error("initial reservation must succeed");
    }
    expect(first.record.owner.sessionId).toBeNull();

    const second = await reserveWork(store, reserveArgs(21, "gap-retry"));
    if (second.ok) throw new Error("null-session gap must block");
    expect(second.reason).toBe("occupied");

    for (const [probe, reason] of [
      [running, "worker_running"],
      [unknown, "worker_unknown"],
    ] as const) {
      const denied = await releaseWork(
        store,
        { repositoryId: REPO, pullRequestNumber: 21 },
        probe,
      );
      if (denied.ok) throw new Error(`${reason} must keep occupancy`);
      expect(denied.reason).toBe(reason);
      expect(denied.record?.owner?.token).toBe(
        first.record.owner?.token,
      );
    }
    const cleared = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 21 },
      stopped,
    );
    if (!cleared.ok || !cleared.released) {
      throw new Error("stopped proof must clear the gap");
    }
    const retry = await reserveWork(store, reserveArgs(21, "gap-after"));
    if (!retry.ok) throw new Error("must proceed after stopped recovery");
    expect(retry.record.owner?.token).not.toBe(first.record.owner?.token);
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
        ledger: { roundsConsumed: 0, paused: true, historyConsistent: true },
      }),
    );
    if (paused.ok) throw new Error("paused ledger must refuse");
    expect(paused.reason).toBe("paused");

    const inconsistent = await reserveWork(
      store,
      reserveArgs(41, "ledger", {
        ledger: { roundsConsumed: 0, paused: false, historyConsistent: false },
      }),
    );
    if (inconsistent.ok) throw new Error("inconsistent ledger must refuse");
    expect(inconsistent.reason).toBe("history_inconsistent");

    const exhausted = await reserveWork(
      store,
      reserveArgs(41, "ledger", {
        ledger: { roundsConsumed: 3, paused: false, historyConsistent: true },
      }),
    );
    if (exhausted.ok) throw new Error("exhausted ledger must refuse");
    expect(exhausted.reason).toBe("rounds_exhausted");

    // A ledger one round short of the cap still allows a writer.
    const lastRound = await reserveWork(
      store,
      reserveArgs(42, "ledger-two", {
        ledger: { roundsConsumed: 2, paused: false, historyConsistent: true },
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
        ledger: { roundsConsumed: 9, paused: true, historyConsistent: false },
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
  it("an attach landing between probe and release keeps the owner", async () => {
    const { store } = await makeStore();
    const reserved = await reserveWork(store, reserveArgs(67, "overlap"));
    if (!reserved.ok || reserved.record.owner === null) {
      throw new Error("reservation must succeed");
    }
    const token = reserved.record.owner.token;
    // The probe runs outside the lock; simulate the attach landing there.
    let raced = false;
    const probe: ProbeWorker = async () => {
      if (!raced) {
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
      }
      return "stopped";
    };
    const released = await releaseWork(
      store,
      { repositoryId: REPO, pullRequestNumber: 67, ownerToken: token },
      probe,
    );
    if (released.ok) throw new Error("a changed owner must not be released");
    expect(released.reason).toBe("worker_unknown");
    expect(released.record?.owner?.token).toBe(token);
    expect(released.record?.owner?.sessionId).toBe("sess-overlap");
    const blocked = await reserveWork(store, reserveArgs(67, "overlap-2"));
    if (blocked.ok) throw new Error("the surviving owner must block a new writer");
    expect(blocked.reason).toBe("occupied");
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
