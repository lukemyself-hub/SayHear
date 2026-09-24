import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { V5Pins } from "./protocol-v5";

async function main(): Promise<void> {
  const base = JSON.parse(
    await readFile(
      resolve("eval/continuation-acceptance-1a3b/pins-v4.json"),
      "utf8",
    ),
  ) as V5Pins;
  const pins: V5Pins = {
    ...base,
    version: "1a3b-g2-pins:v5",
    roles: {
      ...base.roles,
      "proactive.followup": {
        ...base.roles["proactive.followup"],
        promptVersion: "proactive-followup-prompt:v5",
        policyVersion: "proactive-followup-policy-bundle:v5",
      },
    },
    continuation: {
      ...base.continuation,
      arms: {
        ...base.continuation.arms,
        on: {
          ...base.continuation.arms.on,
          id: "continuation-candidate-1a3b-v5",
          proactive: {
            ...base.continuation.arms.on.proactive,
            configVersion: "proactive-followup:v5",
            promptVersion: "proactive-followup-prompt:v5",
            policyVersion: "proactive-followup-policy-bundle:v5",
          },
        },
      },
    },
    expression: {
      selectedConfigId: "proactive-expression-v5",
      configurations: base.expression.configurations.map((entry) => ({
        ...entry,
        id: "proactive-expression-v5",
        pin: {
          ...entry.pin,
          promptVersion: "proactive-followup-prompt:v5",
          policyVersion: "proactive-followup-policy-bundle:v5",
        },
      })),
    },
  };
  await writeFile(resolve("eval/continuation-acceptance-1a3b/pins-v5.json"), `${JSON.stringify(pins, null, 2)}\n`, "utf8");
}

if (process.argv[1]?.endsWith("build-v5-pins.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
