import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { V5Pins } from "./protocol-v5";

async function main(): Promise<void> {
  const previous = JSON.parse(
    await readFile(resolve("eval/continuation-acceptance-1a3b/pins-v5.json"), "utf8"),
  ) as V5Pins;
  const promptVersion = "proactive-followup-prompt:v6";
  const policyVersion = "proactive-followup-policy-bundle:v7";
  const schemaVersion = previous.roles["proactive.followup"].schemaVersion;
  const pins: Omit<V5Pins, "version"> & { version: "1a3b-g2-pins:v6" } = {
    ...previous,
    version: "1a3b-g2-pins:v6",
    roles: {
      ...previous.roles,
      "proactive.followup": {
        ...previous.roles["proactive.followup"],
        promptVersion,
        policyVersion,
      },
    },
    continuation: {
      ...previous.continuation,
      arms: {
        ...previous.continuation.arms,
        on: {
          ...previous.continuation.arms.on,
          id: "continuation-candidate-1a3b-v6",
          proactive: {
            configVersion: "proactive-followup:v6",
            promptVersion,
            schemaVersion,
            policyVersion,
          },
        },
      },
    },
    expression: {
      selectedConfigId: "proactive-expression-v6",
      configurations: previous.expression.configurations.map((entry) => ({
        ...entry,
        id: "proactive-expression-v6",
        pin: { ...entry.pin, promptVersion, policyVersion },
      })),
    },
  };
  await writeFile(resolve("eval/continuation-acceptance-1a3b/pins-v6.json"), `${JSON.stringify(pins, null, 2)}\n`, "utf8");
}

if (process.argv[1]?.endsWith("build-v6-pins.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
