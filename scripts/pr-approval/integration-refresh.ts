import { SignedJsonStore } from "./signed-store.ts";

export type IntegrationTarget = Readonly<{ headSha: string; mainSha: string; mergeSha: string }>;
export type IntegrationRefreshRecord = Readonly<{
  version: 1;
  pullRequestNumber: number;
  target: IntegrationTarget;
  staleRunId: number;
  phase: "intent" | "requested";
}>;
export interface IntegrationRefreshStore {
  read(number: number): Promise<IntegrationRefreshRecord | null>;
  save(value: IntegrationRefreshRecord): Promise<void>;
}

export function parseIntegrationRefresh(value: unknown): IntegrationRefreshRecord {
  if (typeof value !== "object" || value === null || !("target" in value) ||
      typeof value.target !== "object" || value.target === null ||
      !("version" in value) || value.version !== 1 ||
      !("pullRequestNumber" in value) || typeof value.pullRequestNumber !== "number" ||
      !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1 ||
      !("staleRunId" in value) || typeof value.staleRunId !== "number" ||
      !Number.isSafeInteger(value.staleRunId) || value.staleRunId < 1 ||
      !("phase" in value) || (value.phase !== "intent" && value.phase !== "requested")) {
    throw new Error("integration_refresh_schema_invalid");
  }
  const target = value.target;
  if (!("headSha" in target) || typeof target.headSha !== "string" ||
      !("mainSha" in target) || typeof target.mainSha !== "string" ||
      !("mergeSha" in target) || typeof target.mergeSha !== "string" ||
      ![target.headSha, target.mainSha, target.mergeSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("integration_refresh_schema_invalid");
  }
  return { version: 1, pullRequestNumber: value.pullRequestNumber, staleRunId: value.staleRunId,
    phase: value.phase, target: { headSha: target.headSha, mainSha: target.mainSha, mergeSha: target.mergeSha } };
}

export class SignedIntegrationRefreshStore extends SignedJsonStore<IntegrationRefreshRecord> implements IntegrationRefreshStore {
  constructor(directory: string, privateKey: string, publicKey: string) {
    super(directory, privateKey, publicKey, parseIntegrationRefresh, (value) => value.pullRequestNumber, "integration_refresh");
  }
}

export function integrationRefreshLabel(target: IntegrationTarget): string {
  return `ci-int:${target.mergeSha}`;
}

// The caller holds the repository lock. Persist before any write so a lost
// response or crash never turns a missing run into a second automatic request.
export async function requestIntegrationRefresh(
  store: IntegrationRefreshStore,
  number: number,
  target: IntegrationTarget,
  staleRunId: number,
  actions: Readonly<{
    recheck: () => Promise<boolean>;
    labels: () => Promise<readonly string[]>;
    addLabel: (label: string) => Promise<void>;
  }>,
): Promise<"requested" | "waiting" | "target_changed"> {
  const previous = await store.read(number);
  if (previous && previous.target.mergeSha === target.mergeSha &&
      previous.target.headSha === target.headSha && previous.target.mainSha === target.mainSha) return "waiting";
  if (!await actions.recheck()) return "target_changed";
  const label = integrationRefreshLabel(target);
  const present = (await actions.labels()).includes(label);
  const record: IntegrationRefreshRecord = { version: 1, pullRequestNumber: number, target, staleRunId, phase: "intent" };
  await store.save(record);
  if (present) return "waiting";
  await actions.addLabel(label);
  await store.save({ ...record, phase: "requested" });
  return "requested";
}
