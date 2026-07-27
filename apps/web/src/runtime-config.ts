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
    (environment.SAYHEAR_TEST_NOW ||
      environment.SAYHEAR_TEST_PRINCIPAL_SUBJECT) &&
    deployment !== "test"
  ) {
    throw new Error(
      "A fixed test principal or time is allowed only in the test environment.",
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
  });
}
