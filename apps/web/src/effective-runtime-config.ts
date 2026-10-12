/**
 * Deployed-side effective runtime configuration reporter.
 *
 * SPEC #275 decision 5 requires the comparison authority to be the deployed
 * side or a trusted platform, never a local environment declaration. This
 * module runs inside the deployment, resolves the effective runtime
 * configuration with the one existing resolver, and returns only content-free,
 * safe values and target identities. It is exposed by
 * `/api/internal/inspection/effective-runtime-config` with the existing Cron
 * operator bearer or an authenticated Owner, the same inspection boundary as
 * the release identity probe.
 *
 * The wire version and category vocabulary are duplicated here on purpose: the
 * release-tool gate in `scripts/effective-runtime-config-gate.ts` owns them.
 * `tests/effective-runtime-config-deployment.test.ts` proves the two copies
 * have not drifted by parsing this output with that gate.
 */
import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_ROLE_POLICIES,
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_RECALL_DEFAULT_POLICY,
  RECENT_CONTEXT_COMPILER_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  sha256Hex,
  type HistoryRecallGovernanceEffectiveState,
  type RecentContextGovernanceEffectiveState,
} from "@sayhear/application";

import {
  authorizeContentFreeInspection,
  buildHostedReleaseIdentity,
  normalizeDatabaseIdentity,
} from "./release-identity";
import {
  CONVERSATION_REQUEST_MAX_MS,
  loadRuntimeConfiguration,
} from "./runtime-config";

export const EFFECTIVE_RUNTIME_CONFIG_VERSION =
  "1a3b-g1-effective-runtime-config:v1";

type Environment = Readonly<Record<string, string | undefined>>;

export type EffectiveRuntimeConfigCategory =
  | "provider"
  | "prompt-schema-policy"
  | "parameters-budget"
  | "roles-switches"
  | "runtime"
  | "migrations-registry"
  | "schedule-targets"
  | "owner-auth"
  | "database-identity"
  | "backup-retention"
  | "credentials"
  | "deadline-budgets";

export type EffectiveConfigItemValue = string | number | boolean | null;

export type EffectiveConfigurationItem = Readonly<{
  category: EffectiveRuntimeConfigCategory;
  critical: boolean;
  defaultValue?: EffectiveConfigItemValue;
  inManifestFingerprint: boolean;
  key: string;
  platformLimit?: EffectiveConfigItemValue;
  source: "default" | "override" | "platform" | "unverified";
  value: EffectiveConfigItemValue;
}>;

export type EffectiveRuntimeConfigurationSnapshot = Readonly<{
  collectedAt: string;
  commit: string;
  deploymentId: string;
  items: readonly EffectiveConfigurationItem[];
  version: typeof EFFECTIVE_RUNTIME_CONFIG_VERSION;
}>;

const PROVIDER_DEFAULT_TIMEOUT_MS = 60_000;

function presence(value: string | null | undefined): "present" | "absent" {
  return value ? "present" : "absent";
}

function overrideSource(
  environment: Environment,
  name: string,
): "default" | "override" {
  return environment[name] === undefined ? "default" : "override";
}

/**
 * Resolve the effective runtime configuration and project it onto the
 * content-free report surface. Secrets become `present`/`absent`, database
 * URLs become salted-free target hashes (already the release-identity
 * convention), and any key this process cannot read is reported `unverified`
 * with a null value rather than guessed.
 */
export function buildEffectiveRuntimeConfiguration(
  environment: Environment,
  options: {
    now?: () => Date;
    /**
     * #295: content-free snapshot of the deployed recent-context governance.
     * `null` (or absent) reports the items `unverified` with a null value
     * rather than guessing; the release comparison must never read a missing
     * probe as equal.
     */
    recentContextGovernance?: RecentContextGovernanceEffectiveState | null;
    /** #320: content-free history-recall governance snapshot; null = unverified. */
    historyRecallGovernance?: HistoryRecallGovernanceEffectiveState | null;
  } = {},
): EffectiveRuntimeConfigurationSnapshot {
  const runtime = loadRuntimeConfiguration(environment);
  const identity = buildHostedReleaseIdentity(environment);
  const items: EffectiveConfigurationItem[] = [];
  const add = (item: EffectiveConfigurationItem): void => {
    items.push(item);
  };

  // Provider / model / endpoint.
  add({
    category: "provider",
    critical: true,
    inManifestFingerprint: true,
    key: "provider.adapter",
    source: overrideSource(environment, "SAYHEAR_PROVIDER_ADAPTER"),
    value: runtime.provider.adapter,
    defaultValue: "openai",
  });
  add({
    category: "provider",
    critical: true,
    inManifestFingerprint: true,
    key: "provider.model",
    source: overrideSource(environment, "SAYHEAR_CONVERSATION_TEXT_MODEL"),
    value: runtime.provider.champion.model,
    defaultValue: "gpt-5.4",
  });
  add({
    category: "provider",
    critical: true,
    inManifestFingerprint: true,
    key: "provider.snapshot",
    source: overrideSource(environment, "SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT"),
    value: runtime.provider.champion.snapshot,
  });
  add({
    category: "provider",
    critical: true,
    inManifestFingerprint: true,
    key: "provider.endpoint",
    source: "platform",
    value:
      "baseUrl" in runtime.provider && runtime.provider.baseUrl
        ? runtime.provider.baseUrl
        : runtime.provider.adapter === "opencode-go"
          ? "provider-fixed-endpoint"
          : "unconfigured",
  });
  add({
    category: "provider",
    critical: false,
    inManifestFingerprint: false,
    key: "provider.champion_context_limit",
    platformLimit: runtime.provider.champion.contextLimit,
    source: "default",
    value: runtime.provider.champion.contextLimit,
  });

  // Prompt / typed Schema / policy.
  const manifest = runtime.oneA3bG1.releaseManifest;
  add({
    category: "prompt-schema-policy",
    critical: true,
    inManifestFingerprint: true,
    key: "prompt.policy_bundle_version",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.policyBundle.modelRolePolicyVersion : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: true,
    inManifestFingerprint: true,
    key: "prompt.role_configuration_fingerprint",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.roles.configurationFingerprint : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: true,
    inManifestFingerprint: true,
    key: "policy.fallback_mode",
    source: manifest ? "override" : "default",
    value: manifest ? manifest.policyBundle.fallbackMode : "disabled",
  });
  add({
    category: "prompt-schema-policy",
    critical: true,
    inManifestFingerprint: true,
    key: "prompt.validator_calibration_version",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.validatorCalibration.ledgerVersion : null,
  });

  // Parameters / output budgets / retry budget.
  if (manifest) {
    for (const configuration of manifest.roles.configurations) {
      add({
        category: "parameters-budget",
        critical: true,
        inManifestFingerprint: true,
        key: `parameters.${configuration.role}.config_version`,
        source: "override",
        value: configuration.configVersion,
      });
      add({
        category: "parameters-budget",
        critical: true,
        inManifestFingerprint: true,
        key: `parameters.${configuration.role}.max_output_tokens`,
        source: "override",
        value:
          typeof configuration.parameterSnapshot.maxOutputTokens === "number"
            ? configuration.parameterSnapshot.maxOutputTokens
            : null,
      });
      add({
        category: "parameters-budget",
        critical: true,
        inManifestFingerprint: true,
        key: `parameters.${configuration.role}.prompt_version`,
        source: "override",
        value: configuration.promptVersion,
      });
      add({
        category: "parameters-budget",
        critical: true,
        inManifestFingerprint: true,
        key: `parameters.${configuration.role}.schema_version`,
        source: "override",
        value: configuration.schemaVersion,
      });
    }
  } else {
    add({
      category: "parameters-budget",
      critical: true,
      inManifestFingerprint: true,
      key: "parameters.role_configurations",
      source: "unverified",
      value: null,
    });
  }
  add({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: true,
    key: "deadline.technical_retry_budget",
    source: "default",
    value:
      Math.max(
        ...ONE_A_3B_G1_ENABLED_ROLES.map(
          (role) => ONE_A_3B_ROLE_POLICIES[role].maxTechnicalRetries,
        ),
      ) + 1,
  });

  // Roles / switches.
  add({
    category: "roles-switches",
    critical: true,
    inManifestFingerprint: true,
    key: "roles.enabled",
    source: manifest ? "override" : "default",
    value: (manifest ? manifest.roles.enabledRoles : [...ONE_A_3B_G1_ENABLED_ROLES]).join(","),
  });
  add({
    category: "roles-switches",
    critical: true,
    inManifestFingerprint: true,
    key: "roles.deferred",
    source: manifest ? "override" : "default",
    value: (
      manifest
        ? manifest.roles.deferredRoles
        : ["open_loop.extract", "bio.write", "proactive.followup"]
    ).join(","),
  });
  for (const [key, value] of [
    ["switch.evidence_extraction_enabled", runtime.writeSwitches.evidenceExtractionEnabled],
    ["switch.memory_retrieval_enabled", runtime.writeSwitches.memoryRetrievalEnabled],
    ["switch.fast_path_extraction_enabled", runtime.writeSwitches.fastPathExtractionEnabled],
    ["switch.memory_consolidation_enabled", runtime.writeSwitches.memoryConsolidationEnabled],
    ["switch.journal_publish_enabled", runtime.writeSwitches.journalPublishEnabled],
    ["switch.episode_build_enabled", runtime.writeSwitches.episodeBuildEnabled],
    ["switch.reflection_enabled", runtime.writeSwitches.reflectionEnabled],
    ["switch.history_recall_enabled", runtime.writeSwitches.historyRecallEnabled],
  ] as const) {
    add({
      category: "roles-switches",
      critical: true,
      inManifestFingerprint: false,
      key,
      source: "override",
      value,
    });
  }

  // Recent-context governance (#295): independent, versioned switch. The
  // switch itself is not part of the G1 manifest fingerprint; it is reported
  // separately so a disable is visible without changing G1 role pins. A row
  // only counts as effective when every identity/budget names the runtime
  // wired here; a mismatched row is reported not-effective and its
  // policy/parameter values as `unverified`, never as the effective override.
  const governance = options.recentContextGovernance ?? null;
  const activeGovernance = governance?.active ?? null;
  const governanceMatchesRuntime =
    activeGovernance !== null &&
    activeGovernance.compilerVersion === RECENT_CONTEXT_COMPILER_VERSION &&
    activeGovernance.selectorPolicyVersion ===
      RECENT_CONTEXT_SELECTION_POLICY_VERSION &&
    activeGovernance.selectionPolicyVersion ===
      RECENT_CONTEXT_DEFAULT_POLICY.version &&
    activeGovernance.budgetTokens ===
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens &&
    activeGovernance.maxCandidateRows ===
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows &&
    activeGovernance.maxCandidateBytes ===
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes &&
    activeGovernance.maxSingleEventTokens ===
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens &&
    activeGovernance.readTimeoutMs ===
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs;
  const effectiveRecentContextEnabled =
    governanceMatchesRuntime && (governance?.enabled ?? false);
  // The source union has no `absent`: a verified absence of an active policy
  // (or a mismatched row) reports `unverified` with a null value rather than
  // claiming an effective override the deployment does not actually run.
  const policySource = governanceMatchesRuntime ? "override" : "unverified";
  add({
    category: "roles-switches",
    critical: false,
    inManifestFingerprint: false,
    key: "switch.recent_context_enabled",
    source: governance ? "override" : "unverified",
    value: governance ? effectiveRecentContextEnabled : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: false,
    inManifestFingerprint: false,
    key: "policy.recent_context_governance_version",
    source: policySource,
    value: governanceMatchesRuntime ? activeGovernance.policyVersion : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: false,
    inManifestFingerprint: false,
    key: "policy.recent_context_selector_version",
    source: policySource,
    value: governanceMatchesRuntime
      ? activeGovernance.selectorPolicyVersion
      : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: false,
    inManifestFingerprint: false,
    key: "policy.recent_context_selection_version",
    source: policySource,
    value: governanceMatchesRuntime
      ? activeGovernance.selectionPolicyVersion
      : null,
  });
  add({
    category: "parameters-budget",
    critical: false,
    inManifestFingerprint: false,
    key: "parameters.recent_context.budget_tokens",
    source: policySource,
    value: governanceMatchesRuntime ? activeGovernance.budgetTokens : null,
  });
  add({
    category: "parameters-budget",
    critical: false,
    inManifestFingerprint: false,
    key: "parameters.recent_context.max_candidate_rows",
    source: policySource,
    value: governanceMatchesRuntime ? activeGovernance.maxCandidateRows : null,
  });
  add({
    category: "parameters-budget",
    critical: false,
    inManifestFingerprint: false,
    key: "parameters.recent_context.max_candidate_bytes",
    source: policySource,
    value: governanceMatchesRuntime ? activeGovernance.maxCandidateBytes : null,
  });
  add({
    category: "parameters-budget",
    critical: false,
    inManifestFingerprint: false,
    key: "parameters.recent_context.max_single_event_tokens",
    source: policySource,
    value: governanceMatchesRuntime
      ? activeGovernance.maxSingleEventTokens
      : null,
  });
  add({
    category: "parameters-budget",
    critical: false,
    inManifestFingerprint: false,
    key: "parameters.recent_context.read_timeout_ms",
    source: policySource,
    value: governanceMatchesRuntime ? activeGovernance.readTimeoutMs : null,
  });

  // History-recall governance (#320): the deployment switch alone does not
  // enable the path; an active immutable governance version that names the
  // budget identity wired here must also exist.
  const historyGovernance = options.historyRecallGovernance ?? null;
  const activeHistoryGovernance = historyGovernance?.active ?? null;
  const historyGovernanceMatches =
    activeHistoryGovernance !== null &&
    activeHistoryGovernance.historyPolicyVersion ===
      HISTORY_RECALL_DEFAULT_POLICY.version &&
    activeHistoryGovernance.harnessPolicyVersion ===
      HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version;
  add({
    category: "roles-switches",
    critical: false,
    inManifestFingerprint: false,
    key: "switch.history_recall_governance_enabled",
    source: historyGovernance ? "override" : "unverified",
    value: historyGovernance ? historyGovernanceMatches : null,
  });
  add({
    category: "prompt-schema-policy",
    critical: false,
    inManifestFingerprint: false,
    key: "policy.history_recall_governance_version",
    source: historyGovernanceMatches ? "override" : "unverified",
    value: historyGovernanceMatches ? activeHistoryGovernance.policyVersion : null,
  });

  // Runtime / hosted identity.
  add({
    category: "runtime",
    critical: true,
    inManifestFingerprint: false,
    key: "runtime.deployment",
    source: "override",
    value: runtime.deployment,
  });
  add({
    category: "runtime",
    critical: false,
    inManifestFingerprint: false,
    key: "runtime.environment",
    source: "platform",
    value: environment.VERCEL_ENV ?? null,
  });
  add({
    category: "runtime",
    critical: true,
    inManifestFingerprint: false,
    key: "hosted.project_id",
    source: "platform",
    value: identity.projectId,
  });
  add({
    category: "runtime",
    critical: false,
    inManifestFingerprint: false,
    key: "hosted.team_id",
    source: identity.teamId ? "platform" : "unverified",
    value: identity.teamId,
  });

  // Migrations / Purge Surface Registry.
  add({
    category: "migrations-registry",
    critical: true,
    inManifestFingerprint: true,
    key: "migrations.business_fingerprint",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.schema.fingerprint : null,
  });
  add({
    category: "migrations-registry",
    critical: true,
    inManifestFingerprint: true,
    key: "migrations.purge_marker_fingerprint",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.schema.purgeMarkerFingerprint : null,
  });
  add({
    category: "migrations-registry",
    critical: true,
    inManifestFingerprint: true,
    key: "registry.purge_surface_registry_version",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.schema.purgeSurfaceRegistryVersion : null,
  });
  add({
    category: "migrations-registry",
    critical: true,
    inManifestFingerprint: true,
    key: "registry.external_integration_manifest_version",
    source: manifest ? "override" : "unverified",
    value: manifest ? manifest.schema.externalIntegrationManifestVersion : null,
  });

  // Schedule targets: the trusted platform owns these, not the web deployment.
  add({
    category: "schedule-targets",
    critical: false,
    inManifestFingerprint: false,
    key: "schedule.recovery_scan_target",
    source: "unverified",
    value: null,
  });
  add({
    category: "schedule-targets",
    critical: false,
    inManifestFingerprint: false,
    key: "schedule.backup_renewal_target",
    source: "unverified",
    value: null,
  });

  // Owner / auth.
  add({
    category: "owner-auth",
    critical: true,
    inManifestFingerprint: false,
    key: "owner.subject",
    source: environment.SAYHEAR_INTERNAL_OWNER_SUBJECT ? "override" : "unverified",
    value: environment.SAYHEAR_INTERNAL_OWNER_SUBJECT ?? null,
  });
  add({
    category: "owner-auth",
    critical: true,
    inManifestFingerprint: false,
    key: "owner.user_id",
    source: environment.SAYHEAR_INTERNAL_OWNER_USER_ID ? "override" : "unverified",
    value: environment.SAYHEAR_INTERNAL_OWNER_USER_ID ?? null,
  });
  add({
    category: "owner-auth",
    critical: false,
    inManifestFingerprint: false,
    key: "owner.issuer",
    source: environment.SAYHEAR_INTERNAL_OWNER_ISSUER ? "override" : "unverified",
    value: environment.SAYHEAR_INTERNAL_OWNER_ISSUER ?? null,
  });
  add({
    category: "owner-auth",
    critical: true,
    inManifestFingerprint: false,
    key: "auth.session_secret",
    source: "override",
    value: presence(runtime.authSecret),
  });
  add({
    category: "owner-auth",
    critical: true,
    inManifestFingerprint: false,
    key: "auth.github_oauth",
    source: "override",
    value:
      presence(runtime.githubClientId) === "present" &&
      presence(runtime.githubClientSecret) === "present"
        ? "present"
        : "absent",
  });

  // Database identity: safe target hashes, never the connection string.
  add({
    category: "database-identity",
    critical: true,
    inManifestFingerprint: false,
    key: "database.business_target",
    source: "override",
    value: `sha256:${sha256Hex(normalizeDatabaseIdentity(runtime.databaseUrl))}`,
  });
  add({
    category: "database-identity",
    critical: true,
    inManifestFingerprint: false,
    key: "database.purge_marker_target",
    source: "override",
    value: `sha256:${sha256Hex(
      normalizeDatabaseIdentity(runtime.ownerPurge.markerDatabaseUrl),
    )}`,
  });

  // Backup / retention.
  add({
    category: "backup-retention",
    critical: true,
    inManifestFingerprint: false,
    key: "backup.policy_version",
    source: "override",
    value: runtime.backupPolicyVersion,
  });
  add({
    category: "backup-retention",
    critical: true,
    inManifestFingerprint: false,
    key: "backup.configuration_fingerprint",
    source: "override",
    value: runtime.backupConfigurationFingerprint,
  });
  add({
    category: "backup-retention",
    critical: true,
    inManifestFingerprint: false,
    key: "retention.provider_days",
    source: "override",
    value: runtime.ownerPurge.providerRetentionDays,
    defaultValue: 30,
  });
  for (const [key, name] of [
    ["retention.database_days", "SAYHEAR_DATABASE_RETENTION_DAYS"],
    ["retention.pitr_days", "SAYHEAR_PITR_RETENTION_DAYS"],
    ["retention.snapshot_days", "SAYHEAR_SNAPSHOT_RETENTION_DAYS"],
  ] as const) {
    const raw = environment[name];
    add({
      category: "backup-retention",
      critical: false,
      inManifestFingerprint: false,
      key,
      source: raw === undefined ? "unverified" : "override",
      value: raw === undefined ? null : Number(raw),
    });
  }

  // Credentials: existence only, never the value or a guessable hash.
  add({
    category: "credentials",
    critical: true,
    inManifestFingerprint: false,
    key: "credentials.provider_key",
    source: "override",
    value: presence(runtime.provider.apiKey),
  });
  add({
    category: "credentials",
    critical: true,
    inManifestFingerprint: false,
    key: "credentials.cron_secret",
    source: "override",
    value: presence(runtime.recoveryScannerSecret),
  });
  add({
    category: "credentials",
    critical: true,
    inManifestFingerprint: false,
    key: "credentials.nextauth_secret",
    source: "override",
    value: presence(runtime.authSecret),
  });
  add({
    category: "credentials",
    critical: true,
    inManifestFingerprint: false,
    key: "credentials.github_client_secret",
    source: "override",
    value: presence(runtime.githubClientSecret),
  });
  add({
    category: "credentials",
    critical: false,
    inManifestFingerprint: false,
    key: "credentials.deepseek_key",
    source: "override",
    value: presence(runtime.provider.roleAdapters.deepseek?.apiKey ?? null),
  });
  add({
    category: "credentials",
    critical: false,
    inManifestFingerprint: false,
    key: "credentials.opencode_go_key",
    source: "override",
    value: presence(runtime.provider.roleAdapters["opencode-go"]?.apiKey ?? null),
  });

  // Layered deadlines / platform limits / lease / recovery.
  add({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: false,
    key: "deadline.provider_ms",
    source: overrideSource(environment, "SAYHEAR_PROVIDER_TIMEOUT_MS"),
    value: runtime.provider.timeoutMs,
    defaultValue: PROVIDER_DEFAULT_TIMEOUT_MS,
  });
  // Issue #319: the chat path's own budget and Provider timeout, separate from
  // the background roles' shared deadline above (ADR-0152: 30 s stop).
  add({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: false,
    key: "deadline.conversation_request_ms",
    source: overrideSource(environment, "SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS"),
    value: runtime.conversationRequest.budgetMs,
    defaultValue: CONVERSATION_REQUEST_MAX_MS,
  });
  add({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: false,
    key: "deadline.conversation_provider_ms",
    source: overrideSource(environment, "SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS"),
    value: runtime.conversationRequest.providerTimeoutMs,
    defaultValue: CONVERSATION_REQUEST_MAX_MS,
  });
  for (const key of [
    "deadline.gateway_limit_ms",
    "deadline.workflow_step_budget_ms",
    "deadline.workflow_function_limit_ms",
    "deadline.scan_http_dispatch_ms",
    "deadline.acceptance_wait_window_ms",
  ]) {
    add({
      category: "deadline-budgets",
      critical: false,
      inManifestFingerprint: false,
      key,
      source: "unverified",
      value: null,
    });
  }
  add({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: false,
    key: "lease.outbox_lease_duration_ms",
    source: overrideSource(environment, "SAYHEAR_OUTBOX_LEASE_DURATION_MS"),
    value: runtime.outboxDispatcher.leaseDurationMs,
    defaultValue: 60_000,
  });
  add({
    category: "deadline-budgets",
    critical: false,
    inManifestFingerprint: false,
    key: "recovery.inactivity_timeout_ms",
    source: overrideSource(environment, "SAYHEAR_INACTIVITY_TIMEOUT_MS"),
    value: runtime.inactivityPolicy.timeoutMs,
    defaultValue: 1_800_000,
  });
  add({
    category: "deadline-budgets",
    critical: false,
    inManifestFingerprint: false,
    key: "recovery.conversation_window_ms",
    source: "unverified",
    value: null,
  });

  return {
    collectedAt: (options.now ?? (() => new Date()))().toISOString(),
    commit:
      environment.SAYHEAR_DEPLOYED_GIT_COMMIT_SHA?.trim() ||
      environment.VERCEL_GIT_COMMIT_SHA?.trim() ||
      "",
    deploymentId:
      environment.VERCEL_DEPLOYMENT_ID?.trim() ||
      environment.SAYHEAR_DEPLOYMENT_ID?.trim() ||
      "unknown",
    items,
    version: EFFECTIVE_RUNTIME_CONFIG_VERSION,
  };
}

export type EffectiveRuntimeConfigHandlerDependencies = Readonly<{
  environment: Environment;
  operatorSecret: string | undefined;
  getSession: () => Promise<{ user?: { id?: string } } | null>;
  assertOperator: (userId: string) => Promise<void>;
  now?: () => Date;
  /**
   * Optional DB probe for the recent-context governance state (#295). A
   * missing probe, or a probe that throws, reports the items `unverified`
   * instead of guessing; it never fails the whole report.
   */
  loadRecentContextGovernance?: () => Promise<RecentContextGovernanceEffectiveState | null>;
  loadHistoryRecallGovernance?: () => Promise<HistoryRecallGovernanceEffectiveState | null>;
}>;

/**
 * The inspection handler. It authorizes exactly like the release-identity
 * probe (Cron operator bearer or authenticated Owner), then returns the
 * deployment's own effective configuration. A deployment that cannot resolve
 * its runtime configuration fails closed with `503`; it never returns a
 * partial payload that a comparison could read as equal.
 */
export async function handleEffectiveRuntimeConfigRequest(
  request: Request,
  dependencies: EffectiveRuntimeConfigHandlerDependencies,
): Promise<Response> {
  const denied = await authorizeContentFreeInspection(request, {
    operatorSecret: dependencies.operatorSecret,
    getSession: dependencies.getSession,
    assertOperator: dependencies.assertOperator,
  });
  if (denied) return denied;
  try {
    let recentContextGovernance: RecentContextGovernanceEffectiveState | null =
      null;
    if (dependencies.loadRecentContextGovernance) {
      try {
        recentContextGovernance =
          await dependencies.loadRecentContextGovernance();
      } catch {
        recentContextGovernance = null;
      }
    }
    let historyRecallGovernance: HistoryRecallGovernanceEffectiveState | null =
      null;
    if (dependencies.loadHistoryRecallGovernance) {
      try {
        historyRecallGovernance =
          await dependencies.loadHistoryRecallGovernance();
      } catch {
        historyRecallGovernance = null;
      }
    }
    return Response.json(
      buildEffectiveRuntimeConfiguration(dependencies.environment, {
        ...(dependencies.now ? { now: dependencies.now } : {}),
        historyRecallGovernance,
        recentContextGovernance,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "effective_runtime_config_unavailable" },
      { status: 503 },
    );
  }
}
