/**
 * Unified daily release validation entry.
 *
 * SPEC #275 decisions 1, 11 and 12 make the daily release path
 * "fixed PR CI baseline + the checks the change's behavior impact actually
 * needs". This module is that one release-tool entry. It does not add a
 * parallel gate per domain, an extra human approval step or a UI fast lane.
 *
 * The rules it encodes:
 *
 * - The fixed PR CI baseline is always present; it can never be dropped by an
 *   impact declaration. {@link FIXED_PR_CI_BASELINE} is asserted against
 *   `pnpm validate` in the test so it cannot drift.
 * - Paths are hints only. They can add a targeted check for a boundary change
 *   so a narrow declaration cannot miss it, but they can never trigger the
 *   full 12-item capability acceptance.
 * - Unknown impact is located first ({@link planDailyReleaseValidation}
 *   sets `requiresImpactLocation`), never auto-escalated to the full producer.
 * - Full capability acceptance (`pnpm release:g1:produce`) is triggered ONLY
 *   by new capability enablement, a major overall contract change or an
 *   External MVP release.
 * - Same-byte artifacts from a previous passing run are reused instead of
 *   re-parsed; a failed artifact is retained and only its affected check is
 *   rerun, never resampled to paper over a failure.
 *
 * The effective configuration comparison reuses the pure module from ticket
 * #278 (`./effective-runtime-config-gate`) rather than duplicating it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  compareEffectiveRuntimeConfiguration,
  parseEffectiveConfigurationSnapshot,
} from "./effective-runtime-config-gate";

export const DAILY_RELEASE_VALIDATION_VERSION =
  "1a3b-daily-release-validation:v1";
export const DAILY_RELEASE_VALIDATION_REQUEST_VERSION =
  "1a3b-daily-release-validation-request:v1";
export const DAILY_RELEASE_VALIDATION_PLAN_VERSION =
  "1a3b-daily-release-validation-plan:v1";

/** The immutable `pnpm validate` composition every pull request runs. */
export const FIXED_PR_CI_BASELINE = [
  "baseline:check-runtime",
  "baseline:check-boundaries",
  "baseline:check-purge-surfaces",
  "baseline:typecheck",
  "baseline:test",
  "baseline:build",
] as const;

export type ReleaseImpactKind =
  | "ui"
  | "server-business"
  | "reflection-journal"
  | "prompt-budget"
  | "owner-permission"
  | "purge-coverage"
  | "provider-migration";

export const RELEASE_IMPACT_KINDS: readonly ReleaseImpactKind[] = [
  "ui",
  "server-business",
  "reflection-journal",
  "prompt-budget",
  "owner-permission",
  "purge-coverage",
  "provider-migration",
];

export type CapabilityAcceptanceTrigger =
  | "new-capability-enabled"
  | "major-contract-change"
  | "external-mvp-release";

export type ReleaseCheckKind =
  | "fixed-baseline"
  | "behavior"
  | "evidence-producer"
  | "full-acceptance";

export type ReleaseCheckImpact = ReleaseImpactKind | "baseline" | "capability";

export type ReleaseCheck = Readonly<{
  id: string;
  title: string;
  command: string;
  kind: ReleaseCheckKind;
  impact: ReleaseCheckImpact;
  /** True only for the 12-item `release:g1:produce` full producer. */
  fullProducer: boolean;
  providerCalls: boolean;
  modelCalls: boolean;
  evidenceLocation?: string;
}>;

const FULL_ACCEPTANCE_ID = "capability:full-acceptance";
const FULL_PRODUCER_COMMAND = "pnpm release:g1:produce";

export const RELEASE_CHECKS: readonly ReleaseCheck[] = [
  {
    id: "baseline:check-runtime",
    title: "Runtime version",
    command: "pnpm check:runtime",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "baseline:check-boundaries",
    title: "Module boundaries",
    command: "pnpm check:boundaries",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "baseline:check-purge-surfaces",
    title: "Purge surface inventory",
    command: "pnpm check:purge-surfaces",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "baseline:typecheck",
    title: "Typecheck",
    command: "pnpm typecheck",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "baseline:test",
    title: "Unit and system tests",
    command: "pnpm test:ci",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "baseline:build",
    title: "Build",
    command: "pnpm build",
    kind: "fixed-baseline",
    impact: "baseline",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
  },
  {
    id: "ui:portal-smoke",
    title: "Portal behavior smoke",
    command:
      "pnpm exec vitest run tests/portal-integration.test.ts tests/portal-conversation-status.test.ts",
    kind: "behavior",
    impact: "ui",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/portal-integration.test.ts",
  },
  {
    id: "server:deterministic-behavior",
    title: "Deterministic server behavior",
    command:
      "pnpm exec vitest run tests/private-write-gate.test.ts tests/startup-validation-runtime.test.ts",
    kind: "behavior",
    impact: "server-business",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/private-write-gate.test.ts",
  },
  {
    id: "reflection:lineage",
    title: "Reflection/Journal lineage",
    command:
      "pnpm exec vitest run tests/system/reflection-daily-weekly.system.test.ts",
    kind: "behavior",
    impact: "reflection-journal",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/reflection-daily-weekly.system.test.ts",
  },
  {
    id: "reflection:idempotency",
    title: "Reflection/Journal idempotency",
    command:
      "pnpm exec vitest run tests/system/reflection-inspection.system.test.ts",
    kind: "behavior",
    impact: "reflection-journal",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/reflection-inspection.system.test.ts",
  },
  {
    id: "reflection:cas-epoch-freshness",
    title: "Current-pointer CAS, Data Epoch and freshness",
    command:
      "pnpm exec vitest run tests/system/journal-eligibility.system.test.ts tests/system/journal-eligibility-stale-recovery.system.test.ts",
    kind: "behavior",
    impact: "reflection-journal",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/journal-eligibility.system.test.ts",
  },
  {
    id: "prompt-budget:synthetic-samples",
    title: "Prompt/budget fixed synthetic samples",
    command:
      "pnpm exec vitest run tests/runtime-config.test.ts tests/system/narrative-validation.system.test.ts",
    kind: "behavior",
    impact: "prompt-budget",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/runtime-config.test.ts",
  },
  {
    id: "prompt-budget:effective-config-diff",
    title: "Deployed effective configuration diff",
    command: "pnpm release:config:compare",
    kind: "behavior",
    impact: "prompt-budget",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "effective-runtime-config report",
  },
  {
    id: "permission:isolation",
    title: "Owner/permission isolation",
    command:
      "pnpm exec vitest run tests/system/internal-access.system.test.ts tests/evidence-step-up.unit.test.ts",
    kind: "behavior",
    impact: "owner-permission",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/internal-access.system.test.ts",
  },
  {
    id: "permission:race",
    title: "Owner/permission race",
    command:
      "pnpm exec vitest run tests/system/conversation-action-admission.system.test.ts",
    kind: "behavior",
    impact: "owner-permission",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation:
      "tests/system/conversation-action-admission.system.test.ts",
  },
  {
    id: "purge:full-restore-drill",
    title: "Full Purge/restore drill",
    command:
      "pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts tests/system/owner-full-purge.system.test.ts",
    kind: "behavior",
    impact: "purge-coverage",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/g1-purge-restore-drill.system.test.ts",
  },
  {
    id: "provider:effective-config-diff",
    title: "Deployed Provider configuration diff",
    command: "pnpm release:config:compare",
    kind: "behavior",
    impact: "provider-migration",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "effective-runtime-config report",
  },
  {
    id: "provider:affected-role-calls",
    title: "Affected-role Provider calls",
    command: "pnpm exec tsx scripts/capture-g1-role-provider-calls.ts",
    kind: "evidence-producer",
    impact: "provider-migration",
    fullProducer: false,
    providerCalls: true,
    modelCalls: true,
    evidenceLocation: "captured role-call evidence",
  },
  {
    id: "provider:privacy-checks",
    title: "Provider migration privacy checks",
    command: "pnpm exec vitest run tests/system/portal-acceptance.system.test.ts",
    kind: "behavior",
    impact: "provider-migration",
    fullProducer: false,
    providerCalls: false,
    modelCalls: false,
    evidenceLocation: "tests/system/portal-acceptance.system.test.ts",
  },
  {
    id: FULL_ACCEPTANCE_ID,
    title: "Full 12-item capability acceptance",
    command: FULL_PRODUCER_COMMAND,
    kind: "full-acceptance",
    impact: "capability",
    fullProducer: true,
    providerCalls: true,
    modelCalls: true,
    evidenceLocation: "release evidence run root",
  },
];

const CHECK_BY_ID = new Map(RELEASE_CHECKS.map((check) => [check.id, check]));

const IMPACT_CHECK_IDS: Readonly<Record<ReleaseImpactKind, readonly string[]>> =
  {
    ui: ["ui:portal-smoke"],
    "server-business": ["server:deterministic-behavior"],
    "reflection-journal": [
      "reflection:lineage",
      "reflection:idempotency",
      "reflection:cas-epoch-freshness",
    ],
    "prompt-budget": [
      "prompt-budget:synthetic-samples",
      "prompt-budget:effective-config-diff",
    ],
    "owner-permission": ["permission:isolation", "permission:race"],
    "purge-coverage": ["purge:full-restore-drill"],
    "provider-migration": [
      "provider:effective-config-diff",
      "provider:affected-role-calls",
      "provider:privacy-checks",
    ],
  };

const CHECK_RATIONALE: Readonly<Record<string, string>> = {
  "ui:portal-smoke":
    "A UI change needs the fixed baseline plus this relevant portal behavior smoke test; no evidence producer is started.",
  "server:deterministic-behavior":
    "An ordinary server fix needs the fixed baseline plus the deterministic behavior regression for the affected path; no evidence producer is started.",
  "reflection:lineage":
    "Verifies lineage for the affected Reflection/Journal derivation.",
  "reflection:idempotency":
    "Verifies idempotency for the affected Reflection/Journal derivation.",
  "reflection:cas-epoch-freshness":
    "Verifies current-pointer CAS, Data Epoch and source freshness for the affected derivation.",
  "prompt-budget:synthetic-samples":
    "Small fixed synthetic samples checking completion, format, safety boundaries and this change's goal; deterministic, with no new hard semantic threshold and no model call.",
  "prompt-budget:effective-config-diff":
    "Reads the deployed effective Prompt/budget configuration and compares it with the acceptance baseline through the shared #278 gate.",
  "permission:isolation":
    "Verifies owner/permission isolation for the affected access path.",
  "permission:race":
    "Verifies the admission race around the affected permission or deletion path.",
  "purge:full-restore-drill":
    "A purge coverage change needs the full relevant Purge/restore drill, not only the baseline inventory check.",
  "provider:effective-config-diff":
    "Reads the deployed effective Provider configuration and compares it with the acceptance baseline through the shared #278 gate.",
  "provider:affected-role-calls":
    "Runs the affected G1 role calls for the Provider/model migration.",
  "provider:privacy-checks":
    "Runs the necessary privacy checks for the Provider/model migration.",
  [FULL_ACCEPTANCE_ID]:
    "New capability enablement, a major overall contract change or an External MVP release is the only trigger for the full 12-item capability acceptance.",
};

/** Path hints only add targeted checks; they never trigger full acceptance. */
const PATH_IMPACT_HINTS: readonly (readonly [RegExp, ReleaseImpactKind])[] = [
  [/apps\/web\/(app|src\/components)\/.*\.(tsx|css|scss)$/i, "ui"],
  [/packages\/data\/migrations(-purge-marker)?\//i, "purge-coverage"],
  [/purge/i, "purge-coverage"],
  [/opencode|deepseek|provider|packages\/ai\/src\//i, "provider-migration"],
  [/prompt|budget|token/i, "prompt-budget"],
  [/reflection|journal/i, "reflection-journal"],
  [/internal-access|evidence-step-up|permission|owner-/i, "owner-permission"],
  [
    /apps\/web\/src\/(server|runtime|startup)|packages\/application\/src\//i,
    "server-business",
  ],
];

export type ReleaseValidationImpact = Readonly<{
  declared: readonly ReleaseImpactKind[];
  hinted: readonly ReleaseImpactKind[];
  effective: readonly ReleaseImpactKind[];
  located: boolean;
}>;

export type ReleaseValidationArtifact = Readonly<{
  checkId: string;
  contentSha256: string;
  result: "passed" | "failed";
  evidencePath?: string;
}>;

export type ReleaseValidationInput = Readonly<{
  checkId: string;
  contentSha256: string;
}>;

export type ReleaseValidationRequest = Readonly<{
  version: string;
  change: Readonly<{
    summary: string;
    declaredImpacts: readonly ReleaseImpactKind[];
    changedPaths: readonly string[];
  }>;
  capability?: Readonly<{
    newCapabilityEnabled?: boolean;
    majorContractChange?: boolean;
    externalMvpRelease?: boolean;
  }>;
  previousArtifacts?: readonly ReleaseValidationArtifact[];
  currentInputs?: readonly ReleaseValidationInput[];
  effectiveConfig?: Readonly<{ baseline: unknown; candidate: unknown }>;
}>;

export type ReleaseValidationDisposition =
  | "run"
  | "reused"
  | "rerun-retained-failure";

export type SelectedReleaseCheck = Readonly<{
  check: ReleaseCheck;
  rationale: string;
  source: "fixed-baseline" | "declared-impact" | "path-hint" | "capability-trigger";
  disposition: ReleaseValidationDisposition;
  contentIdentity?: string;
  evidencePath?: string;
}>;

export type ReleaseValidationPlan = Readonly<{
  version: string;
  changeSummary: string;
  impact: ReleaseValidationImpact;
  effectiveConfig?: Readonly<{
    configDigest: string;
    compatible: boolean;
    blockingOperations: readonly string[];
  }>;
  fullAcceptance: Readonly<{
    required: boolean;
    trigger: CapabilityAcceptanceTrigger | null;
  }>;
  requiresImpactLocation: boolean;
  fixedBaseline: readonly SelectedReleaseCheck[];
  targeted: readonly SelectedReleaseCheck[];
  reused: readonly SelectedReleaseCheck[];
  skipped: readonly Readonly<{ check: ReleaseCheck; reason: string }>[];
  producerInvocations: readonly string[];
}>;

function isImpactKind(value: unknown): value is ReleaseImpactKind {
  return (
    typeof value === "string" &&
    (RELEASE_IMPACT_KINDS as readonly string[]).includes(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Classify the behavior impact from the declaration plus path hints. The
 * declaration is authoritative for what the operator says changed; hints only
 * add checks so a boundary change cannot be missed by a narrow declaration.
 */
export function classifyReleaseImpact(
  declared: readonly ReleaseImpactKind[],
  changedPaths: readonly string[],
): ReleaseValidationImpact {
  const declaredUnique = [...new Set(declared)];
  const hintedUnique: ReleaseImpactKind[] = [];
  for (const path of changedPaths) {
    for (const [pattern, impact] of PATH_IMPACT_HINTS) {
      if (pattern.test(path) && !hintedUnique.includes(impact)) {
        hintedUnique.push(impact);
      }
    }
  }
  const effective = [...declaredUnique];
  for (const impact of hintedUnique) {
    if (!effective.includes(impact)) effective.push(impact);
  }
  return {
    declared: declaredUnique,
    hinted: hintedUnique,
    effective,
    located: effective.length > 0,
  };
}

function capabilityTrigger(
  capability: ReleaseValidationRequest["capability"],
): CapabilityAcceptanceTrigger | null {
  if (capability?.externalMvpRelease) return "external-mvp-release";
  if (capability?.majorContractChange) return "major-contract-change";
  if (capability?.newCapabilityEnabled) return "new-capability-enabled";
  return null;
}

function analyzeEffectiveConfig(
  effectiveConfig: NonNullable<ReleaseValidationRequest["effectiveConfig"]>,
): NonNullable<ReleaseValidationPlan["effectiveConfig"]> {
  const baseline = parseEffectiveConfigurationSnapshot(effectiveConfig.baseline);
  const candidate = parseEffectiveConfigurationSnapshot(effectiveConfig.candidate);
  const comparison = compareEffectiveRuntimeConfiguration({ baseline, candidate });
  return {
    configDigest: comparison.candidate.configDigest,
    compatible: comparison.compatible,
    blockingOperations: comparison.blocking.map((blocker) => blocker.operation),
  };
}

/**
 * Build the daily release validation plan. The fixed baseline is always
 * present, targeted checks follow the classified impact, and the full producer
 * is selected only by a capability trigger. Unknown impact is located first.
 */
export function planDailyReleaseValidation(
  request: ReleaseValidationRequest,
): ReleaseValidationPlan {
  const impact = classifyReleaseImpact(
    request.change.declaredImpacts,
    request.change.changedPaths,
  );
  const trigger = capabilityTrigger(request.capability);
  const requiresImpactLocation = !impact.located && trigger === null;

  const previousByCheck = new Map(
    (request.previousArtifacts ?? []).map((artifact) => [
      artifact.checkId,
      artifact,
    ]),
  );
  const inputByCheck = new Map(
    (request.currentInputs ?? []).map((input) => [input.checkId, input]),
  );

  function select(
    check: ReleaseCheck,
    source: SelectedReleaseCheck["source"],
    rationale: string,
  ): SelectedReleaseCheck {
    const previous = previousByCheck.get(check.id);
    const input = inputByCheck.get(check.id);
    // A failed artifact can never be reused: its evidence is retained and the
    // affected check reruns, without resampling to replace the failure.
    const disposition: ReleaseValidationDisposition =
      previous?.result === "failed"
        ? "rerun-retained-failure"
        : previous?.result === "passed" &&
            input !== undefined &&
            previous.contentSha256 === input.contentSha256
          ? "reused"
          : "run";
    return {
      check,
      rationale,
      source,
      disposition,
      ...(input ? { contentIdentity: input.contentSha256 } : {}),
      ...(previous?.evidencePath ? { evidencePath: previous.evidencePath } : {}),
    };
  }

  const fixedBaseline: SelectedReleaseCheck[] = [];
  const reused: SelectedReleaseCheck[] = [];
  for (const id of FIXED_PR_CI_BASELINE) {
    const check = CHECK_BY_ID.get(id);
    if (!check) throw new Error(`Unknown baseline check ${id}`);
    const entry = select(
      check,
      "fixed-baseline",
      "The fixed PR CI baseline always runs; an impact declaration can never drop it.",
    );
    if (entry.disposition === "reused") reused.push(entry);
    else fixedBaseline.push(entry);
  }

  const targeted: SelectedReleaseCheck[] = [];
  const effectiveConfig = request.effectiveConfig
    ? analyzeEffectiveConfig(request.effectiveConfig)
    : undefined;
  const configDigest = effectiveConfig?.configDigest;

  const selectedIds = new Set<string>();
  for (const entry of fixedBaseline) selectedIds.add(entry.check.id);
  for (const entry of reused) selectedIds.add(entry.check.id);

  for (const impactKind of impact.effective) {
    const source = impact.declared.includes(impactKind)
      ? "declared-impact"
      : "path-hint";
    for (const id of IMPACT_CHECK_IDS[impactKind]) {
      if (selectedIds.has(id)) continue;
      const check = CHECK_BY_ID.get(id);
      if (!check) throw new Error(`Unknown targeted check ${id}`);
      const entry = select(
        check,
        source,
        CHECK_RATIONALE[id] ??
          `Relevant to the ${impactKind} behavior impact.`,
      );
      const withIdentity: SelectedReleaseCheck = configDigest &&
        (id === "prompt-budget:effective-config-diff" ||
          id === "provider:effective-config-diff")
        ? { ...entry, contentIdentity: configDigest }
        : entry;
      selectedIds.add(id);
      if (withIdentity.disposition === "reused") reused.push(withIdentity);
      else targeted.push(withIdentity);
    }
  }

  if (trigger) {
    const check = CHECK_BY_ID.get(FULL_ACCEPTANCE_ID);
    if (!check) throw new Error(`Unknown check ${FULL_ACCEPTANCE_ID}`);
    const entry = select(
      check,
      "capability-trigger",
      CHECK_RATIONALE[FULL_ACCEPTANCE_ID] ?? "Capability acceptance trigger.",
    );
    selectedIds.add(FULL_ACCEPTANCE_ID);
    if (entry.disposition === "reused") reused.push(entry);
    else targeted.push(entry);
  }

  const skipped = RELEASE_CHECKS.filter(
    (check) => !selectedIds.has(check.id),
  ).map((check) => ({
    check,
    reason: requiresImpactLocation
      ? "Impact is not located yet; this check is added only after the behavior impact is declared."
      : "No declared or hinted behavior impact selects this check.",
  }));

  return {
    version: DAILY_RELEASE_VALIDATION_PLAN_VERSION,
    changeSummary: request.change.summary,
    impact,
    ...(effectiveConfig ? { effectiveConfig } : {}),
    fullAcceptance: { required: trigger !== null, trigger },
    requiresImpactLocation,
    fixedBaseline,
    targeted,
    reused,
    skipped,
    producerInvocations: trigger ? [FULL_PRODUCER_COMMAND] : [],
  };
}

/**
 * One compact summary. Detail and evidence stay in the written report and in
 * the referenced locations so the agent does not re-parse the same bytes.
 */
export function formatDailyReleaseValidationSummary(
  plan: ReleaseValidationPlan,
): string {
  const lines = [
    `daily release validation ${plan.version}`,
    `change=${plan.changeSummary}`,
    `impact=${
      plan.impact.effective.length > 0
        ? plan.impact.effective.join(",")
        : "unknown"
    } declared=${plan.impact.declared.join(",") || "none"} hinted=${
      plan.impact.hinted.join(",") || "none"
    }`,
    `requires_impact_location=${plan.requiresImpactLocation}`,
    `full_acceptance=${
      plan.fullAcceptance.trigger ?? "not-required"
    }`,
    `producer_invocations=${
      plan.producerInvocations.length > 0
        ? plan.producerInvocations.join(",")
        : "none"
    }`,
  ];
  if (plan.effectiveConfig) {
    lines.push(
      `effective_config_digest=${plan.effectiveConfig.configDigest} compatible=${plan.effectiveConfig.compatible} blocking=${
        plan.effectiveConfig.blockingOperations.join(",") || "none"
      }`,
    );
  }
  lines.push(
    `fixed_baseline=${plan.fixedBaseline.map((entry) => entry.check.id).join(",") || "none"}`,
    `targeted=${plan.targeted.map((entry) => entry.check.id).join(",") || "none"}`,
    `reused=${plan.reused.map((entry) => entry.check.id).join(",") || "none"}`,
    `skipped=${plan.skipped.map((entry) => entry.check.id).join(",") || "none"}`,
  );
  for (const entry of [...plan.fixedBaseline, ...plan.targeted, ...plan.reused]) {
    lines.push(
      `check ${entry.check.id} disposition=${entry.disposition} content_identity=${
        entry.contentIdentity ?? "unrecorded"
      } evidence=${entry.evidencePath ?? entry.check.evidenceLocation ?? "-"}`,
    );
  }
  return lines.join("\n");
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the request JSON at the trust boundary. An unknown version, impact,
 * malformed artifact or malformed snapshot input is refused rather than
 * silently treated as a safe default.
 */
export function parseDailyReleaseValidationRequest(
  value: unknown,
): ReleaseValidationRequest {
  const raw = assertObject(value, "Daily release validation request");
  if (raw.version !== DAILY_RELEASE_VALIDATION_REQUEST_VERSION) {
    throw new Error(
      `Daily release validation request version must be ${DAILY_RELEASE_VALIDATION_REQUEST_VERSION}.`,
    );
  }
  const change = assertObject(raw.change, "Daily release validation change");
  if (typeof change.summary !== "string" || change.summary.length === 0) {
    throw new Error("Daily release validation change requires a summary.");
  }
  if (!Array.isArray(change.declaredImpacts)) {
    throw new Error("Daily release validation change requires declaredImpacts.");
  }
  const declaredImpacts = change.declaredImpacts.map((entry, index) => {
    if (!isImpactKind(entry)) {
      throw new Error(
        `Daily release validation declared impact ${index} is not a known behavior impact.`,
      );
    }
    return entry;
  });
  if (!Array.isArray(change.changedPaths)) {
    throw new Error("Daily release validation change requires changedPaths.");
  }
  const changedPaths = change.changedPaths.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`Daily release validation changed path ${index} is not a string.`);
    }
    return entry;
  });

  let capability: ReleaseValidationRequest["capability"];
  if (raw.capability !== undefined) {
    const parsed = assertObject(raw.capability, "Daily release validation capability");
    capability = {
      ...(typeof parsed.newCapabilityEnabled === "boolean"
        ? { newCapabilityEnabled: parsed.newCapabilityEnabled }
        : {}),
      ...(typeof parsed.majorContractChange === "boolean"
        ? { majorContractChange: parsed.majorContractChange }
        : {}),
      ...(typeof parsed.externalMvpRelease === "boolean"
        ? { externalMvpRelease: parsed.externalMvpRelease }
        : {}),
    };
  }

  function parseArtifacts(
    value: unknown,
  ): readonly ReleaseValidationArtifact[] {
    if (!Array.isArray(value)) {
      throw new Error("Daily release validation artifacts must be an array.");
    }
    return value.map((entry, index) => {
      const artifact = assertObject(entry, `Artifact ${index}`);
      if (typeof artifact.checkId !== "string" || artifact.checkId.length === 0) {
        throw new Error(`Artifact ${index} requires a checkId.`);
      }
      if (!isSha256(artifact.contentSha256)) {
        throw new Error(`Artifact ${index} requires a sha256 content identity.`);
      }
      if (artifact.result !== "passed" && artifact.result !== "failed") {
        throw new Error(`Artifact ${index} result must be passed or failed.`);
      }
      return {
        checkId: artifact.checkId,
        contentSha256: artifact.contentSha256,
        result: artifact.result,
        ...(typeof artifact.evidencePath === "string"
          ? { evidencePath: artifact.evidencePath }
          : {}),
      };
    });
  }

  function parseInputs(value: unknown): readonly ReleaseValidationInput[] {
    if (!Array.isArray(value)) {
      throw new Error("Daily release validation inputs must be an array.");
    }
    return value.map((entry, index) => {
      const input = assertObject(entry, `Input ${index}`);
      if (typeof input.checkId !== "string" || input.checkId.length === 0) {
        throw new Error(`Input ${index} requires a checkId.`);
      }
      if (!isSha256(input.contentSha256)) {
        throw new Error(`Input ${index} requires a sha256 content identity.`);
      }
      return { checkId: input.checkId, contentSha256: input.contentSha256 };
    });
  }

  let effectiveConfig: ReleaseValidationRequest["effectiveConfig"];
  if (raw.effectiveConfig !== undefined) {
    const parsed = assertObject(
      raw.effectiveConfig,
      "Daily release validation effectiveConfig",
    );
    effectiveConfig = { baseline: parsed.baseline, candidate: parsed.candidate };
  }

  return {
    version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
    change: { summary: change.summary, declaredImpacts, changedPaths },
    ...(capability ? { capability } : {}),
    ...(raw.previousArtifacts !== undefined
      ? { previousArtifacts: parseArtifacts(raw.previousArtifacts) }
      : {}),
    ...(raw.currentInputs !== undefined
      ? { currentInputs: parseInputs(raw.currentInputs) }
      : {}),
    ...(effectiveConfig ? { effectiveConfig } : {}),
  };
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args.set(token, "true");
      continue;
    }
    args.set(token, value);
    index += 1;
  }
  return args;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/**
 * Independent entry point. It plans and records the run from local JSON
 * request/artifact files; it never contacts a deployment or a Provider itself.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: { stdout: (line: string) => void } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
  },
): Promise<number> {
  const args = parseArgs(argv);
  const requestPath = args.get("--request");
  if (!requestPath) {
    throw new Error(
      "Usage: daily-release-validation.ts --request <request.json> [--report <plan.json>]",
    );
  }
  const request = parseDailyReleaseValidationRequest(await readJson(requestPath));
  const plan = planDailyReleaseValidation(request);
  io.stdout(formatDailyReleaseValidationSummary(plan));
  const reportPath = args.get("--report");
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    io.stdout(`plan written to ${reportPath}`);
  }
  return 0;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
