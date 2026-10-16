import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_IDENTITY,
  LUKE_IDENTITY,
  authorizationChannel,
  browserContextDigest,
  latestLukeReview,
  parseBrowserContext,
  parseBrowserReceipt,
  parseBrowserState,
  readBrowserAuthorization,
  SignedBrowserApprovalStore,
  type BrowserApprovalStore,
  type BrowserContext,
  type BrowserState,
} from "../scripts/pr-approval/browser-approval.ts";
import { applyMergeAction, browserAuthorizationRequired, confirmCompletionMerge, controllerBuildIdentity, digestDiscussion,
  isBrowserApprovalWait, mergeActionFor, readHumanBinding, requirementProjectionFor,
  PR_REVIEW_GATE_INSTALLED_POLICY_VERSION,
  verifyCompletionRequirements,
  type GitHubApi, type GitHubComment, type HumanReviewBinding } from "../scripts/pr-approval-controller.ts";
import { CompletionMismatch, parseCompletionRecord, recoverCompletion, type CompletionIdentity, type CompletionRecord, type CompletionStore } from "../scripts/pr-approval/completion.ts";
import { PR_REVIEW_GATE_POLICY_VERSION, PR_REVIEW_REPORT_VERSION, protectedReviewPaths, evaluatePrReviewGate, requirementDigest,
  type PrReviewGateInput, type TrustedPrReviewPolicy } from "../scripts/pr-review-gate.ts";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const DIFF = "d".repeat(64);
const REQUIREMENT = "e".repeat(64);
const NEXT_REQUIREMENT = "f".repeat(64);
const WORKFLOW = "1".repeat(40);
const REVIEWER = { id: LUKE_IDENTITY.id, login: LUKE_IDENTITY.login, type: LUKE_IDENTITY.type };
const AUTHOR = { id: AGENT_IDENTITY.id, login: AGENT_IDENTITY.login, type: AGENT_IDENTITY.type };

function context(overrides: Partial<BrowserContext> = {}): BrowserContext {
  return {
    repositoryId: 1312399710, repositoryNodeId: "R_node", pullRequestNumber: 400, pullRequestNodeId: "PR_node",
    author: AUTHOR, reviewer: REVIEWER, headSha: HEAD, baseSha: BASE, diffDigest: DIFF,
    requirementDigest: REQUIREMENT, protectedPaths: ["scripts/pr-review-gate.ts"], validateWorkflowBlobSha: WORKFLOW,
    ...overrides,
  };
}
function lukeReview(overrides: Record<string, unknown> = {}) {
  return { id: 10, state: "APPROVED", submitted_at: "2026-10-14T00:00:10Z", commit_id: HEAD, user: REVIEWER, body: "approve", ...overrides };
}
class MemoryBrowserStore implements BrowserApprovalStore {
  value: BrowserState | null = null;
  async read() { return this.value === null ? null : structuredClone(this.value); }
  async save(next: BrowserState) { this.value = structuredClone(next); }
}

// These aliases come from the controller's own entry points, so the binding
// fixtures below are type-checked against the real config, pull-request and
// review shapes instead of bypassing the compiler with `as never`. The gate
// fixture further down still asserts through `as unknown as PrReviewGateInput`
// because it is a hand-built literal, not a controller response.
type BindingConfig = Parameters<typeof readHumanBinding>[0];
type BindingRequest = Parameters<typeof readHumanBinding>[1];
type BindingReview = BindingRequest["reviews"][number];

const BASE_POLICY: TrustedPrReviewPolicy = {
  repositoryId: 1312399710, repositoryName: "lukemyself-hub/SayHear", defaultBranch: "main",
  policyVersion: PR_REVIEW_GATE_POLICY_VERSION, reviewAppId: 1, actionsAppId: 2, validateWorkflowBlobSha: WORKFLOW,
};

// The only API call the browser freeze needs is the head workflow blob.
class BindingApi implements GitHubApi {
  constructor(private readonly headRef?: string) {}
  async request<T>(path: string): Promise<T> {
    expect(path).toContain(`/contents/.github/workflows/pr-validate.yml?ref=`);
    if (this.headRef !== undefined) expect(path).toContain(`?ref=${this.headRef}`);
    return { sha: WORKFLOW } as T;
  }
  async pages<T>(): Promise<T[]> { return []; }
  async bytes(): Promise<Uint8Array> { return new Uint8Array(); }
}

function bindingConfig(
  browserApprovalStore: BrowserApprovalStore,
  humanReviewAuthorizations: NonNullable<BindingConfig["app"]["humanReviewAuthorizations"]> = [],
  api: GitHubApi = new BindingApi(),
): BindingConfig {
  return {
    api,
    app: {
      appId: 1, installationId: 2, slug: "sayhear",
      productionMergeAuthorized: true, ordinaryMergeTriggersProduction: false,
      humanReviewAuthorizations,
    },
    policy: BASE_POLICY,
    botActorId: 1,
    ownerActorId: LUKE_IDENTITY.id,
    browserApprovalStore,
  };
}

function pullRequestFixture(author: BindingReview["user"]): BindingRequest["pullRequest"] {
  return {
    number: 400, state: "open", draft: false, title: "Agent change", body: "Fixes #1",
    updated_at: "2026-10-14T00:00:00Z", node_id: "PR_node", merge_commit_sha: null, changed_files: 1,
    head: { sha: HEAD, repo: { id: 1312399710 } },
    base: { ref: "main", sha: BASE },
    user: { ...author },
  };
}

describe("browser approval channel", () => {
  it("binds a frozen challenge to a review submitted strictly after the freeze", async () => {
    const store = new MemoryBrowserStore();
    await readBrowserAuthorization(store, 400, context(), [lukeReview({ id: 9, submitted_at: "2026-10-14T00:00:00Z" })], true, Date.parse("2026-10-14T00:00:05Z"));
    const bound = await readBrowserAuthorization(store, 400, context(), [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"));
    expect(bound.receipt?.reviewId).toBe(10);
    expect(parseBrowserReceipt(bound.receipt).challenge.context.validateWorkflowBlobSha).toBe(WORKFLOW);
  });

  it("rejects an approval submitted in the same second as the freeze", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    const bound = await readBrowserAuthorization(store, 400, context(), [lukeReview({ submitted_at: "2026-10-14T00:00:05Z" })], false, at);
    expect(bound.receipt).toBeNull();
  });

  it("rejects a previously seen approval even when the local clock skews backwards", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [lukeReview({ id: 10, submitted_at: "2026-10-14T00:00:04Z" })], true, at);
    // A newer review id with an earlier timestamp cannot bind: the signed
    // watermark plus frozenAt dominate local clock skew.
    const bound = await readBrowserAuthorization(store, 400, context(), [lukeReview({ id: 12, submitted_at: "2026-10-13T23:59:00Z" })], false, at);
    expect(bound.receipt).toBeNull();
  });

  it("requires a new challenge and approval after any contextual change", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    expect((await readBrowserAuthorization(store, 400, context(), [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt).not.toBeNull();
    // Same head, unchanged diff, but the requirement digest moved to R2.
    const next = await readBrowserAuthorization(store, 400, context({ requirementDigest: NEXT_REQUIREMENT }), [lukeReview({ id: 11 })], false, at);
    expect(next.receipt).toBeNull();
    expect(store.value?.challenge).toBeNull();
    // Restoring the earlier context must not revive the old receipt.
    const restored = await readBrowserAuthorization(store, 400, context(), [lukeReview({ id: 11 })], false, Date.parse("2026-10-14T00:00:11Z"));
    expect(restored.receipt).toBeNull();
    expect(store.value?.challenge).toBeNull();
  });

  it("resets the epoch for a head-only sync with an unchanged diff", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    const next = await readBrowserAuthorization(store, 400, context({ headSha: NEXT_HEAD }), [lukeReview({ id: 11, commit_id: NEXT_HEAD })], false, at);
    expect(next.receipt).toBeNull();
  });

  it("preserves a head-v2 approval across cleared base advancement", async () => {
    const store = new MemoryBrowserStore();
    const original = context({ reviewBinding: "head-v2" });
    const next = context({ reviewBinding: "head-v2", baseSha: "2".repeat(40) });
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, original, [], true, at);
    const bound = await readBrowserAuthorization(store, 400, original, [lukeReview()]);
    const advanced = await readBrowserAuthorization(store, 400, next, [lukeReview()]);
    expect(bound.receipt?.reviewId).toBe(10);
    expect(advanced.receipt).toEqual(bound.receipt);
    expect(browserContextDigest(original)).toBe(browserContextDigest(next));
    expect(advanced.receipt?.challenge.context.baseSha).toBe(BASE);
  });

  it("does not promote an exact-base approval into head-v2 authority", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    expect((await readBrowserAuthorization(store, 400, context(), [lukeReview()])).receipt).not.toBeNull();
    const next = await readBrowserAuthorization(store, 400, context({ reviewBinding: "head-v2" }), [lukeReview()]);
    expect(next.receipt).toBeNull();
    expect(next.challenge).toBeNull();
  });

  it("invalidates head-v2 after material risk, changed workflow, requirements or head", async () => {
    for (const next of [
      null,
      context({ reviewBinding: "head-v2", headSha: NEXT_HEAD }),
      context({ reviewBinding: "head-v2", requirementDigest: NEXT_REQUIREMENT }),
      context({ reviewBinding: "head-v2", diffDigest: "2".repeat(64) }),
      context({ reviewBinding: "head-v2", validateWorkflowBlobSha: "3".repeat(40) }),
      context({ reviewBinding: "head-v2", protectedPaths: ["scripts/another.ts"] }),
    ]) {
      const store = new MemoryBrowserStore();
      const original = context({ reviewBinding: "head-v2" });
      await readBrowserAuthorization(store, 400, original, [], true, Date.parse("2026-10-14T00:00:05Z"));
      expect((await readBrowserAuthorization(store, 400, original, [lukeReview()])).receipt).not.toBeNull();
      const invalid = await readBrowserAuthorization(store, 400, next, [lukeReview()]);
      expect(invalid.receipt).toBeNull();
      expect(invalid.challenge).toBeNull();
      expect((await readBrowserAuthorization(store, 400, original, [lukeReview()])).receipt).toBeNull();
    }
    expect(() => parseBrowserContext({ ...context(), reviewBinding: "head-v3" })).toThrow("browser_binding_invalid");
  });

  it("revokes the receipt when the latest Luke review is not an approval", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    expect((await readBrowserAuthorization(store, 400, context(), [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt).not.toBeNull();
    const states = ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED"];
    for (const [index, state] of states.entries()) {
      // Distinct timestamps matter: same-second reviews are rejected as an
      // untrustworthy order, which is the fail-closed behavior we want.
      const revoked = await readBrowserAuthorization(store, 400, context(),
        [lukeReview(), lukeReview({ id: 11 + index, state, submitted_at: `2026-10-14T00:00:2${index}Z` })], false, Date.parse("2026-10-14T00:00:30Z"));
      expect(revoked.receipt, state).toBeNull();
    }
  });

  it("keeps a final-decision approval after a later COMMENTED review", async () => {
    const store = new MemoryBrowserStore();
    const finalContext = context({ liveness: "final-decision-v1" });
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, finalContext, [], true, at);
    expect((await readBrowserAuthorization(store, 400, finalContext, [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    const kept = await readBrowserAuthorization(store, 400, finalContext,
      [lukeReview(), lukeReview({ id: 11, state: "COMMENTED", submitted_at: "2026-10-14T00:00:20Z" })], false, Date.parse("2026-10-14T00:00:21Z"));
    expect(kept.receipt?.reviewId).toBe(10);
    expect(kept.challenge).not.toBeNull();
  });

  it("still revokes a final-decision approval after CHANGES_REQUESTED or DISMISSED", async () => {
    const finalContext = context({ liveness: "final-decision-v1" });
    const at = Date.parse("2026-10-14T00:00:05Z");
    const approved = lukeReview();
    const requested = lukeReview({ id: 11, state: "CHANGES_REQUESTED", submitted_at: "2026-10-14T00:00:20Z" });
    const comment = lukeReview({ id: 12, state: "COMMENTED", submitted_at: "2026-10-14T00:00:30Z" });

    const store = new MemoryBrowserStore();
    await readBrowserAuthorization(store, 400, finalContext, [], true, at);
    expect((await readBrowserAuthorization(store, 400, finalContext, [approved], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    // A decisive CHANGES_REQUESTED stays revoked even with a trailing comment,
    // and later comments never resurrect the cleared receipt.
    const revoked = await readBrowserAuthorization(store, 400, finalContext, [approved, requested, comment], false, Date.parse("2026-10-14T00:00:31Z"));
    expect(revoked.receipt).toBeNull();
    expect(revoked.challenge).toBeNull();
    const staysCleared = await readBrowserAuthorization(store, 400, finalContext,
      [approved, requested, comment, lukeReview({ id: 13, state: "COMMENTED", submitted_at: "2026-10-14T00:00:40Z" })], false, Date.parse("2026-10-14T00:00:41Z"));
    expect(staysCleared.receipt).toBeNull();
    expect(staysCleared.challenge).toBeNull();

    const dismissedStore = new MemoryBrowserStore();
    await readBrowserAuthorization(dismissedStore, 400, finalContext, [], true, at);
    expect((await readBrowserAuthorization(dismissedStore, 400, finalContext, [approved], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    const dismissed = await readBrowserAuthorization(dismissedStore, 400, finalContext,
      [approved, lukeReview({ id: 11, state: "DISMISSED", submitted_at: "2026-10-14T00:00:20Z" })], false, Date.parse("2026-10-14T00:00:21Z"));
    expect(dismissed.receipt).toBeNull();
    expect(dismissed.challenge).toBeNull();
  });

  it("fails closed on malformed, out-of-order or disappeared reviews in final-decision mode", async () => {
    const finalContext = context({ liveness: "final-decision-v1" });
    const at = Date.parse("2026-10-14T00:00:05Z");

    const malformedStore = new MemoryBrowserStore();
    await readBrowserAuthorization(malformedStore, 400, finalContext, [], true, at);
    await expect(readBrowserAuthorization(malformedStore, 400, finalContext,
      [lukeReview(), { ...lukeReview({ id: 11, state: "COMMENTED" }), submitted_at: "not-a-time" }], false, Date.parse("2026-10-14T00:00:21Z")))
      .rejects.toThrow("browser_review_time_invalid");
    expect(malformedStore.value?.challenge).toBeNull();

    const orderStore = new MemoryBrowserStore();
    await readBrowserAuthorization(orderStore, 400, finalContext, [], true, at);
    await expect(readBrowserAuthorization(orderStore, 400, finalContext,
      [lukeReview(), lukeReview({ id: 11, state: "COMMENTED", submitted_at: "2026-10-14T00:00:10Z" })], false, Date.parse("2026-10-14T00:00:21Z")))
      .rejects.toThrow("browser_review_order_invalid");
    expect(orderStore.value?.challenge).toBeNull();

    const disappearedStore = new MemoryBrowserStore();
    await readBrowserAuthorization(disappearedStore, 400, finalContext, [], true, at);
    expect((await readBrowserAuthorization(disappearedStore, 400, finalContext, [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    const disappeared = await readBrowserAuthorization(disappearedStore, 400, finalContext, [], false, Date.parse("2026-10-14T00:00:21Z"));
    expect(disappeared.receipt).toBeNull();
    expect(disappeared.challenge).toBeNull();
  });

  it("versions final-decision opt-in so old records keep old exact semantics", () => {
    expect(() => parseBrowserContext({ ...context(), liveness: "final-decision-v2" })).toThrow("browser_liveness_invalid");
    // Old records stay parseable, but opting in changes the digest identity, so
    // an old frozen challenge drifts instead of being silently broadened.
    expect(parseBrowserContext(context()).liveness).toBeUndefined();
    expect(browserContextDigest(context())).not.toBe(browserContextDigest(context({ liveness: "final-decision-v1" })));
  });

  it("drifts an old frozen challenge instead of broadening it into final-decision", async () => {
    const at = Date.parse("2026-10-14T00:00:05Z");
    const store = new MemoryBrowserStore();
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    expect((await readBrowserAuthorization(store, 400, context(), [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    // Presenting the opted-in context against the old challenge clears state;
    // the controller must freeze a fresh final-decision challenge next slice.
    const drifted = await readBrowserAuthorization(store, 400, context({ liveness: "final-decision-v1" }), [lukeReview()], false, Date.parse("2026-10-14T00:00:12Z"));
    expect(drifted.receipt).toBeNull();
    expect(drifted.challenge).toBeNull();
  });

  it("still revokes a final-decision approval after head, diff, scope or workflow drift", async () => {
    const finalContext = context({ liveness: "final-decision-v1" });
    for (const next of [
      null,
      context({ liveness: "final-decision-v1", headSha: NEXT_HEAD }),
      context({ liveness: "final-decision-v1", diffDigest: "2".repeat(64) }),
      context({ liveness: "final-decision-v1", requirementDigest: NEXT_REQUIREMENT }),
      context({ liveness: "final-decision-v1", validateWorkflowBlobSha: "3".repeat(40) }),
      context({ liveness: "final-decision-v1", protectedPaths: ["scripts/another.ts"] }),
    ]) {
      const store = new MemoryBrowserStore();
      const at = Date.parse("2026-10-14T00:00:05Z");
      await readBrowserAuthorization(store, 400, finalContext, [], true, at);
      expect((await readBrowserAuthorization(store, 400, finalContext, [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
      const invalid = await readBrowserAuthorization(store, 400, next, [lukeReview()], false, Date.parse("2026-10-14T00:00:12Z"));
      expect(invalid.receipt).toBeNull();
      expect(invalid.challenge).toBeNull();
      expect((await readBrowserAuthorization(store, 400, finalContext, [lukeReview()], false, Date.parse("2026-10-14T00:00:13Z"))).receipt).toBeNull();
    }
  });

  it("keeps final-decision liveness orthogonal to head-v2 base advancement", async () => {
    const store = new MemoryBrowserStore();
    const original = context({ reviewBinding: "head-v2", liveness: "final-decision-v1" });
    const advanced = context({ reviewBinding: "head-v2", liveness: "final-decision-v1", baseSha: "2".repeat(40) });
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, original, [], true, at);
    expect((await readBrowserAuthorization(store, 400, original, [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"))).receipt?.reviewId).toBe(10);
    const kept = await readBrowserAuthorization(store, 400, advanced,
      [lukeReview(), lukeReview({ id: 11, state: "COMMENTED", submitted_at: "2026-10-14T00:00:20Z" })], false, Date.parse("2026-10-14T00:00:21Z"));
    expect(kept.receipt?.reviewId).toBe(10);
    expect(browserContextDigest(original)).toBe(browserContextDigest(advanced));
  });

  it("ignores pending reviews and fails closed when a receipt no longer matches live reviews", async () => {
    const store = new MemoryBrowserStore();
    const at = Date.parse("2026-10-14T00:00:05Z");
    await readBrowserAuthorization(store, 400, context(), [], true, at);
    const bound = await readBrowserAuthorization(store, 400, context(), [lukeReview()], false, Date.parse("2026-10-14T00:00:11Z"));
    expect(bound.receipt).not.toBeNull();
    const pending = await readBrowserAuthorization(store, 400, context(), [lukeReview(), { ...lukeReview({ id: 11 }), state: "PENDING" }], false, Date.parse("2026-10-14T00:00:11Z"));
    expect(pending.receipt?.reviewId).toBe(10);
    // A dismissal after the receipt was bound invalidates it on the next read.
    const revoked = await readBrowserAuthorization(store, 400, context(),
      [lukeReview(), lukeReview({ id: 11, state: "DISMISSED", submitted_at: "2026-10-14T00:00:20Z" })], false, Date.parse("2026-10-14T00:00:21Z"));
    expect(revoked.receipt).toBeNull();
    expect(revoked.challenge).toBeNull();
  });

  it("rejects spoofed identities and root fallback for agent-authored PRs", () => {
    expect(authorizationChannel(AUTHOR)).toBe("browser");
    expect(authorizationChannel(REVIEWER)).toBe("legacy-root");
    expect(authorizationChannel({ ...AUTHOR, login: "luke-agents-" })).toBe("unknown");
    expect(authorizationChannel({ ...AUTHOR, id: 1 })).toBe("unknown");
    expect(authorizationChannel({ ...AUTHOR, type: "Bot" })).toBe("unknown");
    expect(authorizationChannel({ ...REVIEWER, id: 1 })).toBe("unknown");
    expect(() => parseBrowserContext({ ...context(), author: REVIEWER })).toThrow();
    expect(() => parseBrowserContext({ ...context(), reviewer: AUTHOR })).toThrow();
  });

  it("rejects malformed reviewer metadata and out-of-order timestamps", () => {
    expect(() => latestLukeReview([lukeReview({ submitted_at: "yesterday" })])).toThrow("browser_review_time_invalid");
    expect(() => latestLukeReview([lukeReview({ state: "MERGED" })])).toThrow("browser_review_state_invalid");
    expect(() => latestLukeReview([{ ...lukeReview(), user: { ...REVIEWER, type: "Bot" } }])).toThrow("browser_review_identity_invalid");
    expect(() => latestLukeReview([lukeReview({ id: 11, submitted_at: "2026-10-14T00:00:10Z" }), lukeReview({ id: 12, submitted_at: "2026-10-14T00:00:09Z" })])).toThrow("browser_review_order_invalid");
    expect(() => latestLukeReview([lukeReview({ id: 11 }), lukeReview({ id: 11, submitted_at: "2026-10-14T00:00:20Z" })])).toThrow("browser_review_order_invalid");
  });

  it("freezes the head candidate workflow blob before any CI result exists", async () => {
    const store = new MemoryBrowserStore();
    // The freeze reads the workflow blob pinned to the reviewed head.
    const config = bindingConfig(store, [], new BindingApi(HEAD));
    const frozen = await readHumanBinding(config, {
      pullRequest: pullRequestFixture(AUTHOR),
      number: 400, repositoryNodeId: "R_node", reviews: [], diffDigest: DIFF, diffComplete: true,
      changedFiles: [{ path: "scripts/pr-review-gate.ts", status: "modified" }], requirement: REQUIREMENT, headSha: HEAD, freeze: true,
    });
    expect(frozen.challenge?.context.validateWorkflowBlobSha).toBe(WORKFLOW);
    expect(frozen.challenge?.context.protectedPaths).toEqual(["scripts/pr-review-gate.ts"]);
    // Freezing binds the blob but grants nothing until Luke approves: the
    // approval-path list stays empty and evidence must still be present.
    expect(frozen.paths).toEqual([]);
    expect(frozen.noRuntimeImpact).toBe(false);
    expect(frozen.validateWorkflowBlobSha).toBeNull();
  });

  it("keeps a signed challenge binding after a restart and fails closed when it is deleted", async () => {
    const storeKeys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    const directory = await mkdtemp(join(await realpath(tmpdir()), "sayhear-browser-restart-"));
    const request: BindingRequest = {
      pullRequest: pullRequestFixture(AUTHOR),
      number: 400, repositoryNodeId: "R_node", reviews: [], diffDigest: DIFF, diffComplete: true,
      changedFiles: [{ path: "scripts/pr-review-gate.ts", status: "modified" }], requirement: REQUIREMENT, headSha: HEAD, freeze: true,
      now: Date.parse("2026-10-14T00:00:05Z"),
    };
    await readHumanBinding(bindingConfig(new SignedBrowserApprovalStore(directory, storeKeys.privateKey, storeKeys.publicKey)), request);
    const approved = { ...request, reviews: [lukeReview()] };
    const restarted = await readHumanBinding(bindingConfig(new SignedBrowserApprovalStore(directory, storeKeys.privateKey, storeKeys.publicKey)), approved);
    expect(restarted.receipt?.reviewId).toBe(10);
    const { unlink } = await import("node:fs/promises");
    await unlink(join(directory, "pr-400.json"));
    const afterDelete = await readHumanBinding(bindingConfig(new SignedBrowserApprovalStore(directory, storeKeys.privateKey, storeKeys.publicKey)), approved);
    expect(afterDelete.receipt).toBeNull();
    expect(afterDelete.paths).toEqual([]);
  });

  it.each([
    "sayhear-pr-review-gate:v4",
    "sayhear-pr-review-gate:v5",
    "sayhear-pr-review-gate:v6",
  ])("recovers a signed %s receipt using its original requirement projection", async (policyVersion) => {
    const v4: CompletionRecord = {
      version: 1, phase: "complete", attempts: 1, nextRetryAt: 0, reason: null, mergeSha: "9".repeat(40),
      identity: {
        repositoryId: 1312399710, pullRequestNumber: 400, pullRequestNodeId: "PR_node", headSha: HEAD, approvedBaseSha: BASE,
        requirementDigest: REQUIREMENT, baseRepositoryId: 1312399710, baseRef: "main", botActorId: 999, reviewId: 9, appId: 123,
        policyVersion, issueNumbers: [1],
      },
    };
    const parsed = parseCompletionRecord(JSON.parse(JSON.stringify(v4)));
    expect(parsed.identity.policyVersion).toBe(policyVersion);
    expect(parsed.identity.humanChannel).toBe("app");

    const issue = { number: 1, state: "open" as const, title: "Requirement", body: "Existing behavior", updated_at: "2026-10-14T00:00:00Z", labels: ["bug"] };
    const pull = { number: 400, title: "Change", body: "Fixes #1", updated_at: "2026-10-14T00:00:00Z", user: { id: 1 }, base: { sha: BASE } };
    const comments: GitHubComment[] = [{ id: 1, body: "inline note", user: { id: 5, login: "someone" }, created_at: "t", updated_at: "t" }];
    // A human review, not the App actor, so it stays inside the legacy digest.
    const approvalRecord: BindingReview[] = [{ id: 9, body: "approve", state: "APPROVED", commit_id: HEAD, user: { id: 555, login: "someone" } }];
    const legacyDigest = requirementDigest(
      [{ ...issue, updatedAt: issue.updated_at, discussionDigest: digestDiscussion(comments, [], "review-inclusive-v4") }],
      { ...pull, updatedAt: pull.updated_at, discussionDigest: digestDiscussion([], approvalRecord, "review-inclusive-v4") },
    );
    const api: GitHubApi = {
      request: async <T>(path: string) => structuredClone(path.includes("/issues/1") ? issue : pull) as T,
      pages: async <T>(path: string) => (
        path.includes("/issues/1/comments") ? comments
          : path.includes("/pulls/400/comments") || path.includes("/issues/400/comments") ? []
            : approvalRecord
      ) as unknown as T[],
      bytes: async () => new Uint8Array(),
    };
    const v5Digest = requirementDigest(
      [{ ...issue, updatedAt: issue.updated_at, discussionDigest: digestDiscussion(comments, [], "review-exclusive-v5") }],
      { ...pull, updatedAt: pull.updated_at, discussionDigest: digestDiscussion([], [], "review-exclusive-v5") },
    );
    expect(v5Digest).not.toBe(legacyDigest);
    const requirement = policyVersion === "sayhear-pr-review-gate:v4" ? legacyDigest : v5Digest;
    const wrongProjection = policyVersion === "sayhear-pr-review-gate:v4" ? v5Digest : legacyDigest;
    const directory = await mkdtemp(join(await realpath(tmpdir()), "sayhear-policy-recovery-"));
    const completionKeys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    const { SignedCompletionStore } = await import("../scripts/pr-approval/completion.ts");
    const store = new SignedCompletionStore(directory, completionKeys.privateKey, completionKeys.publicKey);
    await store.save({ ...parsed, identity: { ...parsed.identity, requirementDigest: requirement } });
    const signed = await store.read(400);
    if (signed === null) throw new Error("Signed completion receipt is missing.");
    expect(signed.identity.policyVersion).toBe(policyVersion);
    await expect(verifyCompletionRequirements(api, signed.identity)).resolves.toBeUndefined();
    await expect(verifyCompletionRequirements(api, { ...signed.identity, requirementDigest: wrongProjection })).rejects.toThrow(CompletionMismatch);
  });

  it("reports needs_attention when Luke dismisses the review after the merge", async () => {
    const browser: CompletionRecord = {
      version: 1, phase: "merge_unconfirmed", attempts: 0, nextRetryAt: 0, reason: null, mergeSha: null,
      identity: {
        repositoryId: 1312399710, pullRequestNumber: 400, pullRequestNodeId: "PR_node", headSha: HEAD, approvedBaseSha: BASE,
        requirementDigest: REQUIREMENT, baseRepositoryId: 1312399710, baseRef: "main", botActorId: 999, reviewId: 9, appId: 123,
        policyVersion: PR_REVIEW_GATE_POLICY_VERSION, issueNumbers: [1], humanChannel: "browser", humanReviewId: 10, epoch: "epoch-1",
      },
    };
    const merged = { number: 400, node_id: "PR_node", state: "closed", merged: true, merge_commit_sha: "9".repeat(40),
      head: { sha: HEAD, repo: { id: 1312399710 } }, base: { ref: "main", sha: BASE, repo: { id: 1312399710 } } };
    const appApproval = { id: 9, state: "APPROVED", commit_id: HEAD, user: { id: 999, login: "sayhear[bot]" },
      body: `<!-- sayhear-pr-auto-approval-review:v2 pr=400 head=${HEAD} base=${BASE} requirement=${REQUIREMENT} outcome=approve -->` };
    const reviews = [appApproval, lukeReview({ id: 11, state: "DISMISSED", submitted_at: "2026-10-14T00:00:20Z" })];
    const api: GitHubApi = {
      request: async <T>() => structuredClone(merged) as T,
      pages: async <T>() => structuredClone(reviews) as unknown as T[],
      bytes: async () => new Uint8Array(),
    };
    await expect(confirmCompletionMerge(api, browser.identity)).rejects.toThrow(CompletionMismatch);
    let closes = 0;
    const store: CompletionStore = { list: async () => [browser], read: async () => browser, save: async () => undefined };
    const result = await recoverCompletion(store, browser, { confirmMerge: async () => confirmCompletionMerge(api, browser.identity), completeIssues: async () => { closes += 1; } });
    expect(result.phase).toBe("needs_attention");
    expect(result.reason).toBe("human_review_revoked");
    expect(closes).toBe(0);
  });

  it.each([
    ["final-decision-v1", "COMMENTED", true],
    [undefined, "COMMENTED", false],
    ["final-decision-v1", "CHANGES_REQUESTED", false],
    ["final-decision-v1", "DISMISSED", false],
  ] as const)("confirms a merged %s browser approval after a trailing %s review: %s", async (liveness, trailing, accepted) => {
    const identity: CompletionRecord["identity"] = {
      repositoryId: 1312399710, pullRequestNumber: 400, pullRequestNodeId: "PR_node", headSha: HEAD, approvedBaseSha: BASE,
      requirementDigest: REQUIREMENT, baseRepositoryId: 1312399710, baseRef: "main", botActorId: 999, reviewId: 9, appId: 123,
      policyVersion: PR_REVIEW_GATE_POLICY_VERSION, issueNumbers: [1], humanChannel: "browser", humanReviewId: 10, epoch: "epoch-1",
      ...(liveness ? { humanLiveness: liveness } : {}),
    };
    const merged = { number: 400, node_id: "PR_node", state: "closed", merged: true, merge_commit_sha: "9".repeat(40),
      head: { sha: HEAD, repo: { id: 1312399710 } }, base: { ref: "main", sha: BASE, repo: { id: 1312399710 } } };
    const appApproval = { id: 9, state: "APPROVED", commit_id: HEAD, user: { id: 999, login: "sayhear[bot]" },
      body: `<!-- sayhear-pr-auto-approval-review:v2 pr=400 head=${HEAD} base=${BASE} requirement=${REQUIREMENT} outcome=approve -->` };
    const reviews = [appApproval, lukeReview({ id: 10, submitted_at: "2026-10-14T00:00:10Z" }),
      lukeReview({ id: 11, state: trailing, submitted_at: "2026-10-14T00:00:20Z" })];
    const api: GitHubApi = {
      request: async <T>() => structuredClone(merged) as T,
      pages: async <T>() => structuredClone(reviews) as unknown as T[],
      bytes: async () => new Uint8Array(),
    };
    if (accepted) await expect(confirmCompletionMerge(api, identity)).resolves.toBe("9".repeat(40));
    else await expect(confirmCompletionMerge(api, identity)).rejects.toThrow("human_review_revoked");
  });

  it("rejects final-decision liveness on a non-browser completion identity", () => {
    const record = {
      version: 2, phase: "merge_unconfirmed", attempts: 0, nextRetryAt: 0, reason: null, mergeSha: null,
      identity: {
        repositoryId: 1312399710, pullRequestNumber: 400, pullRequestNodeId: "PR_node", headSha: HEAD, approvedBaseSha: BASE,
        requirementDigest: REQUIREMENT, baseRepositoryId: 1312399710, baseRef: "main", botActorId: 999, reviewId: 9, appId: 123,
        policyVersion: PR_REVIEW_GATE_POLICY_VERSION, issueNumbers: [1], humanChannel: "app", humanLiveness: "final-decision-v1",
      },
    };
    expect(() => parseCompletionRecord(record)).toThrow("completion_schema_invalid");
    expect(() => parseCompletionRecord({ ...record, identity: { ...record.identity, humanChannel: "browser", humanLiveness: "v2" } })).toThrow("completion_schema_invalid");
    expect(parseCompletionRecord({ ...record, identity: { ...record.identity, humanChannel: "browser" } }).identity.humanLiveness).toBe("final-decision-v1");
  });

  it("includes inline comment changes and excludes every top-level review record from v5 requirements", () => {
    const comments: GitHubComment[] = [{ id: 1, body: "inline", user: { id: 5, login: "someone" }, created_at: "t1", updated_at: "t1" }];
    const approval: BindingReview = { id: 7, body: "approve", state: "APPROVED", commit_id: HEAD, user: { id: LUKE_IDENTITY.id, login: LUKE_IDENTITY.login } };
    const dismissed: BindingReview = { id: 8, body: "", state: "DISMISSED", commit_id: HEAD, user: { id: LUKE_IDENTITY.id, login: LUKE_IDENTITY.login } };
    const v5 = digestDiscussion(comments, [approval, dismissed], "review-exclusive-v5");
    const legacy = digestDiscussion(comments, [approval, dismissed], "review-inclusive-v4");
    expect(v5).not.toBe(legacy);
    expect(v5).toBe(digestDiscussion(comments, [], "review-inclusive-v4"));
    expect(v5).not.toBe(digestDiscussion([{ ...comments[0]!, body: "edited inline" }], [], "review-exclusive-v5"));
  });
});

describe("signed browser approval store", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  async function store() {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "sayhear-browser-test-"));
    return { directory, store: new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey) };
  }
  async function save(store: BrowserApprovalStore, value: BrowserState) { await store.save(value); }
  const state: BrowserState = { version: 1, pullRequestNumber: 400, epoch: "epoch-1", challenge: null, receipt: null };

  it("round-trips a signed state across a new store instance", async () => {
    const { directory, store: first } = await store();
    await first.save({ ...state, challenge: { epoch: "epoch-1", context: context(), frozenAt: 1_000, watermark: { id: 3, submittedAt: 900 } } });
    const reopened = new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey);
    expect((await reopened.read(400))?.challenge?.watermark.id).toBe(3);
  });

  it("rejects a tampered payload and a tampered signature", async () => {
    const { directory, store: original } = await store();
    await original.save(state);
    const file = join(directory, "pr-400.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    const forged = parseBrowserState({ ...state, epoch: "epoch-forged" });
    await writeFile(file, JSON.stringify({ payload: JSON.stringify(forged), signature: envelope.signature }));
    await expect(new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey).read(400)).rejects.toThrow("browser_approval_signature_invalid");
    await writeFile(file, JSON.stringify({ payload: envelope.payload, signature: Buffer.from("nope").toString("base64") }));
    await expect(new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey).read(400)).rejects.toThrow("browser_approval_signature_invalid");
  });

  it("rejects a symlinked record file and a group-writable directory", async () => {
    const { directory, store: original } = await store();
    await original.save(state);
    const file = join(directory, "pr-400.json");
    const target = join(directory, "pr-400.other.json");
    await writeFile(target, await readFile(file));
    const { unlink } = await import("node:fs/promises");
    await unlink(file);
    await symlink(target, file);
    await expect(new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey).read(400)).rejects.toThrow();
    await unlink(file);
    await chmod(directory, 0o770);
    await expect(new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey).read(400)).rejects.toThrow("browser_approval_directory_untrusted");
  });

  it("rejects a record swapped onto another pull request path", async () => {
    const { directory, store: original } = await store();
    await original.save(state);
    const { rename } = await import("node:fs/promises");
    await rename(join(directory, "pr-400.json"), join(directory, "pr-401.json"));
    await expect(new SignedBrowserApprovalStore(directory, keys.privateKey, keys.publicKey).read(401)).rejects.toThrow("browser_approval_path_mismatch");
  });
});

describe("channel routing in the controller", () => {
  const policy: TrustedPrReviewPolicy = {
    repositoryId: 1312399710, repositoryName: "lukemyself-hub/SayHear", defaultBranch: "main",
    policyVersion: PR_REVIEW_GATE_POLICY_VERSION, reviewAppId: 1, actionsAppId: 2, validateWorkflowBlobSha: WORKFLOW,
    humanApprovedPaths: [], humanApprovedNoRuntimeImpact: false, humanApprovalChannel: "browser",
  };
  function humanBinding(channel: HumanReviewBinding["channel"]): HumanReviewBinding {
    return { channel, paths: [], noRuntimeImpact: false, validateWorkflowBlobSha: null, receipt: null, challenge: null };
  }
  function gateInput(changedPaths: string[]): PrReviewGateInput {
    const input = {
      repository: { id: 1312399710, fullName: "lukemyself-hub/SayHear", defaultBranch: "main", defaultBranchSha: BASE, allowAutoMerge: true },
      pullRequest: {
        number: 400, state: "open", draft: false, title: "Ordinary change", body: "Fixes #1", updatedAt: "t",
        discussionDigest: "1".repeat(64), externalReviewState: "clear", headSha: HEAD, baseSha: BASE, mergeSha: null,
        baseRef: "main", headRepositoryId: 1312399710, authorId: AGENT_IDENTITY.id, lastCommitAuthorId: AGENT_IDENTITY.id,
        linkedIssueNumbers: [1], keepOpenIssueNumbers: [], issueClosureAmbiguous: false, closingIssueNumbers: [],
        changedFiles: changedPaths.map((path) => ({ path, status: "modified" as const })),
      },
      issues: [{
        number: 1, state: "open", title: "Requirement", body: "Existing behavior", updatedAt: "t",
        discussionDigest: "2".repeat(64), labels: ["bug"], blockedBy: [], pause: { active: false, source: "none" },
      }],
      review: {
        version: PR_REVIEW_REPORT_VERSION, repositoryId: 1312399710, pullRequestNumber: 400, headSha: HEAD, baseSha: BASE,
        policyVersion: PR_REVIEW_GATE_POLICY_VERSION, requirementDigest, decision: "approve", diffComplete: true,
        reviewerAppId: 1, reviewerActorId: 9,
        declaredImpacts: ["server-business"], capability: { newCapabilityEnabled: false, majorContractChange: false, externalMvpRelease: false },
        riskFlags: { productDefinitionChanged: false, authorizationBoundaryChanged: false, privacyBoundaryChanged: false, destructiveMigration: false, productionFeatureEnablement: false },
        findings: [],
      },
      evidence: [],
      branchProtection: { readable: true, protected: true, branch: "main", requiresUpToDate: true, dismissesStaleReviews: true, enforcesAdmins: true, requiredApprovingReviews: 1, requiredChecks: [{ name: "validate", appId: 2 }, { name: "pr-review-gate", appId: 1 }], bypassActorIds: [] },
      runtime: { reviewAppInstalledForRepository: true, anotherApprovalInFlight: false, productionMergeAuthorized: true, ordinaryMergeTriggersProduction: false },
    } as unknown as PrReviewGateInput;
    return { ...input, review: { ...input.review, requirementDigest: requirementDigest(input.issues, input.pullRequest) } };
  }

  it("admits an ordinary agent-authored change with no browser receipt and no Luke approval", () => {
    const input = gateInput(["packages/application/src/thing.ts"]);
    // Evidence is skipped because CI is simulated as not run, so the gate must
    // still be blocked on evidence, not on human authorization.
    const report = evaluatePrReviewGate(input, policy);
    expect(report.reasons.map((reason) => reason.code)).not.toContain("browser_human_approval_required");
  });

  it("blocks a protected agent-authored change without a bound browser receipt", () => {
    const input = gateInput(["scripts/pr-review-gate.ts"]);
    const report = evaluatePrReviewGate({ ...input, evidence: [] }, policy);
    expect(report.reasons[0]?.code).toBe("browser_human_approval_required");
    // A root-owned record never fills the browser channel for an agent author.
    // Even if a root record existed, the browser channel refuses to seat it as
    // an approval, so the same protected change stays blocked.
    expect(evaluatePrReviewGate(input, { ...policy, humanApprovedPaths: [], humanApprovalChannel: "browser" }).reasons[0]?.code)
      .toBe("browser_human_approval_required");
  });

  it("waits instead of handing back when only Luke's browser approval is missing", () => {
    const report = evaluatePrReviewGate(gateInput(["scripts/pr-review-gate.ts"]), policy);
    expect(report.outcome).toBe("human_decision");
    // A wait, not a handoff: a handoff would clear `ongoing`, set
    // `ready-for-agent`, and let an implementation agent push a new head, which
    // voids the challenge this PR is already waiting on.
    expect(isBrowserApprovalWait(report)).toBe(true);
    // Every other human decision keeps the handoff path, which returns the Issue
    // to an implementation agent and records the outcome.
    const paused = gateInput(["packages/application/src/thing.ts"]);
    const pausedReport = evaluatePrReviewGate({
      ...paused,
      issues: paused.issues.map((issue) => ({ ...issue, pause: { active: true, source: "maintainer" as const } })),
    }, policy);
    expect(pausedReport.outcome).toBe("human_decision");
    expect(isBrowserApprovalWait(pausedReport)).toBe(false);
    expect(pausedReport.reasons[0]?.code).toBe("human_review_required");
  });

  it("keeps a protected path from masking another human decision", () => {
    // The protected-path reason is reported last, so a pause still wins and still
    // hands the Issue back instead of turning the wait into an approval prompt.
    const paused = gateInput(["scripts/pr-review-gate.ts"]);
    const pausedReport = evaluatePrReviewGate({
      ...paused,
      issues: paused.issues.map((issue) => ({ ...issue, pause: { active: true, source: "maintainer" as const } })),
    }, policy);
    expect(pausedReport.reasons[0]?.code).toBe("human_review_required");
    expect(isBrowserApprovalWait(pausedReport)).toBe(false);
    // A non-browser channel keeps the legacy reason for the same protected path.
    const legacy = evaluatePrReviewGate(gateInput(["scripts/pr-review-gate.ts"]), { ...policy, humanApprovalChannel: "legacy-root" });
    expect(legacy.reasons[0]?.code).toBe("human_review_required");
    expect(isBrowserApprovalWait(legacy)).toBe(false);
  });

  it("needs a browser receipt only for a PR that touches a protected path", () => {
    const browser = humanBinding("browser");
    const protectedFiles = [{ path: "scripts/pr-review-gate.ts", status: "modified" as const }];
    expect(browserAuthorizationRequired(browser, protectedFiles)).toBe(true);
    // An ordinary agent PR needs no human binding, so a missing receipt must not
    // hold it back from the pinned merge its channel performs.
    expect(browserAuthorizationRequired(browser, [{ path: "packages/application/src/thing.ts", status: "modified" }])).toBe(false);
    expect(browserAuthorizationRequired(humanBinding("legacy-root"), protectedFiles)).toBe(false);
    expect(browserAuthorizationRequired(humanBinding("unknown"), protectedFiles)).toBe(false);
  });

  it("refuses to guess a requirement projection for an unknown policy version", () => {
    expect(requirementProjectionFor(PR_REVIEW_GATE_POLICY_VERSION)).toBe("review-exclusive-v5");
    expect(requirementProjectionFor(PR_REVIEW_GATE_INSTALLED_POLICY_VERSION)).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v8")).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v9")).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v10")).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v6")).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v5")).toBe("review-exclusive-v5");
    expect(requirementProjectionFor("sayhear-pr-review-gate:v4")).toBe("review-inclusive-v4");
    // v7 was reviewed on main but never installed, so it never wrote a receipt.
    expect(() => requirementProjectionFor("sayhear-pr-review-gate:v7")).toThrow();
    expect(requirementProjectionFor("sayhear-pr-review-gate:v11")).toBe("review-exclusive-v5");
    expect(() => requirementProjectionFor("sayhear-pr-review-gate:v12")).toThrow();
  });

  it("exempts a protected path once the approval names it", () => {
    const input = gateInput(["scripts/pr-review-gate.ts"]);
    const codes = evaluatePrReviewGate(input, { ...policy, humanApprovedPaths: ["scripts/pr-review-gate.ts"] })
      .reasons.map((reason) => reason.code);
    expect(codes).not.toContain("browser_human_approval_required");
    expect(codes).not.toContain("human_review_required");
    // The gate and the frozen browser challenge share this one function, so the
    // paths Luke approves and the paths the gate demands cannot drift apart.
    expect(protectedReviewPaths(input.pullRequest.changedFiles)).toEqual(["scripts/pr-review-gate.ts"]);
    expect(protectedReviewPaths(input.pullRequest.changedFiles, ["scripts/pr-review-gate.ts"])).toEqual([]);
    expect(protectedReviewPaths([{ path: "docs/notes.md", status: "modified" }])).toEqual([]);
  });

  it("refuses to fill the browser channel from a root record for agent-authored PRs", async () => {
    // A root-owned record exists for the same PR, but an agent author must
    // never be seated through it.
    const config = bindingConfig(new MemoryBrowserStore(), [
      { pullRequestNumber: 400, approvedHeadSha: HEAD, diffDigest: DIFF, requirementDigest: REQUIREMENT, paths: ["scripts/pr-review-gate.ts"], validateWorkflowBlobSha: null, approvedAt: "2026-10-14T00:00:00Z" },
    ]);
    const binding = await readHumanBinding(config, {
      pullRequest: pullRequestFixture(AUTHOR),
      number: 400, repositoryNodeId: "R_node", reviews: [], diffDigest: DIFF, diffComplete: true,
      changedFiles: [{ path: "scripts/pr-review-gate.ts", status: "modified" }], requirement: REQUIREMENT, headSha: HEAD, freeze: false,
    });
    expect(binding.channel).toBe("browser");
    expect(binding.paths).toEqual([]);
    expect(binding.noRuntimeImpact).toBe(false);
  });

  it("keeps the owner-authored root channel for historical PRs", async () => {
    const config = bindingConfig(new MemoryBrowserStore(), [
      { pullRequestNumber: 400, approvedHeadSha: HEAD, diffDigest: DIFF, requirementDigest: REQUIREMENT, paths: ["docs/adr/x.md"], noRuntimeImpact: true, validateWorkflowBlobSha: null, approvedAt: "2026-10-14T00:00:00Z" },
    ]);
    const binding = await readHumanBinding(config, {
      pullRequest: pullRequestFixture(REVIEWER),
      number: 400, repositoryNodeId: "R_node", reviews: [], diffDigest: DIFF, diffComplete: true,
      changedFiles: [{ path: "docs/adr/x.md", status: "modified" }], requirement: REQUIREMENT, headSha: HEAD, freeze: false,
    });
    expect(binding.channel).toBe("legacy-root");
    expect(binding.paths).toEqual(["docs/adr/x.md"]);
    expect(binding.noRuntimeImpact).toBe(true);
  });

  it("merges a browser approval immediately and never arms deferred auto-merge", () => {
    const browser = humanBinding("browser");
    expect(mergeActionFor(browser, { mergeable: true, mergeable_state: "clean" })).toBe("merge-now");
    // GitHub reports null/unknown while it computes mergeability. The browser
    // channel must wait: arming a deferred auto-merge would let a later head
    // land without a fresh Luke approval.
    expect(mergeActionFor(browser, { mergeable: null, mergeable_state: "unknown" })).toBe("wait");
    expect(mergeActionFor(browser, { mergeable: false, mergeable_state: "blocked" })).toBe("wait");
    expect(mergeActionFor(browser, {})).toBe("wait");
    // The root channel keeps its historical deferred auto-merge behavior.
    expect(mergeActionFor(humanBinding("legacy-root"), { mergeable: null, mergeable_state: "unknown" })).toBe("arm-auto-merge");
    expect(mergeActionFor(humanBinding("unknown"), {})).toBe("arm-auto-merge");
    // Under merge-queue integration the queue performs the merge, so both
    // channels enter the queue instead of pinning a merge commit.
    expect(mergeActionFor(browser, { mergeable: true, mergeable_state: "clean" }, "merge-queue")).toBe("enqueue");
    expect(mergeActionFor(humanBinding("legacy-root"), { mergeable: true, mergeable_state: "clean" }, "merge-queue")).toBe("enqueue");
    // A not-yet-clean PR is never judged clean just because the queue exists.
    expect(mergeActionFor(browser, { mergeable: null, mergeable_state: "unknown" }, "merge-queue")).toBe("wait");
    expect(mergeActionFor(humanBinding("legacy-root"), { mergeable: false, mergeable_state: "dirty" }, "merge-queue")).toBe("wait");
    // Under serialized merge the controller pins one merge against the current
    // main, so an out-of-date base that reports `behind` still merges, and the
    // deferred intent is never armed on either channel.
    expect(mergeActionFor(browser, { mergeable: true, mergeable_state: "behind" }, "serialized-merge")).toBe("merge-now");
    expect(mergeActionFor(humanBinding("legacy-root"), { mergeable: true, mergeable_state: "behind" }, "serialized-merge")).toBe("merge-now");
    expect(mergeActionFor(humanBinding("legacy-root"), { mergeable: true, mergeable_state: "clean" }, "serialized-merge")).toBe("merge-now");
    expect(mergeActionFor(browser, { mergeable: false, mergeable_state: "dirty" }, "serialized-merge")).toBe("wait");
    expect(mergeActionFor(browser, { mergeable: null, mergeable_state: "unknown" }, "serialized-merge")).toBe("wait");
  });

  it.each(["browser", "legacy-root"] as const)("allows confirmed blocked mergeability only for serialized merge on %s", (channel) => {
    const binding = humanBinding(channel);
    expect(mergeActionFor(binding, { mergeable: true, mergeable_state: "blocked" }, "serialized-merge")).toBe("merge-now");
    expect(mergeActionFor(binding, { mergeable: true, mergeable_state: "blocked" }, "merge-queue")).toBe("wait");
    expect(mergeActionFor(binding, { mergeable: true, mergeable_state: "blocked" }, "up-to-date-base"))
      .toBe(channel === "browser" ? "wait" : "arm-auto-merge");
    for (const mergeable of [null, false, undefined]) {
      expect(mergeActionFor(binding, { mergeable, mergeable_state: "blocked" }, "serialized-merge")).toBe("wait");
    }
    for (const state of ["unknown", "dirty", "unstable", "draft", "has_hooks", undefined]) {
      expect(mergeActionFor(binding, { mergeable: true, mergeable_state: state }, "serialized-merge")).toBe("wait");
    }
  });

  it("performs the browser merge at the call site without ever arming deferred auto-merge", async () => {
    const requests: string[] = [];
    function stubApi(): GitHubApi {
      return {
        request: async <T>(path: string, options?: { method?: string }) => {
          requests.push(`${options?.method ?? "GET"} ${path}`);
          if (path === "/graphql") {
            return { data: { enablePullRequestAutoMerge: { pullRequest: { number: 400 } } } } as T;
          }
          return { merged: true } as T;
        },
        pages: async <T>() => [] as T[],
        bytes: async () => new Uint8Array(),
      };
    }
    const report = { pullRequestNumber: 400, headSha: HEAD };
    const repository = { allow_merge_commit: true };
    // The browser channel merges the pinned head now and leaves nothing armed.
    await applyMergeAction(
      bindingConfig(new MemoryBrowserStore(), [], stubApi()), report, repository, pullRequestFixture(AUTHOR), "merge-now",
    );
    expect(requests).toEqual([`PUT /repos/lukemyself-hub/SayHear/pulls/400/merge`]);
    // Routing the browser channel through the auto-merge helper instead would call
    // the enablePullRequestAutoMerge mutation, which is the regression to catch.
    requests.length = 0;
    await applyMergeAction(
      bindingConfig(new MemoryBrowserStore(), [], stubApi()), report, repository,
      { ...pullRequestFixture(AUTHOR), mergeable: false, mergeable_state: "unknown" }, "arm-auto-merge",
    );
    expect(requests).toContain("POST /graphql");
    expect(requests.some((call) => call.endsWith("/pulls/400/merge"))).toBe(false);
  });

  it("enters the merge queue on the reviewed head instead of pinning a merge", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    function queueApi(existingEntry: boolean): GitHubApi {
      return {
        request: async <T>(path: string, options?: { method?: string; body?: unknown }) => {
          calls.push({ path, body: options?.body });
          expect(path).toBe("/graphql");
          const query = String((options?.body as { query?: string } | undefined)?.query ?? "");
          return (query.includes("EnqueuePullRequestInput")
            ? { data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_1", state: "AWAITING_CHECKS" } } } }
            : { data: { repository: { pullRequest: { mergeQueueEntry: existingEntry ? { id: "MQE_1" } : null } } } }) as T;
        },
        pages: async <T>() => [] as T[],
        bytes: async () => new Uint8Array(),
      };
    }
    const report = { pullRequestNumber: 400, headSha: HEAD };

    await applyMergeAction(
      bindingConfig(new MemoryBrowserStore(), [], queueApi(false)), report, { allow_merge_commit: true },
      pullRequestFixture(AUTHOR), "enqueue",
    );

    const mutations = calls.filter((call) => String((call.body as { query?: string }).query).includes("EnqueuePullRequestInput"));
    expect(mutations).toHaveLength(1);
    expect((mutations[0]!.body as { variables?: unknown }).variables).toEqual({
      input: { pullRequestId: "PR_node", expectedHeadOid: HEAD },
    });

    // Idempotent: an entry that already exists is left alone, and nothing is
    // ever sent to the pinned merge endpoint on this path.
    calls.length = 0;
    await applyMergeAction(
      bindingConfig(new MemoryBrowserStore(), [], queueApi(true)), report, { allow_merge_commit: true },
      pullRequestFixture(AUTHOR), "enqueue",
    );
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.path === "/graphql")).toBe(true);
  });

  it("exposes the v11 policy and unchanged browser capability in the build identity", () => {
    const identity = controllerBuildIdentity();
    expect(identity.policyVersion).toBe("sayhear-pr-review-gate:v11");
    expect(PR_REVIEW_REPORT_VERSION).toBe("sayhear-pr-review-report:v4");
    expect(identity.browserApprovalVersion).toBe("sayhear-pr-browser-approval:v1");
  });
});
