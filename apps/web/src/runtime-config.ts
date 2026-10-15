import {
  verifyOneA3bG1ReleaseManifest,
  type OneA3bG1ReleaseManifest,
} from "@sayhear/application";

type Environment = Readonly<Record<string, string | undefined>>;

export type SayHearDeployment =
  | "development"
  | "preview"
  | "production"
  | "test";

function resolveDeployment(environment: Environment): SayHearDeployment {
  const explicit = environment.SAYHEAR_DEPLOYMENT;
  const explicitDeployment =
    explicit === "development" ||
    explicit === "preview" ||
    explicit === "production" ||
    explicit === "test"
      ? explicit
      : null;

  let authoritativeDeployment: SayHearDeployment | null = null;
  if (environment.VERCEL_ENV === "preview") {
    authoritativeDeployment = "preview";
  } else if (environment.VERCEL_ENV === "production") {
    authoritativeDeployment = "production";
  } else if (environment.NODE_ENV === "production") {
    authoritativeDeployment = "production";
  } else if (environment.NODE_ENV === "test") {
    authoritativeDeployment = "test";
  }

  if (
    authoritativeDeployment &&
    explicitDeployment &&
    authoritativeDeployment !== explicitDeployment
  ) {
    throw new Error(
      `SAYHEAR_DEPLOYMENT cannot override authoritative ${authoritativeDeployment} environment signals.`,
    );
  }

  return authoritativeDeployment ?? explicitDeployment ?? "development";
}

function g1StageRequested(environment: Environment): boolean {
  return (
    environment.SAYHEAR_EPISODE_BUILD_ENABLED === "true" ||
    environment.SAYHEAR_REFLECTION_ENABLED === "true"
  );
}

function g1StageFullyRequested(environment: Environment): boolean {
  return (
    environment.SAYHEAR_EPISODE_BUILD_ENABLED === "true" &&
    environment.SAYHEAR_REFLECTION_ENABLED === "true"
  );
}

/**
 * Resolve and verify the exact G1 release artifact. An absent artifact keeps
 * the stage closed. The build, verification, and activation commands verify
 * evidence files before binding database pins; deployed runtime verifies the
 * content-addressed manifest and configuration authorization without requiring
 * post-commit release artifacts in the application checkout.
 *
 * Deployment identity, runtime configuration authorization, and historical
 * capability acceptance are separate (ADR-0148). The deployed commit SHA is
 * still required and recorded, but it is no longer required to equal the
 * manifest's acceptance commit: a new UI or server commit with unchanged G1
 * configuration reuses the accepted manifest and pins.
 */
export function resolveOneA3bG1ReleaseManifest(
  environment: Environment,
): OneA3bG1ReleaseManifest | null {
  const raw = environment.SAYHEAR_1A_3B_G1_RELEASE_MANIFEST;
  if (g1StageRequested(environment) && !g1StageFullyRequested(environment)) {
    throw new Error(
      "SAYHEAR_EPISODE_BUILD_ENABLED and SAYHEAR_REFLECTION_ENABLED must be enabled together for the evaluated 1A.3b G1 release.",
    );
  }
  if (!raw || raw.trim() === "") {
    if (g1StageRequested(environment)) {
      throw new Error(
        "SAYHEAR_1A_3B_G1_RELEASE_MANIFEST is required when an 1A.3b G1 write switch is enabled.",
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "SAYHEAR_1A_3B_G1_RELEASE_MANIFEST must be valid JSON.",
    );
  }

  let verification: ReturnType<typeof verifyOneA3bG1ReleaseManifest>;
  try {
    verification = verifyOneA3bG1ReleaseManifest(parsed);
  } catch {
    throw new Error(
      "SAYHEAR_1A_3B_G1_RELEASE_MANIFEST failed structural verification.",
    );
  }
  if (!verification.passed) {
    throw new Error(
      `SAYHEAR_1A_3B_G1_RELEASE_MANIFEST is invalid: ${verification.mismatches.join("; ")}`,
    );
  }
  const manifest = parsed as OneA3bG1ReleaseManifest;
  const deployedCommit =
    environment.VERCEL_GIT_COMMIT_SHA?.trim() ||
    environment.SAYHEAR_DEPLOYED_GIT_COMMIT_SHA?.trim();
  if (g1StageFullyRequested(environment) && !deployedCommit) {
    throw new Error(
      "SAYHEAR_DEPLOYED_GIT_COMMIT_SHA or VERCEL_GIT_COMMIT_SHA is required when the G1 write switches are enabled.",
    );
  }
  // ADR-0148: the deployed SHA is recorded as deployment identity, not an
  // equality condition for capability authorization. A same-configuration
  // commit keeps the accepted manifest and pins.
  if (g1StageRequested(environment) && manifest.status !== "active") {
    throw new Error(
      "SAYHEAR_1A_3B_G1_RELEASE_MANIFEST must be active before a G1 write switch can open.",
    );
  }
  return manifest;
}

export function assertSafeRuntimeConfiguration(
  environment: Environment,
): SayHearDeployment {
  const deployment = resolveDeployment(environment);

  for (const name of [
    "SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED",
    "SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED",
    "SAYHEAR_1A_3B_G2_RELEASE_MANIFEST",
  ]) {
    if (environment[name]?.trim()) {
      throw new Error(`${name} belongs to the retired G2 runtime and must be removed.`);
    }
  }

  if (
    (environment.SAYHEAR_PROVIDER_ADAPTER === "deterministic" ||
      environment.SAYHEAR_TEST_PROVIDER_CHUNKS ||
      environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS ||
      environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS_FILE ||
      environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION ||
      environment.SAYHEAR_TEST_NOW ||
      environment.SAYHEAR_TEST_NOW_FILE ||
      environment.SAYHEAR_TEST_PRINCIPAL_SUBJECT) &&
    deployment !== "test"
  ) {
    throw new Error(
      "A deterministic test provider, test principal, or fixed test clock is allowed only in the test environment.",
    );
  }

  if (
    (deployment === "preview" || deployment === "production") &&
    (environment.SAYHEAR_AUTH_SECRET_SOURCE === "development" ||
      environment.SAYHEAR_DEV_SIGNING_SECRET)
  ) {
    throw new Error(
      "Preview and production cannot start with development signing material.",
    );
  }

  // Startup-level guard (validate-startup.ts): the purge marker store must
  // never be the business database — a same-database marker would be restored
  // together with old backups and defeat the anti-resurrection purpose
  // (issue #27, architecture 20.6). Presence is enforced per composition by
  // loadRuntimeConfiguration.
  if (
    environment.PURGE_MARKER_DATABASE_URL &&
    environment.DATABASE_URL &&
    environment.PURGE_MARKER_DATABASE_URL.trim() ===
      environment.DATABASE_URL.trim()
  ) {
    throw new Error(
      "PURGE_MARKER_DATABASE_URL must point to a separate database, not the business DATABASE_URL.",
    );
  }

  resolveOneA3bG1ReleaseManifest(environment);

  return deployment;
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
}

function enabledSwitch(environment: Environment, name: string): boolean {
  const value = environment[name];
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

/** Default-off switch: only an explicit `true` opens the capability. */
function explicitSwitch(environment: Environment, name: string): boolean {
  const value = environment[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

const KNOWN_PROVIDER_ADAPTERS = [
  "openai",
  "deepseek",
  "deterministic",
  "opencode-go",
] as const;
type ProviderAdapter = (typeof KNOWN_PROVIDER_ADAPTERS)[number];

/**
 * Resolve the selected Provider adapter. An unset value keeps the historical
 * `openai` default; any explicit value must be one of the known adapters, so a
 * typo or empty string fails at configuration load instead of silently
 * selecting a different Provider than the deployment asked for. The invalid
 * value is never echoed into the error.
 */
function resolveProviderAdapter(value: string | undefined): ProviderAdapter {
  if (value === undefined) return "openai";
  if ((KNOWN_PROVIDER_ADAPTERS as readonly string[]).includes(value)) {
    return value as ProviderAdapter;
  }
  throw new Error(
    `SAYHEAR_PROVIDER_ADAPTER must be one of ${KNOWN_PROVIDER_ADAPTERS.join(", ")}.`,
  );
}

export function loadRuntimeConfiguration(environment: Environment) {
  const deployment = assertSafeRuntimeConfiguration(environment);
  const oneA3bG1ReleaseManifest = resolveOneA3bG1ReleaseManifest(environment);
  const testNow = environment.SAYHEAR_TEST_NOW
    ? new Date(environment.SAYHEAR_TEST_NOW)
    : null;
  if (testNow && Number.isNaN(testNow.getTime())) {
    throw new Error("SAYHEAR_TEST_NOW must be a valid ISO timestamp.");
  }
  // T00 #313: a scenario runner advances controlled time across turns and
  // days without restarting the app. The instant lives in a file named by the
  // test composition (never a client parameter) and is re-read on every clock
  // call. The same test-only deployment guard as SAYHEAR_TEST_NOW applies, and
  // an unreadable instant throws instead of falling back to the wall clock.
  const testNowFile = environment.SAYHEAR_TEST_NOW_FILE?.trim() || null;
  if (testNowFile && testNow) {
    throw new Error(
      "SAYHEAR_TEST_NOW_FILE and SAYHEAR_TEST_NOW cannot both be set.",
    );
  }
  const readTestNowFile = (file: string): Date => {
    let instant: Date;
    try {
      // Resolved at call time, only on this test-only path: this module is
      // also loaded by `instrumentation.ts`, so it must not statically import
      // a Node built-in that a non-Node bundle cannot provide.
      const { readFileSync } = process.getBuiltinModule("node:fs");
      instant = new Date(readFileSync(file, "utf8").trim());
    } catch {
      throw new Error("SAYHEAR_TEST_NOW_FILE could not be read.");
    }
    if (Number.isNaN(instant.getTime())) {
      throw new Error(
        "SAYHEAR_TEST_NOW_FILE must contain a valid ISO timestamp.",
      );
    }
    return instant;
  };

  const adapter = resolveProviderAdapter(environment.SAYHEAR_PROVIDER_ADAPTER);
  const deterministicChunks =
    adapter === "deterministic"
      ? parseDeterministicChunks(
          required(environment, "SAYHEAR_TEST_PROVIDER_CHUNKS"),
        )
      : [];
  const failAfterChunks =
    environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS_FILE === undefined
      ? environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS
        ? Number(environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS)
        : undefined
      : readProviderFaultChunksFile(
          environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS_FILE,
        );
  const failAfterCompletionValue =
    environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION;
  if (
    failAfterCompletionValue !== undefined &&
    failAfterCompletionValue !== "true" &&
    failAfterCompletionValue !== "false"
  ) {
    throw new Error(
      "SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION must be true or false.",
    );
  }
  const failAfterCompletion = failAfterCompletionValue === "true";
  if (
    failAfterChunks !== undefined &&
    (!Number.isInteger(failAfterChunks) || failAfterChunks < 0)
  ) {
    throw new Error(
      "SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS must be a non-negative integer.",
    );
  }
  const timeoutMs = Number(environment.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SAYHEAR_PROVIDER_TIMEOUT_MS must be a positive integer.");
  }
  // Issue #319: a chat request has its own end-to-end budget and its own
  // Provider timeout, separate from SAYHEAR_PROVIDER_TIMEOUT_MS, which the
  // background roles share (memory extraction legitimately needs minutes).
  // Both can only be tightened below the ADR-0152 stop condition (60 s).
  const conversationRequestBudgetMs = boundedMilliseconds(
    environment,
    "SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS",
    CONVERSATION_REQUEST_MAX_MS,
  );
  const conversationProviderTimeoutMs = boundedMilliseconds(
    environment,
    "SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS",
    CONVERSATION_REQUEST_MAX_MS,
  );
  const deepseekBaseUrl =
    environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  if (deepseekBaseUrl.length === 0) {
    throw new Error("SAYHEAR_DEEPSEEK_BASE_URL must be a non-empty URL.");
  }
  // The deterministic test adapter keeps the OpenAI Champion metadata (it never
  // calls a Provider), so only a real adapter switches the lineage label.
  const providerProfile =
    adapter === "deepseek"
      ? ({
          defaultModel: "deepseek-v4-flash",
          provider: "deepseek",
          providerPolicyVersion: "deepseek-conversation-text:v1",
        } as const)
      : adapter === "opencode-go"
        ? ({
            defaultModel: "deepseek-v4.1-flash",
            provider: "opencode-go",
            providerPolicyVersion: "opencode-go-conversation-text:v1",
          } as const)
        : ({
            defaultModel: "gpt-5.4",
            provider: "openai",
            providerPolicyVersion: "openai-conversation-text:v1",
          } as const);
  // Live Provider credentials + transport base URL. The deterministic adapter
  // owns no credentials; the Responses Providers carry their baseUrl here so
  // the transport layer never hardcodes an endpoint. OpenCode Go has no
  // caller-selectable baseUrl — its endpoint is fixed inside the transport —
  // so its credential is an API key only.
  const liveProviderCredentials =
    adapter === "openai"
      ? {
          apiKey: required(environment, "OPENAI_API_KEY"),
          baseUrl: "https://api.openai.com/v1",
        }
      : adapter === "deepseek"
        ? { apiKey: required(environment, "DEEPSEEK_API_KEY"), baseUrl: deepseekBaseUrl }
        : adapter === "opencode-go"
          ? { apiKey: required(environment, "OPENCODE_GO_API_KEY") }
          : null;
  const roleProviderAdapters = Object.freeze({
    deepseek:
      !environment.DEEPSEEK_API_KEY
        ? null
        : Object.freeze({
            apiKey: environment.DEEPSEEK_API_KEY,
            baseUrl: deepseekBaseUrl,
            provider: "deepseek" as const,
            timeoutMs,
          }),
    openai:
      !environment.OPENAI_API_KEY
        ? null
        : Object.freeze({
            apiKey: environment.OPENAI_API_KEY,
            baseUrl: "https://api.openai.com/v1",
            provider: "openai" as const,
            timeoutMs,
          }),
    // OpenCode Go: fixed endpoint, no caller-supplied baseUrl. The four G1
    // roles and the Conversation Champion select it by provider identity.
    "opencode-go": !environment.OPENCODE_GO_API_KEY
      ? null
      : Object.freeze({
          apiKey: environment.OPENCODE_GO_API_KEY,
          provider: "opencode-go" as const,
          timeoutMs,
        }),
  });
  const inactivityTimeoutMs = Number(
    environment.SAYHEAR_INACTIVITY_TIMEOUT_MS ?? "1800000",
  );
  if (!Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new Error(
      "SAYHEAR_INACTIVITY_TIMEOUT_MS must be a positive safe integer.",
    );
  }
  const inactivityPolicyVersion =
    environment.SAYHEAR_INACTIVITY_POLICY_VERSION ??
    "continuous-exchange-inactivity:v1";
  if (
    inactivityPolicyVersion.length === 0 ||
    inactivityPolicyVersion.length > 200
  ) {
    throw new Error(
      "SAYHEAR_INACTIVITY_POLICY_VERSION must be a non-empty version identifier.",
    );
  }
  const journalEligibilityPolicyVersion =
    environment.SAYHEAR_JOURNAL_ELIGIBILITY_POLICY_VERSION ??
    "journal-eligibility:v1";
  if (
    journalEligibilityPolicyVersion.length === 0 ||
    journalEligibilityPolicyVersion.length > 200
  ) {
    throw new Error(
      "SAYHEAR_JOURNAL_ELIGIBILITY_POLICY_VERSION must be a non-empty version identifier.",
    );
  }
  const minimumSubstantiveExpressionLength = Number(
    environment.SAYHEAR_MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH ?? "20",
  );
  if (
    !Number.isInteger(minimumSubstantiveExpressionLength) ||
    minimumSubstantiveExpressionLength <= 0
  ) {
    throw new Error(
      "SAYHEAR_MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH must be a positive integer.",
    );
  }
  const outboxLeaseDurationMs = Number(
    environment.SAYHEAR_OUTBOX_LEASE_DURATION_MS ?? "60000",
  );
  if (!Number.isSafeInteger(outboxLeaseDurationMs) || outboxLeaseDurationMs <= 0) {
    throw new Error(
      "SAYHEAR_OUTBOX_LEASE_DURATION_MS must be a positive safe integer.",
    );
  }
  // The purge marker store must live OUTSIDE the business database backup
  // domain (issue #27, architecture 20.6): a marker schema inside the business
  // database would be restored together with old backups and defeat the
  // anti-resurrection purpose.
  const databaseUrl = required(environment, "DATABASE_URL");
  const purgeMarkerDatabaseUrl = required(
    environment,
    "PURGE_MARKER_DATABASE_URL",
  );
  if (purgeMarkerDatabaseUrl.trim() === databaseUrl.trim()) {
    throw new Error(
      "PURGE_MARKER_DATABASE_URL must point to a separate database, not the business DATABASE_URL.",
    );
  }
  const providerRetentionDays = Number(
    environment.SAYHEAR_PROVIDER_RETENTION_DAYS ?? "30",
  );
  if (
    !Number.isInteger(providerRetentionDays) ||
    providerRetentionDays <= 0 ||
    providerRetentionDays > 3_650
  ) {
    throw new Error(
      "SAYHEAR_PROVIDER_RETENTION_DAYS must be an integer from 1 through 3650.",
    );
  }
  const writeSwitches = Object.freeze({
    // Issue #314: the controlled read-only history review. Default off; only
    // an explicit true offers the function and wires the answer stage.
    historyRecallEnabled: explicitSwitch(
      environment,
      "SAYHEAR_HISTORY_RECALL_ENABLED",
    ),
    evidenceExtractionEnabled: enabledSwitch(
      environment,
      "SAYHEAR_EVIDENCE_EXTRACTION_ENABLED",
    ),
    memoryRetrievalEnabled: enabledSwitch(
      environment,
      "SAYHEAR_MEMORY_RETRIEVAL_ENABLED",
    ),
    fastPathExtractionEnabled: enabledSwitch(
      environment,
      "SAYHEAR_FAST_PATH_EXTRACTION_ENABLED",
    ),
    memoryConsolidationEnabled: enabledSwitch(
      environment,
      "SAYHEAR_MEMORY_CONSOLIDATION_ENABLED",
    ),
    journalPublishEnabled: enabledSwitch(
      environment,
      "SAYHEAR_JOURNAL_PUBLISH_ENABLED",
    ),
    // 1A.3b stages cut over directly (ADR-0134); the Episode stage stays
    // closed by default until its release manifest publishes an evaluated
    // configuration. Only an explicit env switch opens it.
    episodeBuildEnabled: explicitSwitch(
      environment,
      "SAYHEAR_EPISODE_BUILD_ENABLED",
    ),
    // A3 (issue #199): the Reflection stage follows the same direct-switch
    // discipline; it stays closed until its release manifest opens it.
    reflectionEnabled: explicitSwitch(
      environment,
      "SAYHEAR_REFLECTION_ENABLED",
    ),
  });

  return Object.freeze({
    authSecret: required(environment, "NEXTAUTH_SECRET"),
    backupConfigurationFingerprint: required(
      environment,
      "SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT",
    ),
    backupPolicyVersion: required(
      environment,
      "SAYHEAR_BACKUP_POLICY_VERSION",
    ),
    clock: testNowFile
      ? () => readTestNowFile(testNowFile)
      : testNow
        ? () => new Date(testNow)
        : () => new Date(),
    databaseUrl,
    deployment,
    ownerPurge: Object.freeze({
      markerDatabaseUrl: purgeMarkerDatabaseUrl,
      providerRetentionDays,
    }),
    githubClientId: required(environment, "GITHUB_CLIENT_ID"),
    githubClientSecret: required(environment, "GITHUB_CLIENT_SECRET"),
    contextHmacSecret: required(environment, "SAYHEAR_CONTEXT_HMAC_SECRET"),
    inactivityPolicy: Object.freeze({
      timeoutMs: inactivityTimeoutMs,
      version: inactivityPolicyVersion,
    }),
    journalEligibilityPolicy: Object.freeze({
      minimumSubstantiveExpressionLength,
      version: journalEligibilityPolicyVersion,
    }),
    outboxDispatcher: Object.freeze({
      leaseDurationMs: outboxLeaseDurationMs,
      leaseOwner: "sayhear-cron",
    }),
    recoveryScannerSecret: required(environment, "CRON_SECRET"),
    conversationRequest: Object.freeze({
      budgetMs: conversationRequestBudgetMs,
      providerTimeoutMs: conversationProviderTimeoutMs,
    }),
    provider: Object.freeze({
      adapter,
      apiKey: liveProviderCredentials?.apiKey ?? null,
      timeoutMs,
      roleAdapters: roleProviderAdapters,
      ...(liveProviderCredentials && "baseUrl" in liveProviderCredentials
        ? { baseUrl: liveProviderCredentials.baseUrl }
        : {}),
      champion: Object.freeze({
        configVersion: "conversation-text-champion:v1",
        consentPolicyVersion: null,
        contextLimit: 1_000_000,
        // OpenCode Go does not publish a direct-provider data region; the
        // honest label is that the Provider manages processing. The dated
        // zero-data-retention contract is recorded in ADR-0147.
        dataRegion:
          adapter === "opencode-go" ? "provider-managed" : "provider-configured",
        model:
          environment.SAYHEAR_CONVERSATION_TEXT_MODEL ??
          providerProfile.defaultModel,
        provider: providerProfile.provider,
        providerPolicyVersion: providerProfile.providerPolicyVersion,
        retentionMode: "store-disabled",
        snapshot:
          environment.SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT ??
          environment.SAYHEAR_CONVERSATION_TEXT_MODEL ??
          providerProfile.defaultModel,
        streaming: true as const,
        supportedLocales: Object.freeze(["en", "zh"]),
        trainingPolicy: "api-data-controls",
      }),
      deterministicChunks: Object.freeze(deterministicChunks),
      ...(failAfterCompletion ? { failAfterCompletion: true } : {}),
      ...(failAfterChunks === undefined ? {} : { failAfterChunks }),
    }),
    oneA3bG1: Object.freeze({
      releaseManifest: oneA3bG1ReleaseManifest,
    }),
    writeSwitches,
  });
}

function parseDeterministicChunks(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SAYHEAR_TEST_PROVIDER_CHUNKS must be a JSON string array.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("SAYHEAR_TEST_PROVIDER_CHUNKS must be a JSON string array.");
  }
  return parsed;
}

/** ADR-0152 (2026-10-12 revision): a chat request is stopped end to end after 60 seconds. */
export const CONVERSATION_REQUEST_MAX_MS = 60_000;

function boundedMilliseconds(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? maximum : Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer of at most ${maximum} milliseconds.`,
    );
  }
  return value;
}

/**
 * The verify driver's controllable test clock: the file content is the frozen
 * "now" for every clock call. It must be readable and hold one ISO timestamp,
 * because a silent fallback to wall time would fake a real clock. Test deployment
 * only, enforced by assertSafeRuntimeConfiguration.
 */
function readTestNowFile(path: string): Date {
  let instant: Date;
  try {
    // Use the runtime builtin lazily because this module is also imported by
    // instrumentation, which can be bundled for a non-Node runtime.
    const { readFileSync } = process.getBuiltinModule("node:fs");
    instant = new Date(readFileSync(path, "utf8").trim());
  } catch {
    throw new Error("SAYHEAR_TEST_NOW_FILE could not be read.");
  }
  if (Number.isNaN(instant.getTime())) {
    throw new Error("SAYHEAR_TEST_NOW_FILE must contain a valid ISO timestamp.");
  }
  return instant;
}

/**
 * The verify driver's toggleable deterministic fault: a missing or empty file
 * means no fault, a non-negative integer is the chunk ceiling where the stream
 * fails, and anything else fails loudly rather than silently faking a clean
 * run. Test deployment only, enforced by assertSafeRuntimeConfiguration.
 */
function readProviderFaultChunksFile(path: string): number | undefined {
  let content: string;
  try {
    const { readFileSync } = process.getBuiltinModule("node:fs");
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const value = content.trim();
  if (value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS_FILE must contain a non-negative integer.",
    );
  }
  return parsed;
}
