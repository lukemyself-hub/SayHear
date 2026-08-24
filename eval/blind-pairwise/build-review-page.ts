/**
 * PROTOTYPE — build the shareable human re-rating page for issue #79.
 *
 * The page is intentionally self-contained so Luke can open it directly from
 * the file system. It embeds pairs.json only. It never embeds scores.json or
 * sealed-identities.json, and it does not call a server.
 *
 * Usage:
 *   pnpm exec tsx eval/blind-pairwise/build-review-page.ts \
 *     --dir eval/blind-pairwise/run-79
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Arguments = Readonly<{ dir: string }>;

function parseArguments(): Arguments {
  const values = process.argv.slice(2);
  const dirIndex = values.indexOf("--dir");
  const dir = dirIndex >= 0 ? values[dirIndex + 1] : undefined;
  if (!dir) throw new Error("--dir is required.");
  return { dir };
}

async function main(): Promise<void> {
  const { dir } = parseArguments();
  const directory = path.resolve(dir);
  const pairs = JSON.parse(
    await readFile(path.join(directory, "pairs.json"), "utf8"),
  ) as unknown;
  if (!pairs || typeof pairs !== "object" || Array.isArray(pairs)) {
    throw new Error("pairs.json must contain an object.");
  }
  const templateName =
    (pairs as { protocol?: unknown }).protocol === "blind-pairwise:v2"
      ? "review-page.v2.template.html"
      : "review-page.template.html";
  const template = await readFile(
    path.join(import.meta.dirname, templateName),
    "utf8",
  );
  const payload = JSON.stringify(pairs).replaceAll("<", "\\u003c");
  const marker = "const PAIRS = /*__PAIRS__*/;";
  if (!template.includes(marker)) throw new Error("Page template marker is missing.");
  const page = template.replace(marker, `const PAIRS = ${payload};`);
  await writeFile(path.join(directory, "index.html"), page, "utf8");
  console.log(`[prototype] wrote ${path.relative(process.cwd(), path.join(directory, "index.html"))}`);
}

main().catch((error: unknown) => {
  console.error("[prototype] page build failed:", error);
  process.exitCode = 1;
});
