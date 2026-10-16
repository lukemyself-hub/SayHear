import { describe, expect, it } from "vitest";
import {
  parseMergeRefRebuild, requestMergeRefRebuild, resumeMergeRefRebuilds,
  type MergeRefRebuildRecord, type MergeRefRebuildStore,
} from "../scripts/pr-approval/merge-ref-rebuild.ts";

const target = { headSha: "a".repeat(40), mainSha: "b".repeat(40), staleMergeSha: "c".repeat(40) };
class MemoryStore implements MergeRefRebuildStore {
  value: MergeRefRebuildRecord | null = null;
  async read() { return this.value; }
  async save(value: MergeRefRebuildRecord) { this.value = structuredClone(parseMergeRefRebuild(value)); }
  async list() { return this.value ? [this.value] : []; }
}
function fixture(store = new MemoryStore()) {
  const writes: string[] = [];
  const actions = {
    recheck: async () => true,
    close: async () => { writes.push("close"); },
    reopen: async () => { writes.push("reopen"); },
  };
  return { store, actions, writes };
}

describe("merge ref rebuild requests", () => {
  it("signs the intent before closing and rebuilds one target once", async () => {
    const f = fixture();
    f.actions.close = async () => {
      expect(f.store.value).toEqual({ version: 1, pullRequestNumber: 348, target, phase: "closing" });
      f.writes.push("close");
    };
    expect(await requestMergeRefRebuild(f.store, 348, target, f.actions)).toBe("requested");
    expect(await requestMergeRefRebuild(f.store, 348, target, f.actions)).toBe("waiting");
    expect(f.writes).toEqual(["close", "reopen"]);
    expect(f.store.value?.phase).toBe("reopened");
  });

  it("rebuilds again once main advances to a new target", async () => {
    const f = fixture();
    await requestMergeRefRebuild(f.store, 348, target, f.actions);
    expect(await requestMergeRefRebuild(f.store, 348, { ...target, mainSha: "d".repeat(40) }, f.actions)).toBe("requested");
    expect(f.writes).toEqual(["close", "reopen", "close", "reopen"]);
  });

  it("does not touch the PR when the live target changed", async () => {
    const f = fixture();
    f.actions.recheck = async () => false;
    expect(await requestMergeRefRebuild(f.store, 348, target, f.actions)).toBe("target_changed");
    expect(f.writes).toEqual([]);
    expect(f.store.value).toBeNull();
  });

  it("reopens a PR left closed by a crash after the close", async () => {
    const f = fixture();
    f.actions.reopen = async () => { throw new Error("controller crashed"); };
    await expect(requestMergeRefRebuild(f.store, 348, target, f.actions)).rejects.toThrow("controller crashed");
    expect(f.store.value?.phase).toBe("closing");
    const reopened: number[] = [];
    expect(await resumeMergeRefRebuilds(f.store, {
      read: async () => ({ state: "closed", merged: false, headSha: target.headSha }),
      reopen: async (number) => { reopened.push(number); },
    })).toEqual([348]);
    expect(reopened).toEqual([348]);
    expect(f.store.value?.phase).toBe("reopened");
  });

  it.each([
    { state: "open", merged: false, headSha: "a".repeat(40) },
    { state: "closed", merged: true, headSha: "a".repeat(40) },
    { state: "closed", merged: false, headSha: "e".repeat(40) },
  ])("settles without reopening %j", async (pull) => {
    const store = new MemoryStore();
    store.value = { version: 1, pullRequestNumber: 348, target, phase: "closing" };
    const reopened: number[] = [];
    expect(await resumeMergeRefRebuilds(store, { read: async () => pull, reopen: async (number) => { reopened.push(number); } })).toEqual([]);
    expect(reopened).toEqual([]);
    expect(store.value.phase).toBe("reopened");
  });

  it("keeps the intent when the reopen fails during recovery", async () => {
    const store = new MemoryStore();
    store.value = { version: 1, pullRequestNumber: 348, target, phase: "closing" };
    await expect(resumeMergeRefRebuilds(store, {
      read: async () => ({ state: "closed", merged: false, headSha: target.headSha }),
      reopen: async () => { throw new Error("HTTP 503"); },
    })).rejects.toThrow("HTTP 503");
    expect(store.value.phase).toBe("closing");
  });

  it("rejects malformed records", () => {
    expect(() => parseMergeRefRebuild({ version: 1, pullRequestNumber: 348, target, phase: "dispatching" })).toThrow("merge_ref_rebuild_schema_invalid");
    expect(() => parseMergeRefRebuild({ version: 1, pullRequestNumber: 348, target: { ...target, staleMergeSha: "x" }, phase: "closing" }))
      .toThrow("merge_ref_rebuild_schema_invalid");
  });
});
