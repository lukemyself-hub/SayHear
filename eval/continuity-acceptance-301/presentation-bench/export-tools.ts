/**
 * Writes the Decision call's function definitions, as the product's OpenCode
 * Go adapter sends them, to `fixtures/decision-tools.json`. Only the
 * tool-result layout (V3) uses them: it has to repeat the Decision request's
 * prefix, tools included, to share the Provider's prompt cache.
 *
 *   pnpm exec tsx eval/continuity-acceptance-301/presentation-bench/export-tools.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CURIOSITY_STOP_SIGNAL_FUNCTION,
  HISTORY_REVIEW_FUNCTION,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  actionFunctionsForCatalog,
} from "@sayhear/application";

const functions = [
  ...actionFunctionsForCatalog(MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG),
  CURIOSITY_STOP_SIGNAL_FUNCTION,
  HISTORY_REVIEW_FUNCTION,
];
const tools = functions.map((definition) => ({
  function: {
    description: definition.description,
    name: definition.name,
    parameters: definition.parameters,
    strict: definition.strict,
  },
  type: "function",
}));
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "decision-tools.json");
writeFileSync(target, `${JSON.stringify(tools, null, 2)}\n`);
console.log(tools.map((tool) => tool.function.name).join(", "));
