import { describe, expect, it } from "vitest";
import {
  integrationRefreshLabel, parseIntegrationRefresh, requestIntegrationRefresh,
  type IntegrationRefreshRecord, type IntegrationRefreshStore,
} from "../scripts/pr-approval/integration-refresh.ts";

const target = { headSha: "a".repeat(40), mainSha: "b".repeat(40), mergeSha: "c".repeat(40) };
class MemoryStore implements IntegrationRefreshStore {
  value: IntegrationRefreshRecord | null = null;
  async read() { return this.value; }
  async save(value: IntegrationRefreshRecord) { this.value = structuredClone(value); }
}
function fixture(store = new MemoryStore()) {
  const added: string[] = [];
  const actions = {
    recheck: async () => true,
    labels: async (): Promise<string[]> => [],
    prepareLabel: async (_label: string) => {},
    addLabel: async (label: string) => { added.push(label); },
    definitiveRejection: (_error: unknown) => false,
  };
  return { store, actions, added };
}

describe("durable integration refresh requests", () => {
  it("requests once per verified target and persists before sending the event", async () => {
    const f = fixture();
    f.actions.addLabel = async (label) => {
      expect(f.store.value).toEqual({ version: 1, pullRequestNumber: 356, target, staleRunId: 123, phase: "dispatching" });
      f.added.push(label);
    };
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("requested");
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("waiting");
    expect(f.added).toEqual([`ci-int:${target.mergeSha}`]);
    expect(integrationRefreshLabel(target)).toHaveLength(47);
    expect(f.store.value?.phase).toBe("requested");
  });

  it("preserves an ambiguous label write across restarts without resending", async () => {
    const f = fixture();
    f.actions.addLabel = async (label) => { f.added.push(label); throw new Error("lost response"); };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("lost response");
    expect(f.store.value?.phase).toBe("dispatching");
    const restarted = new MemoryStore();
    restarted.value = f.store.value;
    expect(await requestIntegrationRefresh(restarted, 356, target, 123, f.actions)).toBe("waiting");
    expect(f.added).toHaveLength(1);
  });

  it("does not toggle an existing marker or infer that its run passed", async () => {
    const f = fixture();
    f.actions.labels = async () => [integrationRefreshLabel(target)];
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("waiting");
    expect(f.added).toEqual([]);
    expect(f.store.value?.phase).toBe("requested");
  });

  it("stops before writes when head, main, or merge identity changes", async () => {
    const f = fixture();
    f.actions.recheck = async () => false;
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("target_changed");
    expect(f.store.value).toBeNull();
    expect(f.added).toEqual([]);
  });

  it("allows a different verified integration target without changing reviewed head", async () => {
    const f = fixture();
    await requestIntegrationRefresh(f.store, 356, target, 123, f.actions);
    const advanced = { ...target, mainSha: "d".repeat(40), mergeSha: "e".repeat(40) };
    await requestIntegrationRefresh(f.store, 356, advanced, 124, f.actions);
    expect(f.added).toEqual([integrationRefreshLabel(target), integrationRefreshLabel(advanced)]);
    expect(f.store.value?.target.headSha).toBe(target.headSha);
  });

  it("does not send if durable intent cannot be saved", async () => {
    const f = fixture();
    f.store.save = async () => { throw new Error("store unavailable"); };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("store unavailable");
    expect(f.added).toEqual([]);
  });

  it("retains dispatching if acknowledgement persistence fails after event delivery", async () => {
    const f = fixture();
    const save = f.store.save.bind(f.store);
    f.store.save = async (value) => {
      if (value.phase === "requested") throw new Error("ack unavailable");
      await save(value);
    };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("ack unavailable");
    expect(f.store.value?.phase).toBe("dispatching");
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("waiting");
    expect(f.added).toHaveLength(1);
  });

  it("resumes a safely unsent intent after restarting before dispatch", async () => {
    const store = new MemoryStore();
    store.value = { version: 1, pullRequestNumber: 356, target, staleRunId: 123, phase: "intent" };
    const f = fixture(store);
    expect(await requestIntegrationRefresh(store, 356, target, 123, f.actions)).toBe("requested");
    expect(f.added).toEqual([integrationRefreshLabel(target)]);
    expect(store.value?.phase).toBe("requested");
  });

  it("retries repository label preparation failure without suppressing an unsent event", async () => {
    const f = fixture();
    f.actions.prepareLabel = async () => { throw new Error("repository label unavailable"); };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("repository label unavailable");
    expect(f.store.value?.phase).toBe("intent");
    expect(f.added).toEqual([]);
    const restarted = fixture(f.store);
    expect(await requestIntegrationRefresh(restarted.store, 356, target, 123, restarted.actions)).toBe("requested");
    expect(restarted.added).toEqual([integrationRefreshLabel(target)]);
  });

  it("resumes after a definitive PR-label rejection", async () => {
    const f = fixture();
    const rejected = new Error("definitively rejected");
    f.actions.definitiveRejection = (error) => error === rejected;
    f.actions.addLabel = async () => { throw rejected; };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("definitively rejected");
    expect(f.store.value?.phase).toBe("intent");
    const restarted = fixture(f.store);
    expect(await requestIntegrationRefresh(restarted.store, 356, target, 123, restarted.actions)).toBe("requested");
    expect(restarted.added).toHaveLength(1);
  });

  it("does not dispatch until dispatching is durable and can resume its unsent intent", async () => {
    const f = fixture();
    const save = f.store.save.bind(f.store);
    f.store.save = async (value) => {
      if (value.phase === "dispatching") throw new Error("dispatch state unavailable");
      await save(value);
    };
    await expect(requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).rejects.toThrow("dispatch state unavailable");
    expect(f.store.value?.phase).toBe("intent");
    expect(f.added).toEqual([]);
    f.store.save = save;
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("requested");
    expect(f.added).toHaveLength(1);
  });

  it("preserves ambiguous dispatching after a crash immediately before the network call", async () => {
    const f = fixture();
    f.store.value = { version: 1, pullRequestNumber: 356, target, staleRunId: 123, phase: "dispatching" };
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("waiting");
    expect(f.added).toEqual([]);
  });

  it("rechecks target identity after preparation and leaves a changed target safely unsent", async () => {
    const f = fixture();
    let reads = 0;
    f.actions.recheck = async () => ++reads === 1;
    expect(await requestIntegrationRefresh(f.store, 356, target, 123, f.actions)).toBe("target_changed");
    expect(f.store.value?.phase).toBe("intent");
    expect(f.added).toEqual([]);
  });

  it.each([
    { version: 2 }, { phase: "complete" }, { staleRunId: 0 }, { pullRequestNumber: -1 },
    { target: { ...target, mergeSha: "../unsafe" } },
  ])("rejects corrupt signed payloads %#", async (override) => {
    expect(() => parseIntegrationRefresh({ version: 1, pullRequestNumber: 356, target, staleRunId: 123, phase: "intent", ...override })).toThrow("integration_refresh_schema_invalid");
  });
});
