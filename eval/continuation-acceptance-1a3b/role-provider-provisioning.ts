/**
 * Shared role-provider provisioning for the F3 capture tools
 * (`run-validator-capture`, `run-synthetic-candidate-capture`, and
 * `scripts/capture-g1-role-provider-calls`).
 *
 * The whole F3 capture surface only ever pins `deepseek` or `opencode-go`.
 * SayHear has no plan to onboard another provider here, so any other pinned
 * provider (including `openai`) fails closed instead of silently degrading.
 *
 * `F3_ROLE_TIMEOUT_MS` is deliberately wider than the runtime default:
 * `SAYHEAR_PROVIDER_TIMEOUT_MS` defaults to 60s in
 * `apps/web/src/runtime-config.ts`, but a frozen evaluation run must not be
 * killed by that production default while a long reasoning call is still
 * streaming, so the capture tools pin 120s.
 *
 * The deepseek baseUrl reads only `SAYHEAR_DEEPSEEK_BASE_URL`. The legacy
 * `DEEPSEEK_BASE_URL` is intentionally ignored so the champion side and the
 * role side of one capture can never point at different endpoints.
 */
import type { OneA3bProviderAdapter } from "@sayhear/ai";

export const F3_ROLE_TIMEOUT_MS = 120_000;

export type F3RoleEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveF3RoleAdapter(
  provider: string,
  environment: F3RoleEnvironment = process.env,
): OneA3bProviderAdapter {
  if (provider === "deepseek") {
    const apiKey = environment.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required for the selected deepseek provider.");
    }
    return {
      provider: "deepseek",
      apiKey,
      baseUrl:
        environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      timeoutMs: F3_ROLE_TIMEOUT_MS,
    };
  }
  if (provider === "opencode-go") {
    const apiKey = environment.OPENCODE_GO_API_KEY;
    if (!apiKey) {
      throw new Error("OPENCODE_GO_API_KEY is required for the selected opencode-go provider.");
    }
    return { provider: "opencode-go", apiKey, timeoutMs: F3_ROLE_TIMEOUT_MS };
  }
  throw new Error(`Capture does not support the pinned provider ${provider}.`);
}
