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

export function assertSafeRuntimeConfiguration(
  environment: Environment,
): SayHearDeployment {
  const deployment = resolveDeployment(environment);

  if (
    (environment.SAYHEAR_PROVIDER_ADAPTER === "deterministic" ||
      environment.SAYHEAR_TEST_PROVIDER_CHUNKS ||
      environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS ||
      environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION ||
      environment.SAYHEAR_TEST_NOW ||
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

  return deployment;
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
}

export function loadRuntimeConfiguration(environment: Environment) {
  const deployment = assertSafeRuntimeConfiguration(environment);
  const testNow = environment.SAYHEAR_TEST_NOW
    ? new Date(environment.SAYHEAR_TEST_NOW)
    : null;
  if (testNow && Number.isNaN(testNow.getTime())) {
    throw new Error("SAYHEAR_TEST_NOW must be a valid ISO timestamp.");
  }

  const adapter =
    environment.SAYHEAR_PROVIDER_ADAPTER === "deterministic"
      ? "deterministic"
      : environment.SAYHEAR_PROVIDER_ADAPTER === "deepseek"
        ? "deepseek"
        : "openai";
  const deterministicChunks =
    adapter === "deterministic"
      ? parseDeterministicChunks(
          required(environment, "SAYHEAR_TEST_PROVIDER_CHUNKS"),
        )
      : [];
  const failAfterChunks = environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS
    ? Number(environment.SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS)
    : undefined;
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
  const deepseekBaseUrl =
    environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  if (deepseekBaseUrl.length === 0) {
    throw new Error("SAYHEAR_DEEPSEEK_BASE_URL must be a non-empty URL.");
  }
  // The deterministic test adapter keeps the OpenAI Champion metadata (it never
  // calls a Provider), so only a real deepseek adapter switches the lineage label.
  const providerProfile =
    adapter === "deepseek"
      ? ({
          defaultModel: "deepseek-v4-flash",
          provider: "deepseek",
          providerPolicyVersion: "deepseek-conversation-text:v1",
        } as const)
      : ({
          defaultModel: "gpt-5.4",
          provider: "openai",
          providerPolicyVersion: "openai-conversation-text:v1",
        } as const);
  // Live Provider credentials + transport base URL. The deterministic adapter
  // owns no credentials; both real Providers carry their baseUrl here so the
  // transport layer never hardcodes a Provider endpoint.
  const liveProviderCredentials =
    adapter === "openai"
      ? {
          apiKey: required(environment, "OPENAI_API_KEY"),
          baseUrl: "https://api.openai.com/v1",
        }
      : adapter === "deepseek"
        ? { apiKey: required(environment, "DEEPSEEK_API_KEY"), baseUrl: deepseekBaseUrl }
        : null;
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
  const expectedDataEpoch = Number(
    environment.SAYHEAR_EXPECTED_DATA_EPOCH ?? "1",
  );
  if (!Number.isSafeInteger(expectedDataEpoch) || expectedDataEpoch <= 0) {
    throw new Error("SAYHEAR_EXPECTED_DATA_EPOCH must be a positive safe integer.");
  }

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
    clock: testNow ? () => new Date(testNow) : () => new Date(),
    databaseUrl: required(environment, "DATABASE_URL"),
    deployment,
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
      expectedDataEpoch,
      leaseDurationMs: outboxLeaseDurationMs,
      leaseOwner: "sayhear-cron",
    }),
    recoveryScannerSecret: required(environment, "CRON_SECRET"),
    provider: Object.freeze({
      adapter,
      apiKey: liveProviderCredentials?.apiKey ?? null,
      timeoutMs,
      ...(liveProviderCredentials
        ? { baseUrl: liveProviderCredentials.baseUrl }
        : {}),
      champion: Object.freeze({
        configVersion: "conversation-text-champion:v1",
        consentPolicyVersion: null,
        contextLimit: 1_000_000,
        dataRegion: "provider-configured",
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
