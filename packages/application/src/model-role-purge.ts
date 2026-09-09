export type ModelRolePurgeSurfaceContract = Readonly<{
  surfaceId: string;
  ownerResolution: "user_id";
  disposition: "hard_delete";
  privateFields: readonly string[];
  clearHandler: string;
  independentVerifier: string;
  receiptDestination: string;
  readDeadlinePolicy: string;
  restoreReapplyPolicy: string;
  introducedBy: string;
}>;

/**
 * F2's handoff payload for the closed Purge Surface Registry owned by F1.
 * Keeping this declaration explicit prevents the typed Bio tables from
 * becoming an untracked private surface while F1 migrates the old manual
 * purge list into its authoritative registry.
 */
export const ONE_A_3B_F2_PURGE_SURFACE_CONTRACTS = [
  {
    surfaceId: "bios",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: ["current_version_id", "current_source_revision", "current_data_epoch"],
    clearHandler: "owner_full_purge.bio.aggregate",
    independentVerifier: "owner_full_purge.bio.aggregate.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.current_only",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_versions",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: ["source_manifest", "presentation_locale", "content_expires_at"],
    clearHandler: "owner_full_purge.bio.versions",
    independentVerifier: "owner_full_purge.bio.versions.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.source_and_epoch_fence",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_statements",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: ["statement_text"],
    clearHandler: "owner_full_purge.bio.statements",
    independentVerifier: "owner_full_purge.bio.statements.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.current_only",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_atomic_propositions",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: ["proposition_text"],
    clearHandler: "owner_full_purge.bio.propositions",
    independentVerifier: "owner_full_purge.bio.propositions.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.current_only",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_claim_links",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: [],
    clearHandler: "owner_full_purge.bio.claim_links",
    independentVerifier: "owner_full_purge.bio.claim_links.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.source_and_epoch_fence",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_coverage_units",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: [],
    clearHandler: "owner_full_purge.bio.coverage",
    independentVerifier: "owner_full_purge.bio.coverage.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.source_and_epoch_fence",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_coverage_members",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: [],
    clearHandler: "owner_full_purge.bio.coverage_members",
    independentVerifier: "owner_full_purge.bio.coverage_members.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.source_and_epoch_fence",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
  {
    surfaceId: "bio_validation_findings",
    ownerResolution: "user_id",
    disposition: "hard_delete",
    privateFields: ["finding_code"],
    clearHandler: "owner_full_purge.bio.validation_findings",
    independentVerifier: "owner_full_purge.bio.validation_findings.empty",
    receiptDestination: "business_database",
    readDeadlinePolicy: "bio.read.current_only",
    restoreReapplyPolicy: "purge_marker.reapply.owner_epoch",
    introducedBy: "0044_1a3b_model_roles_and_bio_read_schema",
  },
] as const satisfies readonly ModelRolePurgeSurfaceContract[];
