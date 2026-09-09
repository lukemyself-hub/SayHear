import type {
  BioAtomicPropositionId,
  BioCoverageUnitId,
  BioId,
  BioStatementId,
  BioVersionId,
  MemoryClaimVersionId,
  UserId,
} from "@sayhear/domain";

export type BioInspectionStatement = Readonly<{
  bioStatementId: BioStatementId;
  ordinal: number;
  sectionKey: string;
  statementKey: string;
  statementText: string | null;
}>;

export type BioInspectionProposition = Readonly<{
  bioAtomicPropositionId: BioAtomicPropositionId;
  propositionKey: string;
  propositionText: string | null;
}>;

export type BioInspectionCoverageUnit = Readonly<{
  bioCoverageUnitId: BioCoverageUnitId;
  unitKey: string;
  disposition:
    | "covered"
    | "deferred_by_budget"
    | "background_absent"
    | "excluded_by_policy"
    | "stale";
  coveragePolicyVersion: string;
  claimVersionIds: readonly MemoryClaimVersionId[];
}>;

export type BioInspectionClaimLink = Readonly<{
  memoryClaimVersionId: MemoryClaimVersionId;
  linkRole: "input" | "support";
  supportStatus:
    | "eligible"
    | "deferred_by_budget"
    | "invalidated"
    | "missing";
  sourceRevision: number;
  expectedDataEpoch: number;
}>;

export type BioInspectionRead = Readonly<{
  outcome: "ok";
  bioId: BioId;
  bioVersionId: BioVersionId;
  userId: UserId;
  revision: number;
  status:
    | "draft"
    | "validated"
    | "published"
    | "superseded"
    | "trust_invalidated"
    | "stale"
    | "needs_review"
    | "content_expired";
  sourceRevision: number;
  expectedDataEpoch: number;
  presentationLocale: string;
  sourceManifest: Readonly<Record<string, unknown>>;
  statements: readonly BioInspectionStatement[];
  propositions: readonly BioInspectionProposition[];
  coverageUnits: readonly BioInspectionCoverageUnit[];
  claimLinks: readonly BioInspectionClaimLink[];
}>;

export type BioInspectionStateChanged = Readonly<{
  outcome: "state_changed";
  bioId: BioId;
  bioVersionId: BioVersionId | null;
  currentSourceRevision: number | null;
  currentDataEpoch: number | null;
  observedDataEpoch: number;
}>;

export type BioInspectionResult =
  | BioInspectionRead
  | BioInspectionStateChanged
  | Readonly<{ outcome: "no_record" }>;

export type BioInspectionRepository = Readonly<{
  readCurrentBio(input: Readonly<{ userId: UserId; bioId?: BioId }>): Promise<BioInspectionResult>;
}>;

export type BioInspectionService = Readonly<{
  readCurrentBio: BioInspectionRepository["readCurrentBio"];
}>;

export function createBioInspectionService(dependencies: Readonly<{
  repository: BioInspectionRepository;
}>): BioInspectionService {
  return {
    readCurrentBio(input) {
      return dependencies.repository.readCurrentBio(input);
    },
  };
}
