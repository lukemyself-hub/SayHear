import { SignedJsonStore } from "./signed-store.ts";

// GitHub does not rebuild refs/pull/N/merge when main advances, and a label
// event still runs Validate on that stale merge commit and its workflow.
// Closing and reopening the PR rebuilds the merge ref immediately. The run the
// `reopened` event starts may still check out the old merge commit; it is then
// a stale integration run, and the ci-int label refresh requests a run on the
// rebuilt ref. Do not remove that label path as redundant.
export type MergeRefRebuildTarget = Readonly<{ headSha: string; mainSha: string; staleMergeSha: string }>;
export type MergeRefRebuildRecord = Readonly<{
  version: 1;
  pullRequestNumber: number;
  target: MergeRefRebuildTarget;
  // `interrupted` means the close may never have happened, so the same
  // target may be rebuilt again. `reopen_refused` is final: GitHub rejected
  // the reopen, for example after the head branch was deleted.
  phase: "closing" | "reopened" | "interrupted" | "reopen_refused";
}>;
export interface MergeRefRebuildStore {
  read(number: number): Promise<MergeRefRebuildRecord | null>;
  save(value: MergeRefRebuildRecord): Promise<void>;
  list(): Promise<MergeRefRebuildRecord[]>;
}

export function parseMergeRefRebuild(value: unknown): MergeRefRebuildRecord {
  if (typeof value !== "object" || value === null || !("target" in value) ||
      typeof value.target !== "object" || value.target === null ||
      !("version" in value) || value.version !== 1 ||
      !("pullRequestNumber" in value) || typeof value.pullRequestNumber !== "number" ||
      !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1 ||
      !("phase" in value) || !["closing", "reopened", "interrupted", "reopen_refused"].includes(String(value.phase))) {
    throw new Error("merge_ref_rebuild_schema_invalid");
  }
  const target = value.target;
  if (!("headSha" in target) || typeof target.headSha !== "string" ||
      !("mainSha" in target) || typeof target.mainSha !== "string" ||
      !("staleMergeSha" in target) || typeof target.staleMergeSha !== "string" ||
      ![target.headSha, target.mainSha, target.staleMergeSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("merge_ref_rebuild_schema_invalid");
  }
  return { version: 1, pullRequestNumber: value.pullRequestNumber, phase: value.phase as MergeRefRebuildRecord["phase"],
    target: { headSha: target.headSha, mainSha: target.mainSha, staleMergeSha: target.staleMergeSha } };
}

export class SignedMergeRefRebuildStore extends SignedJsonStore<MergeRefRebuildRecord> implements MergeRefRebuildStore {
  constructor(directory: string, privateKey: string, publicKey: string) {
    super(directory, privateKey, publicKey, parseMergeRefRebuild, (value) => value.pullRequestNumber, "merge_ref_rebuild");
  }
}

export type MergeRefRebuildActions = Readonly<{
  recheck: () => Promise<boolean>;
  close: () => Promise<void>;
  reopen: () => Promise<void>;
}>;

// The caller holds the repository lock. The intent is signed before the close,
// so a crash between close and reopen is finished by `resumeMergeRefRebuilds`.
// One target is rebuilt at most once: if GitHub keeps the same stale ref after
// a reopen, the controller waits instead of cycling the PR.
export async function requestMergeRefRebuild(
  store: MergeRefRebuildStore,
  number: number,
  target: MergeRefRebuildTarget,
  actions: MergeRefRebuildActions,
): Promise<"requested" | "waiting" | "target_changed"> {
  const previous = await store.read(number);
  if (previous && previous.target.headSha === target.headSha && previous.target.mainSha === target.mainSha &&
      previous.target.staleMergeSha === target.staleMergeSha && previous.phase === "reopened") return "waiting";
  if (!await actions.recheck()) return "target_changed";
  const record: MergeRefRebuildRecord = { version: 1, pullRequestNumber: number, target, phase: "closing" };
  await store.save(record);
  await actions.close();
  await actions.reopen();
  await store.save({ ...record, phase: "reopened" });
  return "requested";
}

export type ClosedPullRequestState = Readonly<{ state: string; merged: boolean }>;
export type MergeRefRebuildRecovery = Readonly<{
  reopened: number[];
  failures: Array<Readonly<{ pullRequestNumber: number; reason: string }>>;
}>;

// Reopen every PR this controller may have left closed, even if its head
// changed meanwhile: a new head still needs a new review and CI. An open or
// merged PR needs no write; its record allows a retry because the close may
// never have reached GitHub. A transient failure stays `closing` and does not
// stop recovery of the others; a definitive rejection is reported once and
// settled as `reopen_refused`.
export async function resumeMergeRefRebuilds(
  store: MergeRefRebuildStore,
  actions: Readonly<{
    read: (number: number) => Promise<ClosedPullRequestState>;
    reopen: (number: number) => Promise<void>;
    definitiveRejection: (error: unknown) => boolean;
  }>,
): Promise<MergeRefRebuildRecovery> {
  const reopened: number[] = [];
  const failures: Array<Readonly<{ pullRequestNumber: number; reason: string }>> = [];
  for (const record of await store.list()) {
    if (record.phase !== "closing") continue;
    try {
      const pull = await actions.read(record.pullRequestNumber);
      if (pull.state === "closed" && !pull.merged) {
        await actions.reopen(record.pullRequestNumber);
        reopened.push(record.pullRequestNumber);
        await store.save({ ...record, phase: "reopened" });
      } else {
        await store.save({ ...record, phase: "interrupted" });
      }
    } catch (error) {
      const refused = actions.definitiveRejection(error);
      failures.push({ pullRequestNumber: record.pullRequestNumber,
        reason: `${refused ? "reopen_refused: " : ""}${error instanceof Error ? error.message : String(error)}` });
      if (refused) await store.save({ ...record, phase: "reopen_refused" });
    }
  }
  return { reopened, failures };
}
