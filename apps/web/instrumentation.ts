import { assertSafeRuntimeConfiguration } from "./src/runtime-config";

export function register(): void {
  assertSafeRuntimeConfiguration(process.env);
}
