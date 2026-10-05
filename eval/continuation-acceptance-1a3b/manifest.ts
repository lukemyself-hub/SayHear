import {
  BIO_SAMPLE_QUOTAS,
  CONTINUATION_FORCED_COVERAGE,
  CONTINUATION_SAMPLE_QUOTAS,
  F3_CATALOG_VERSION,
  F3_HOLDOUT_CATALOG_VERSION,
  F3_MANIFEST_VERSION,
  LANGUAGE_VARIANTS,
  MODEL_ROLES,
  VALIDATOR_ARTIFACT_KINDS,
  VALIDATOR_ERROR_CLASSES,
  isRecord,
  sha256,
  type BaselineReference,
  type BioNaturalnessFixture,
  type ContinuationFixture,
  type Fixture,
  type FixtureCatalog,
  type F3Pins,
  type LanguageVariant,
  type ValidatorFixture,
} from "./protocol";
import {
  selectContinuationSample,
  selectFixedLanguageSample,
} from "./sampling";

export type FixtureVerification = Readonly<{
  counts: Readonly<Record<"bio_naturalness" | "continuation" | "validator", number>>;
  passed: boolean;
  validatorByLanguage: Readonly<
    Record<LanguageVariant, Readonly<Record<"bio" | "reflection", number>>>
  >;
  mismatches: readonly string[];
}>;

function emptyValidatorCounts(): Record<
  LanguageVariant,
  { bio: number; reflection: number }
> {
  return {
    code_switch: { bio: 0, reflection: 0 },
    en: { bio: 0, reflection: 0 },
    zh: { bio: 0, reflection: 0 },
  };
}

function fixtureInputRefs(
  catalog: FixtureCatalog,
  mismatches: string[],
): void {
  const sharedInputs = catalog.sharedInputs;
  if (!isRecord(sharedInputs)) {
    mismatches.push("sharedInputs must be an object");
    return;
  }
  for (const [id, input] of Object.entries(sharedInputs)) {
    if (!isRecord(input)) {
      mismatches.push(`shared input ${id} must be an object`);
      continue;
    }
    for (const field of ["events", "memory", "retrieval", "portrait"] as const) {
      if (!Array.isArray(input[field])) {
        mismatches.push(`shared input ${id} is missing ${field}`);
      }
    }
    if (!isRecord(input.config)) {
      mismatches.push(`shared input ${id} is missing config`);
    }
    const events = Array.isArray(input.events) ? input.events : [];
    const memory = Array.isArray(input.memory) ? input.memory : [];
    const retrieval = Array.isArray(input.retrieval) ? input.retrieval : [];
    const portrait = Array.isArray(input.portrait) ? input.portrait : [];
    const eventIds = new Set(
      events.flatMap((event) =>
        isRecord(event) && typeof event.id === "string" ? [event.id] : [],
      ),
    );
    const memoryIds = new Set(
      memory.flatMap((memory) =>
        isRecord(memory) && typeof memory.id === "string" ? [memory.id] : [],
      ),
    );
    for (const memoryEntry of memory) {
      if (!isRecord(memoryEntry) || !Array.isArray(memoryEntry.evidenceIds)) continue;
      for (const evidenceId of memoryEntry.evidenceIds) {
        if (typeof evidenceId !== "string" || !eventIds.has(evidenceId)) {
          mismatches.push(`shared input ${id} has memory evidence outside events`);
        }
      }
    }
    for (const retrievalEntry of retrieval) {
      if (!isRecord(retrievalEntry) || typeof retrievalEntry.memoryId !== "string") continue;
      if (!memoryIds.has(retrievalEntry.memoryId)) {
        mismatches.push(`shared input ${id} has retrieval outside memory`);
      }
    }
    for (const portraitEntry of portrait) {
      if (!isRecord(portraitEntry) || typeof portraitEntry.claimId !== "string") continue;
      if (!memoryIds.has(portraitEntry.claimId)) {
        mismatches.push(`shared input ${id} has portrait outside memory`);
      }
    }
  }
}

function noProductionSource(value: unknown, path: string, mismatches: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => noProductionSource(entry, `${path}[${index}]`, mismatches));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if (
      [
        "database",
        "databaseurl",
        "connectionstring",
        "connectionurl",
        "privatesource",
        "productionsource",
        "productiondata",
        "providercredential",
        "credential",
        "apikey",
        "accesstoken",
        "userid",
      ].includes(normalizedKey)
    ) {
      mismatches.push(`${path}.${key} is not allowed in a synthetic fixture`);
    }
    noProductionSource(entry, `${path}.${key}`, mismatches);
  }
}

function verifyTokenList(
  value: unknown,
  label: string,
  mismatches: string[],
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((token) => typeof token !== "string" || token.trim().length === 0)
  ) {
    mismatches.push(`${label} must contain at least one non-empty token`);
  }
}

export function verifySyntheticSourceBoundary(
  value: unknown,
  label: string,
): readonly string[] {
  const mismatches: string[] = [];
  noProductionSource(value, label, mismatches);
  return mismatches;
}

function verifyContinuationFixture(
  fixture: ContinuationFixture,
  catalog: FixtureCatalog,
  mismatches: string[],
): void {
  if (!isRecord(catalog.sharedInputs) || !catalog.sharedInputs[fixture.inputRef]) {
    mismatches.push(`${fixture.id} references missing shared input ${fixture.inputRef}`);
  }
  if (!Array.isArray(fixture.coverageTags)) {
    mismatches.push(`${fixture.id} needs Continuation coverage tags`);
  }
  if (
    !fixture.hardGate ||
    (fixture.hardGate.maxQuestions !== 0 && fixture.hardGate.maxQuestions !== 1)
  ) {
    mismatches.push(`${fixture.id} must pin a zero-or-one-question hard gate`);
  }
  verifyTokenList(fixture.hardGate?.requiredTokens, `${fixture.id} required-token expectations`, mismatches);
  verifyTokenList(fixture.hardGate?.forbiddenTokens, `${fixture.id} forbidden-token expectations`, mismatches);
  if (!Array.isArray(fixture.turns) || fixture.turns.length === 0) {
    mismatches.push(`${fixture.id} needs at least one user turn`);
  }
}

function verifyBioFixture(
  fixture: BioNaturalnessFixture,
  catalog: FixtureCatalog,
  mismatches: string[],
): void {
  if (!isRecord(catalog.sharedInputs) || !catalog.sharedInputs[fixture.inputRef]) {
    mismatches.push(`${fixture.id} references missing shared input ${fixture.inputRef}`);
  }
  if (fixture.prompt.trim().length === 0 || fixture.turns.length === 0) {
    mismatches.push(`${fixture.id} needs a prompt and at least one turn`);
  }
}

function verifyValidatorFixture(
  fixture: ValidatorFixture,
  catalog: FixtureCatalog,
  mismatches: string[],
): void {
  const sharedInput = isRecord(catalog.sharedInputs)
    ? catalog.sharedInputs[fixture.inputRef]
    : undefined;
  if (!sharedInput) {
    mismatches.push(`${fixture.id} references missing shared input ${fixture.inputRef}`);
  }
  if (!VALIDATOR_ERROR_CLASSES.includes(fixture.validatorErrorClass)) {
    mismatches.push(`${fixture.id} has an unknown validator error class`);
  }
  if (!VALIDATOR_ARTIFACT_KINDS.includes(fixture.artifactKind)) {
    mismatches.push(`${fixture.id} has an unknown validator artifact kind`);
  }
  if (fixture.draftText.trim().length === 0 || fixture.sourceClaimIds.length === 0) {
    mismatches.push(`${fixture.id} needs a draft and source claim IDs`);
  }
  if (sharedInput) {
    const knownMemoryIds = new Set(sharedInput.memory.map((memory) => memory.id));
    for (const sourceClaimId of fixture.sourceClaimIds) {
      if (!knownMemoryIds.has(sourceClaimId)) {
        mismatches.push(`${fixture.id} references a source claim outside frozen Memory`);
      }
    }
  }
}

/** Verify the complete synthetic catalog before any provider output is paired. */
export function verifyFixtureCatalog(catalog: FixtureCatalog): FixtureVerification {
  const mismatches: string[] = [];
  if (
    catalog.version !== F3_CATALOG_VERSION &&
    catalog.version !== F3_HOLDOUT_CATALOG_VERSION
  ) {
    mismatches.push(
      `catalog version must be ${F3_CATALOG_VERSION} or ${F3_HOLDOUT_CATALOG_VERSION}`,
    );
  }
  if (catalog.synthetic !== true) mismatches.push("catalog must be marked synthetic");
  if (!catalog.syntheticNotice?.toLowerCase().includes("synthetic")) {
    mismatches.push("catalog must explain that all fixtures are synthetic");
  }
  if (!Array.isArray(catalog.scenarios)) {
    return {
      counts: { bio_naturalness: 0, continuation: 0, validator: 0 },
      mismatches: [...mismatches, "scenarios must be an array"],
      passed: false,
      validatorByLanguage: emptyValidatorCounts(),
    };
  }

  noProductionSource(catalog, "catalog", mismatches);
  fixtureInputRefs(catalog, mismatches);
  const ids = new Set<string>();
  const counts = { bio_naturalness: 0, continuation: 0, validator: 0 };
  const validatorByLanguage = emptyValidatorCounts();
  const continuationCandidates: {
    category: string;
    coverageTags: readonly string[];
    id: string;
    languageVariant: LanguageVariant;
  }[] = [];

  for (const fixture of catalog.scenarios) {
    if (ids.has(fixture.id)) mismatches.push(`duplicate fixture ID ${fixture.id}`);
    ids.add(fixture.id);
    const validLanguageVariant = LANGUAGE_VARIANTS.includes(fixture.languageVariant);
    if (!validLanguageVariant) {
      mismatches.push(`${fixture.id} has an unsupported language variant`);
    }
    if (!fixture.inputRef || !fixture.locale || !fixture.timezone) {
      mismatches.push(`${fixture.id} is missing input identity fields`);
    }
    if (fixture.group === "continuation") {
      counts.continuation += 1;
      verifyContinuationFixture(fixture, catalog, mismatches);
      continuationCandidates.push(fixture);
    } else if (fixture.group === "bio_naturalness") {
      counts.bio_naturalness += 1;
      verifyBioFixture(fixture, catalog, mismatches);
    } else if (fixture.group === "validator") {
      counts.validator += 1;
      if (validLanguageVariant) {
        const languageVariant = fixture.languageVariant as LanguageVariant;
        const artifactKind: "bio" | "reflection" =
          fixture.artifactKind === "bio" ? "bio" : "reflection";
        validatorByLanguage[languageVariant][artifactKind] += 1;
      }
      verifyValidatorFixture(fixture, catalog, mismatches);
    } else {
      mismatches.push(`${fixture.id} has an unknown fixture group`);
    }
  }

  // A holdout that carries its own precision drafts must carry six of them,
  // each citing a claim from its own shared inputs. The incumbent carries none
  // and relies on the capture script's built-in set, whose claim IDs match its
  // own catalog; this check never fires for it.
  const precisionDrafts = catalog.precisionDrafts;
  if (precisionDrafts) {
    if (precisionDrafts.length !== 6) {
      mismatches.push("catalog precisionDrafts must contain 6 clean drafts");
    }
    for (const draft of precisionDrafts) {
      if (ids.has(draft.id)) {
        mismatches.push(`duplicate fixture ID ${draft.id}`);
      }
      ids.add(draft.id);
      const sharedInput = catalog.sharedInputs[draft.inputRef];
      if (!sharedInput) {
        mismatches.push(`${draft.id} cites unknown shared input ${draft.inputRef}`);
        continue;
      }
      if (!sharedInput.memory.some((candidate) => candidate.id === draft.claimId)) {
        mismatches.push(`${draft.id} cites unknown claim ${draft.claimId}`);
      }
      if (!draft.draftText.trim()) {
        mismatches.push(`${draft.id} has an empty draft text`);
      }
    }
  }

  // A catalog's requirements are scoped to the groups it actually carries, so
  // a validator-only acceptance holdout can be verified without inventing a
  // Continuation and Bio pool it will never run. No check is relaxed for a
  // catalog that does carry a group: the incumbent still satisfies all three
  // pools and every quota below.
  const hasContinuation = counts.continuation > 0;
  const hasBio = counts.bio_naturalness > 0;
  const hasValidator = counts.validator > 0;
  if (hasContinuation && counts.continuation !== 18) {
    mismatches.push("Continuation pool must contain 18 fixtures");
  }
  if (hasBio && counts.bio_naturalness !== 15) {
    mismatches.push("Bio naturalness set must contain 15 fixtures");
  }
  // ADR-0143: the validator pool is whatever the catalog carries, per language
  // and per declared severity. The fixed 18 was twelve Bio plus six Reflection
  // cases, and Bio left G1 scope because bio.write is a deferred role with no
  // consumer, so a hardcoded count and hardcoded per-kind quotas would now
  // refuse a catalog that is correctly scoped.
  if (hasValidator && counts.validator === 0) {
    mismatches.push("validator set must not be empty");
  }
  for (const variant of LANGUAGE_VARIANTS) {
    if (hasBio) {
      const bioCount = catalog.scenarios.filter(
        (fixture) => fixture.group === "bio_naturalness" && fixture.languageVariant === variant,
      ).length;
      if (bioCount !== BIO_SAMPLE_QUOTAS[variant]) {
        mismatches.push(`Bio naturalness ${variant} quota must be ${BIO_SAMPLE_QUOTAS[variant]}`);
      }
    }
    // Every language that carries validator cases must carry at least one, and
    // the error classes a catalog declares must each be represented. Kinds the
    // catalog does not carry are not demanded: a release that does not ship a
    // kind cannot be obliged to hold cases for it.
    if (
      catalog.scenarios.some(
        (fixture) => fixture.group === "validator",
      ) &&
      !catalog.scenarios.some(
        (fixture) =>
          fixture.group === "validator" && fixture.languageVariant === variant,
      )
    ) {
      mismatches.push(`validator ${variant} pool has no case`);
    }
  }
  // The error classes a catalog actually seeds must each appear, so a pool
  // cannot quietly shrink to one easy class. Classes no fixture declares are
  // not required, for the same reason kinds are not.
  for (const errorClass of new Set(
    catalog.scenarios
      .filter((fixture) => fixture.group === "validator")
      .map((fixture) => fixture.validatorErrorClass),
  )) {
    const count = catalog.scenarios.filter(
      (fixture) =>
        fixture.group === "validator" && fixture.validatorErrorClass === errorClass,
    ).length;
    if (count < 2) {
      mismatches.push(
        `validator pool has only ${count} case(s) for ${errorClass}; at least 2 are required`,
      );
    }
  }
  for (const tag of CONTINUATION_FORCED_COVERAGE) {
    if (
      hasContinuation &&
      !continuationCandidates.some((candidate) => candidate.coverageTags.includes(tag))
    ) {
      mismatches.push(`Continuation pool has no fixture for ${tag}`);
    }
  }

  let selectionPassed = false;
  if (hasContinuation) {
    try {
      const selection = selectContinuationSample({
        candidates: continuationCandidates,
        sampleSeed: 1960,
      });
      selectionPassed =
        JSON.stringify(selection.selectedCounts) ===
        JSON.stringify(CONTINUATION_SAMPLE_QUOTAS);
    } catch (error) {
      mismatches.push(`Continuation sample is not reproducible: ${String(error)}`);
    }
    if (!selectionPassed) mismatches.push("Continuation sample does not meet language quotas");
  }

  return {
    counts,
    mismatches,
    passed: mismatches.length === 0,
    validatorByLanguage,
  };
}

export type PinsVerification = Readonly<{
  mismatches: readonly string[];
  passed: boolean;
}>;

export type ManifestVerification = Readonly<{
  mismatches: readonly string[];
  passed: boolean;
}>;

function verifyRolePin(pin: unknown, expectedRole: string, mismatches: string[]): void {
  if (!isRecord(pin)) {
    mismatches.push(`${expectedRole} pin must be an object`);
    return;
  }
  for (const field of ["model", "snapshot", "promptVersion", "schemaVersion", "policyVersion"]) {
    if (typeof pin[field] !== "string" || pin[field].trim().length === 0) {
      mismatches.push(`${expectedRole} pin is missing ${field}`);
    }
  }
  if (!["deepseek", "openai", "opencode-go", "deterministic"].includes(String(pin.provider))) {
    mismatches.push(`${expectedRole} pin has an unsupported provider`);
  }
  if (!isRecord(pin.parameters)) {
    mismatches.push(`${expectedRole} pin parameters must be an object`);
  }
  if (pin.fallback !== "none") mismatches.push(`${expectedRole} must have no fallback`);
  if (
    pin.maxTechnicalRetries !== 0 &&
    pin.maxTechnicalRetries !== 1
  ) {
    mismatches.push(`${expectedRole} must pin retry count 0 or 1`);
  }
  if (expectedRole === "proactive.followup" && pin.maxTechnicalRetries !== 0) {
    mismatches.push("proactive.followup must have zero retries");
  }
}

/** Verify all seven independently pinned roles and the no-preselected-winner shape. */
export function verifyPins(pins: F3Pins): PinsVerification {
  const mismatches: string[] = [];
  if (pins.version !== "1a3b-f3-pins:v3") mismatches.push("unsupported F3 pins version");
  if (pins.syntheticOnly !== true) mismatches.push("pins must be synthetic-only");
  if (!isRecord(pins.roles)) {
    mismatches.push("pins.roles must be an object");
  } else {
    const roleKeys = Object.keys(pins.roles).sort();
    if (JSON.stringify(roleKeys) !== JSON.stringify([...MODEL_ROLES].sort())) {
      mismatches.push("pins.roles must contain exactly the seven F3 roles");
    }
    for (const role of MODEL_ROLES) verifyRolePin(pins.roles[role], role, mismatches);
  }
  if (!isRecord(pins.shared)) mismatches.push("pins.shared must be an object");
  else {
    for (const key of [
      "events",
      "memory",
      "retrieval",
      "portrait",
      "persona",
      "locale",
      "safety",
      "conversation",
    ] as const) {
      if (typeof pins.shared[key] !== "string" || pins.shared[key]!.length === 0) {
        mismatches.push(`pins.shared is missing ${key}`);
      }
    }
  }
  if (!isRecord(pins.continuation) || !isRecord(pins.continuation.arms)) {
    mismatches.push("continuation arms are required");
  } else {
    const keys = pins.continuation.allowedDifferenceKeys;
    if (JSON.stringify(keys) !== JSON.stringify(["open_loop_bundle", "proactive_bundle"])) {
      mismatches.push("Continuation must declare only the two allowed bundle differences");
    }
    const incumbent = pins.continuation.arms.incumbent;
    const candidate = pins.continuation.arms.candidate;
    if (!isRecord(incumbent) || !isRecord(candidate)) {
      mismatches.push("Continuation incumbent and candidate arms are required");
    } else {
      if (incumbent.id === candidate.id) mismatches.push("Continuation arm IDs must differ");
      for (const arm of [incumbent, candidate]) {
        for (const key of ["openLoop", "proactive"] as const) {
          if (!isRecord(arm[key])) mismatches.push(`Continuation ${key} bundle is required`);
        }
      }
    }
  }
  if (!isRecord(pins.bio) || !Array.isArray(pins.bio.configurations)) {
    mismatches.push("at least two Bio configurations are required");
  } else {
    const ids = new Set<string>();
    if (pins.bio.configurations.length < 2) mismatches.push("Bio needs two complete configurations");
    for (const configuration of pins.bio.configurations) {
      if (ids.has(configuration.id)) mismatches.push(`duplicate Bio configuration ${configuration.id}`);
      ids.add(configuration.id);
      verifyRolePin(configuration.writer, "bio.write", mismatches);
      verifyRolePin(configuration.validator, "narrative.validate", mismatches);
    }
  }
  if (!isRecord(pins.validator)) mismatches.push("validator configuration is required");
  else verifyRolePin(pins.validator.configuration, "narrative.validate", mismatches);
  noProductionSource(pins, "pins", mismatches);
  return { mismatches, passed: mismatches.length === 0 };
}

export type BaselineVerification = Readonly<{
  comparisonAllowed: boolean;
  historicalFindingIssues: readonly number[];
  mismatches: readonly string[];
  passed: boolean;
}>;

export function verifyBaselineReference(
  baseline: BaselineReference,
): BaselineVerification {
  const mismatches: string[] = [];
  mismatches.push(...verifySyntheticSourceBoundary(baseline, "baseline"));
  if (baseline.version !== "1a3b-f3-baseline-reference:v1") {
    mismatches.push("unsupported baseline reference version");
  }
  if (baseline.synthetic !== true) mismatches.push("baseline reference must be synthetic metadata");
  if (baseline.historicalIncumbent.issue !== 166) {
    mismatches.push("baseline reference must point to Issue #166");
  }
  if (!/^[0-9a-f]{40}$/.test(baseline.historicalIncumbent.runCommit)) {
    mismatches.push("historical incumbent must record a full commit");
  }
  const historicalFindingIssues = [
    baseline.historicalIncumbent.issue,
    ...new Set(baseline.historicalFindings.map((finding) => finding.issue)),
  ];
  if (!historicalFindingIssues.includes(186)) {
    mismatches.push("baseline reference must include the confirmed Issue #186 findings");
  }
  for (const finding of baseline.historicalFindings) {
    if (finding.confirmed !== true || finding.issue !== 186 || finding.name.trim().length === 0) {
      mismatches.push("historical #186 findings must remain confirmed and named");
    }
  }
  const current = baseline.currentIncumbent;
  if (current.status === "clean") {
    if (
      !current.commit ||
      !/^[0-9a-f]{40}$/.test(current.commit) ||
      !current.manifestPath ||
      current.confirmedHardGateFailures !== 0
    ) {
      mismatches.push("a clean incumbent needs a commit, manifest, and zero confirmed hard failures");
    }
  } else if (current.status !== "requires-clean-rebaseline") {
    mismatches.push("unknown current incumbent status");
  }
  return {
    comparisonAllowed:
      mismatches.length === 0 &&
      current.status === "clean" &&
      current.confirmedHardGateFailures === 0,
    historicalFindingIssues,
    mismatches,
    passed: mismatches.length === 0,
  };
}

export type AcceptanceManifest = Readonly<{
  acceptance: Readonly<{
    /**
     * Which acceptance groups this release actually carries. A group the
     * catalog does not support is absent, so a release that does not ship Bio
     * has no Bio group rather than one that is present and unenforced.
     */
    evidenceGroups: Readonly<Partial<Record<string, string>>>;
    humanOwner: "Luke";
    required: readonly AcceptanceCriterionId[];
  }>;
  baseline: Readonly<{
    currentIncumbent: BaselineReference["currentIncumbent"];
    historicalFindingIssues: readonly number[];
    historicalIncumbent: BaselineReference["historicalIncumbent"];
  }>;
  catalog: Readonly<{ sha256: string; version: string }>;
  commands: readonly string[];
  comparisonAllowed: boolean;
  continuation: Readonly<{
    hardGateScope: "full_pool";
    poolCount: number;
    sample: ReturnType<typeof selectContinuationSample>;
  }>;
  createdAt: string;
  fixtureSeed: number;
  fingerprint: string;
  gitCommit: string;
  /** Null when the release carries no Bio pool, which is the G1-only shape. */
  bio: Readonly<{
    sampleIds: readonly string[];
    sampleQuotas: Readonly<Record<LanguageVariant, number>>;
    total: number;
  }> | null;
  pins: Readonly<{ sha256: string; version: string }>;
  pinnedConfiguration: F3Pins;
  sampleSeed: number;
  status: "blocked_requires_clean_incumbent" | "ready_for_evaluation";
  validator: Readonly<{
    byLanguage: FixtureVerification["validatorByLanguage"];
    total: number;
  }>;
  version: typeof F3_MANIFEST_VERSION;
}>;

/** Every acceptance criterion a release may require of the F3 manifest. */
export const ACCEPTANCE_CRITERION_IDS = Object.freeze([
  "AC-X01",
  "AC-X02",
  "AC-X03",
  "AC-X04",
  "AC-M01",
] as const);
export type AcceptanceCriterionId = (typeof ACCEPTANCE_CRITERION_IDS)[number];

/**
 * The criteria a release requires. A G1-only release does not ship bio.write,
 * so AC-X02 is not one it can satisfy; requiring it against a catalog with no
 * Bio pool is refused rather than recorded as a silent pass. The list is part
 * of the release identity, so two releases with different scope cannot share a
 * fingerprint.
 */
export type ManifestBuildInput = Readonly<{
  baseline: BaselineReference;
  catalog: FixtureCatalog;
  catalogPath?: string;
  commands: readonly string[];
  createdAt?: string;
  fixtureSeed: number;
  gitCommit: string;
  pins: F3Pins;
  pinsPath?: string;
  required: readonly AcceptanceCriterionId[];
  sampleSeed: number;
}>;

function withoutFingerprint(manifest: AcceptanceManifest): Omit<AcceptanceManifest, "fingerprint"> {
  const { fingerprint: _fingerprint, ...rest } = manifest;
  return rest;
}

function deterministicManifestPayload(
  manifest: Omit<AcceptanceManifest, "fingerprint">,
): unknown {
  return { ...manifest, createdAt: "volatile" };
}

/** Build a deterministic release manifest; blocked baselines remain explicit instead of waived. */
export function buildManifest(input: ManifestBuildInput): AcceptanceManifest {
  const catalogVerification = verifyFixtureCatalog(input.catalog);
  const pinsVerification = verifyPins(input.pins);
  const baselineVerification = verifyBaselineReference(input.baseline);
  const problems = [
    ...catalogVerification.mismatches,
    ...pinsVerification.mismatches,
    ...baselineVerification.mismatches,
  ];
  if (problems.length > 0) {
    throw new Error(`Cannot build F3 manifest:\n${problems.join("\n")}`);
  }
  if (!Number.isInteger(input.fixtureSeed) || !Number.isInteger(input.sampleSeed)) {
    throw new Error("fixtureSeed and sampleSeed must be integers.");
  }
  if (!/^[0-9a-f]{40}$/.test(input.gitCommit)) {
    throw new Error("gitCommit must be a full 40-character commit.");
  }
  if (input.commands.length === 0) throw new Error("At least one reproduction command is required.");

  const continuationCandidates = input.catalog.scenarios.filter(
    (fixture): fixture is ContinuationFixture => fixture.group === "continuation",
  );
  const bioCandidates = input.catalog.scenarios
    .filter((fixture): fixture is BioNaturalnessFixture => fixture.group === "bio_naturalness")
    .map((fixture) => ({
      category: fixture.category,
      coverageTags: [],
      id: fixture.id,
      languageVariant: fixture.languageVariant,
    }));

  // The release declares what it must satisfy, and the builder refuses any
  // criterion the catalog cannot produce. Previously the five-item list was
  // fixed and Bio sampling ran unconditionally, so a release that does not
  // ship Bio had to certify bio.write to build a manifest at all.
  const unknownRequired = input.required.filter(
    (criterion) => !ACCEPTANCE_CRITERION_IDS.includes(criterion),
  );
  if (unknownRequired.length > 0) {
    throw new Error(
      `Unknown required acceptance criteria: ${unknownRequired.join(", ")}.`,
    );
  }
  const duplicated = input.required.filter(
    (criterion, index) => input.required.indexOf(criterion) !== index,
  );
  if (duplicated.length > 0) {
    throw new Error(
      `Required acceptance criteria are duplicated: ${[...new Set(duplicated)].join(", ")}.`,
    );
  }
  if (input.required.length === 0) {
    throw new Error("A release must require at least one acceptance criterion.");
  }
  // Checked before any sampling, so a catalog that cannot support a criterion
  // is refused with a message about that criterion rather than a symptom from
  // the sampler that happens to run first.
  if (continuationCandidates.length === 0) {
    throw new Error(
      "AC-X01 and AC-X04 require a Continuation pool, which this catalog does not carry.",
    );
  }
  if (bioCandidates.length === 0 && input.required.includes("AC-X02")) {
    throw new Error(
      "AC-X02 requires a Bio naturalness pool, which this catalog does not carry. " +
        "A release that does not ship bio.write must not require it.",
    );
  }
  // AC-X04 is the one criterion a release cannot opt out of: its only data
  // source is a Continuation run, and the evidence producer demands a full
  // 18-fixture report. A release that dropped it would recreate the gate that
  // passes while checking nothing.
  if (!input.required.includes("AC-X04")) {
    throw new Error("AC-X04 is not optional: every release must require it.");
  }
  const continuation = selectContinuationSample({
    candidates: continuationCandidates,
    sampleSeed: input.sampleSeed,
  });
  // A Bio sample is recorded only when Bio is a gate. Presence of the fixtures
  // is not enough: a release that does not require AC-X02 gets no Bio sample
  // even from a catalog that has Bio cases, so a Bio comparison cannot be
  // built from it later.
  const bioSample =
    !input.required.includes("AC-X02")
      ? null
      : selectFixedLanguageSample({
          candidates: bioCandidates,
          quotas: BIO_SAMPLE_QUOTAS,
          sampleSeed: input.sampleSeed,
        });
  const evidenceGroups: Record<string, string> = {
    continuation: "AC-X01",
    deterministicHardGates: "AC-X04",
    modelRoles: "AC-M01",
    validator: "AC-X03",
  };
  if (bioSample) evidenceGroups["bioNaturalness"] = "AC-X02";
  const manifestWithoutHash = {
    acceptance: {
      evidenceGroups,
      humanOwner: "Luke" as const,
      required: [...input.required],
    },
    baseline: {
      currentIncumbent: input.baseline.currentIncumbent,
      historicalFindingIssues: baselineVerification.historicalFindingIssues,
      historicalIncumbent: input.baseline.historicalIncumbent,
    },
    bio: bioSample
      ? {
          sampleIds: bioSample.scenarioIds,
          sampleQuotas: BIO_SAMPLE_QUOTAS,
          total: input.catalog.scenarios.filter(
            (fixture) => fixture.group === "bio_naturalness",
          ).length,
        }
      : null,
    catalog: { sha256: sha256(input.catalog), version: input.catalog.version },
    commands: [...input.commands],
    comparisonAllowed: baselineVerification.comparisonAllowed,
    continuation: {
      hardGateScope: "full_pool" as const,
      poolCount: continuationCandidates.length,
      sample: continuation,
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
    fixtureSeed: input.fixtureSeed,
    gitCommit: input.gitCommit,
    pinnedConfiguration: input.pins,
    pins: { sha256: sha256(input.pins), version: input.pins.version },
    sampleSeed: input.sampleSeed,
    status: baselineVerification.comparisonAllowed
      ? ("ready_for_evaluation" as const)
      : ("blocked_requires_clean_incumbent" as const),
    validator: {
      byLanguage: catalogVerification.validatorByLanguage,
      total: input.catalog.scenarios.filter((fixture) => fixture.group === "validator").length,
    },
    version: F3_MANIFEST_VERSION,
  };
  return {
    ...manifestWithoutHash,
    fingerprint: sha256(deterministicManifestPayload(manifestWithoutHash)),
  };
}

export function verifyManifest(manifest: AcceptanceManifest): ManifestVerification {
  const expected = sha256(
    deterministicManifestPayload(withoutFingerprint(manifest)),
  );
  const mismatches: string[] = [];
  mismatches.push(...verifySyntheticSourceBoundary(manifest, "manifest"));
  if (manifest.version !== F3_MANIFEST_VERSION) mismatches.push("unsupported manifest version");
  if (manifest.fingerprint !== expected) mismatches.push("manifest fingerprint does not match its content");
  if (manifest.pinnedConfiguration.syntheticOnly !== true) mismatches.push("manifest pins are not synthetic-only");
  if (manifest.comparisonAllowed !== (manifest.status === "ready_for_evaluation")) {
    mismatches.push("manifest status and comparisonAllowed disagree");
  }
  return { mismatches, passed: mismatches.length === 0 };
}
