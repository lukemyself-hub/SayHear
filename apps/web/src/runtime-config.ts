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
    provider: Object.freeze({
      adapter,
      apiKey:
        adapter === "openai" ? required(environment, "OPENAI_API_KEY") : null,
      timeoutMs,
      champion: Object.freeze({
        configVersion: "conversation-text-champion:v1",
        contextLimit: 1_000_000,
        dataRegion: "provider-configured",
        model: environment.SAYHEAR_CONVERSATION_TEXT_MODEL ?? "gpt-5.4",
        provider: "openai" as const,
        retentionMode: "store-disabled",
        snapshot:
          environment.SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT ??
          environment.SAYHEAR_CONVERSATION_TEXT_MODEL ??
          "gpt-5.4",
        streaming: true as const,
        supportedLocales: Object.freeze(["en", "zh"]),
        trainingPolicy: "api-data-controls",
      }),
      deterministicChunks: Object.freeze(deterministicChunks),
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
