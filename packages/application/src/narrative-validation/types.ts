import type {
  GenerationCommandId,
  ModelRunAttemptId,
  NarrativeValidatorRequestId,
  NarrativeValidatorResultId,
  UserId,
} from "@sayhear/domain";

/**
 * 1A.3b A2 (issue #198). The shared `narrative.validate` role (ADR-0121)
 * independently re-decomposes a frozen Reflection or Bio draft into atomic
 * propositions and compares support, epistemic kinds and coverage against the
 * frozen source manifest (ADR-0124 dual decomposition). The validator never
 * owns a Reflection / Bio publish pointer: producers read the typed result
 * and keep owning their own commit fences. Dangerous-error calibration runs
 * through the F3 acceptance harness (ADR-0137).
 */

/** Frozen semantic verdict policy (per artifact kind, versioned). */
export const NARRATIVE_VALIDATION_POLICY_VERSION = "narrative-validation:v1";

/**
 * Frozen model-output schema (shared finding shape). This matches the
 * `narrative-findings:v1` pin of the F3 acceptance harness.
 */
export const NARRATIVE_FINDINGS_SCHEMA_VERSION = "narrative-findings:v1";

/**
 * One frozen Prompt per artifact kind (ADR-0121): the role, model routing and
 * calibration evidence are shared; prompt semantics never silently mix.
 */
export const NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO =
  "narrative-validate-bio:v1";
export const NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION =
  "narrative-validate-reflection:v1";

/**
 * Validation result content expires with the uncommitted draft it served
 * (ADR-0130): the read path refuses expired content immediately and a
 * bounded maintenance pass clears it to a content-free envelope.
 */
export const NARRATIVE_VALIDATION_CONTENT_EXPIRY_DAYS = 7;

/** Upper bound of findings persisted for one validation run. */
export const MAX_NARRATIVE_FINDINGS_PER_RESULT = 64;

export type NarrativeArtifactKind = "bio" | "reflection";

/**
 * The closed blocking-class vocabulary (SPEC 5.2 / 9.4, ADR-0124). All six
 * classes block Bio publishing; Reflection v1 records them as advisory until
 * a new policy version carries accepted per-class calibration evidence.
 */
export type NarrativeFindingCode =
  | "unsupported"
  | "contradiction"
  | "kind_upgrade"
  | "material_absence"
  | "manifest_mismatch"
  | "ambiguous";

export type NarrativeSeverity = "error" | "warning";

export type NarrativePropositionKind = "fact" | "impression" | "synthesis";

export type NarrativeEpistemicRendering = "confirmed" | "inferred";

/**
 * One source entry frozen by the producer. `sourceKind` distinguishes the
 * eligible-Claim manifest of a Bio draft from the EvidenceItem manifest of a
 * Reflection draft; `epistemicKind` is only set for memory-claim entries and
 * drives `kind_upgrade` detection.
 */
export type NarrativeSourceEntry = Readonly<{
  sourceKey: string;
  sourceKind: "memory_claim_version" | "evidence_item";
  text: string;
  epistemicKind: "objective_memory" | "ai_impression" | null;
}>;

/** The generator's declared propositions (writer manifest). */
export type NarrativeGeneratorProposition = Readonly<{
  propositionKey: string;
  normalizedProposition: string;
  propositionKind: NarrativePropositionKind;
  epistemicRendering: NarrativeEpistemicRendering;
  /** Only frozen source keys. */
  supportKeys: readonly string[];
}>;

export type NarrativeGeneratorStatement = Readonly<{
  statementKey: string;
  text: string;
  propositionStatements: readonly NarrativeGeneratorProposition[];
}>;

/**
 * One proposition the validator model recovered from the final text on its
 * own. The model never sees the generator manifest; the comparison below
 * stays in deterministic code.
 */
export type NarrativeIndependentProposition = Readonly<{
  propositionKey: string;
  text: string;
  propositionKind: NarrativePropositionKind;
  epistemicRendering: NarrativeEpistemicRendering;
  supportKeys: readonly string[];
  unsupported: boolean;
  contradicted: boolean;
  ambiguous: boolean;
}>;

/** Frozen model input: final text plus the source manifest only. */
export type NarrativeValidatorModelRequest = Readonly<{
  userId: UserId;
  artifactKind: NarrativeArtifactKind;
  draftRef: string;
  draftLocale: string | null;
  draftText: string;
  sourceEntries: readonly NarrativeSourceEntry[];
}>;

export type NarrativeValidatorModelOutput = Readonly<{
  propositions: readonly NarrativeIndependentProposition[];
  /** Source keys the validator found faithfully expressed in the draft. */
  coverageKeys: readonly string[];
}>;

/**
 * Role-scoped producer seam for `narrative.validate`: receives the final text
 * and the frozen source manifest, returns the independent decomposition.
 * Deterministic code performs every comparison and verdict (ADR-0124).
 */
export type NarrativeValidationModelProvider = Readonly<{
  role: "narrative.validate";
  validateNarrative(
    request: NarrativeValidatorModelRequest,
  ): Promise<NarrativeValidatorModelOutput>;
}>;

export type NarrativeValidationRequest = Readonly<{
  userId: UserId;
  artifactKind: NarrativeArtifactKind;
  /**
   * Opaque draft locator owned by the producer (e.g. `bio-version:<uuid>`).
   * Never carries raw text; one frozen validation intent per draft.
   */
  draftRef: string;
  draftLocale: string | null;
  draftText: string;
  generatorManifest: readonly NarrativeGeneratorStatement[];
  sourceEntries: readonly NarrativeSourceEntry[];
  /** Coverage-plan keys the frozen plan requires to be expressed. */
  plannedCoverageKeys: readonly string[];
  validationPolicyVersion: string;
  promptVersion: string;
  schemaVersion: string;
}>;

export type NarrativeFinding = Readonly<{
  findingCode: NarrativeFindingCode;
  severity: NarrativeSeverity;
  propositionKey: string | null;
  supportKey: string | null;
  detailCode: string | null;
  detailText: string | null;
}>;

export type NarrativeValidationCoverage = Readonly<{
  coveredKeys: readonly string[];
  uncoveredPlannedKeys: readonly string[];
}>;

/**
 * The typed result a producer reads. `blocked` never becomes a publishable
 * draft for Bio, and `incomplete` means the validator has not completed: no
 * publish and no Reflection Candidate may be derived from it (ADR-0132).
 */
export type NarrativeVerdict = "accepted" | "blocked";

export type NarrativeValidationResult = Readonly<{
  outcome: NarrativeVerdict;
  artifactKind: NarrativeArtifactKind;
  blockingFindings: readonly NarrativeFinding[];
  advisoryFindings: readonly NarrativeFinding[];
  coverage: NarrativeValidationCoverage;
  validationPolicyVersion: string;
  schemaVersion: string;
  promptVersion: string;
}>;

export type NarrativeValidationRecord = Readonly<{
  narrativeValidatorRequestId: NarrativeValidatorRequestId;
  userId: UserId;
  artifactKind: NarrativeArtifactKind;
  draftRef: string;
  requestFingerprint: string;
  validationPolicyVersion: string;
  promptVersion: string;
  schemaVersion: string;
  /** The frozen request content (kept for replay; purged on expiry). */
  frozenRequest: NarrativeValidationRequest;
  createdAt: Date;
  contentPurgedAt: Date | null;
}>;

export type NarrativeValidationResultRecord = Readonly<{
  narrativeValidatorResultId: NarrativeValidatorResultId;
  narrativeValidatorRequestId: NarrativeValidatorRequestId;
  userId: UserId;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  result: NarrativeValidationResult;
  createdAt: Date;
  contentPurgedAt: Date | null;
}>;

/**
 * Deterministic request gate. Rejecting a request is a typed business fence,
 * never a retryable transport failure (ADR-0132).
 */
export type NarrativeValidationRejectionCode =
  | "draft_ref_invalid"
  | "draft_text_invalid"
  | "generator_manifest_invalid"
  | "source_manifest_invalid"
  | "support_key_invalid"
  | "policy_version_invalid"
  | "schema_version_invalid"
  | "prompt_version_invalid";

export type NarrativeValidationRejection = Readonly<{
  code: NarrativeValidationRejectionCode;
  detail: string;
}>;

/**
 * Reconstructs the frozen request for a retry attempt of an admitted
 * `narrative.validate` command. `settled` means the attempt already reached a
 * terminal state and the replay must not run the provider again.
 */
export type NarrativeAttemptContext =
  | Readonly<{
      outcome: "evaluated";
      narrativeValidatorRequestId: NarrativeValidatorRequestId;
      request: NarrativeValidationRequest;
      expectedDataEpoch: number;
      attemptNo: number;
      attemptStatus: "prepared";
    }>
  | Readonly<{ outcome: "settled" }>
  | Readonly<{ outcome: "not_found" }>;

export type NarrativeValidationRepository = Readonly<{
  /** One transaction: locks the owner, freezes the request (idempotent). */
  submitRequest(input: {
    userId: UserId;
    request: NarrativeValidationRequest;
    requestFingerprint: string;
    expectedDataEpoch: number;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "created"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "reused"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "owner_missing" }>
    | Readonly<{ outcome: "data_epoch"; expectedDataEpoch: number }>
    | Readonly<{ outcome: "intent_conflict" }>
  >;
  /** Retry re-entry context from the shared command ledger. */
  readAttemptContext(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }): Promise<NarrativeAttemptContext>;
  /**
   * The single fenced result commit: verifies the owner epoch and the active
   * `narrative.validate` rollout pin inside one transaction and absorbs
   * replays of a settled request.
   */
  commitResult(input: {
    narrativeValidatorRequestId: NarrativeValidatorRequestId;
    userId: UserId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    result: NarrativeValidationResult;
  }): Promise<
    | Readonly<{ outcome: "committed"; resultId: NarrativeValidatorResultId }>
    | Readonly<{ outcome: "already_committed" }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
  /**
   * Producer read contract. Content refusal happens here at read time:
   * `incomplete` until a validator command completed, `content_expired`
   * once the retention window passed.
   */
  readResult(input: {
    userId: UserId;
    artifactKind: NarrativeArtifactKind;
    draftRef: string;
    now: Date;
  }): Promise<
    | Readonly<{
        outcome: "ok";
        result: NarrativeValidationResultRecord;
      }>
    | Readonly<{ outcome: "incomplete" }>
    | Readonly<{ outcome: "content_expired" }>
    | Readonly<{ outcome: "not_found" }>
  >;
  /** Bounded maintenance: expire content to a content-free envelope. */
  purgeExpiredContent(input: {
    now: Date;
    limit: number;
  }): Promise<number>;
  /** Diagnostics read of the frozen request row. */
  readRequest(input: {
    userId: UserId;
    artifactKind: NarrativeArtifactKind;
    draftRef: string;
  }): Promise<
    | Readonly<{ outcome: "ok"; request: NarrativeValidationRecord }>
    | Readonly<{ outcome: "not_found" }>
  >;
}>;

/**
 * Composition seam for producer Workflows (mirrors the Episode entrypoint
 * dependencies). Producers call `runNarrativeValidation` inside their own
 * durable workflow after persisting a draft.
 */
export type NarrativeValidationEntrypointDependencies = Readonly<{
  clock: () => Date;
  repository: NarrativeValidationRepository;
  modelRoleCommandService: import("../model-role-runtime").ModelRoleCommandService;
  /** Final recovery/rollout/epoch claim immediately before provider dispatch. */
  providerEgress?: import("../model-role-runtime").ModelRoleProviderEgress;
  narrativeValidationProvider: NarrativeValidationModelProvider;
}>;

export type NarrativeValidationEntrypointInput = Readonly<{
  request: NarrativeValidationRequest;
  expectedDataEpoch: number;
}>;

export type NarrativeValidationAttemptInput = Readonly<{
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  /** Optional for legacy direct retry callers; runtime derives retry metadata. */
  attemptKind?: import("../model-role-runtime").ModelRoleAttemptKind;
  rolloutPin?: string;
}>;

export type NarrativeValidationEntrypointResult = Readonly<{
  draftRef: string;
  outcome:
    | "completed"
    | "incomplete"
    | "fenced"
    | "retryable_failed"
    | "failed"
    | "rejected";
  rejectionCode: string | null;
  errorCode: string | null;
  verdict: NarrativeVerdict | null;
  /** Shared-ledger lineage for retry re-entry (null when never admitted). */
  generationCommandId: string | null;
  modelRunAttemptId: string | null;
}>;
