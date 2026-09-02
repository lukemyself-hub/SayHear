export type {
  ClaimKind,
  EnumValueSpec,
  LexicalSurface,
  ObjectValueSchema,
  PredicateLocalization,
  PredicateRegistryEntry,
  PredicateRegistrySnapshot,
  QualifierAxisSchema,
  RelationshipDirection,
  RelationshipProjectionLocalization,
  RelationshipProjectionView,
  RelationshipSemantics,
  ScopeSchema,
  SensitivityClass,
  TemporalSemantics,
  ValueCardinality,
} from "./types";

export {
  canonicalRelationshipKey,
  mapUtterance,
  mapUtteranceCodeSwitch,
  validateMappingProposal,
  type MappingInput,
  type MappingOutcome,
  type MappingProposalInput,
  type ProposalValidationResult,
} from "./mapper";

export { buildLegacyRegistryOverlay } from "./fixtures";
export {
  loadPredicateRegistrySnapshot,
  normalizeTypedValue,
  PREDICATE_IDS,
  PREDICATE_REGISTRY_RUNTIME_VERSION,
  PREDICATE_REGISTRY_VERSIONS,
  predicateRegistryFingerprint,
} from "./v1";
