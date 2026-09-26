import type { V6CatalogManifest, V6Family, V6Scene } from "./protocol-v6";

const POSITIVE_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "competing_pool",
] as const satisfies readonly V6Family[];
const LANGUAGES = ["en", "zh", "code_switch"] as const;

/**
 * Split the complete formal pool into one initial and two fixed supplements.
 * The first batch carries every negative/control case; each batch contains
 * every positive family and language when the frozen family minimums apply.
 */
export function splitV6FormalBatches(
  scenes: readonly V6Scene[],
): NonNullable<V6CatalogManifest["batches"]> {
  const byId: Record<string, string[]> = {
    "batch-1": [],
    "batch-2": [],
    "batch-3": [],
  };
  byId["batch-1"]!.push(...scenes.filter((scene) => scene.family === "omission_contract" || scene.family === "correct_zero").map((scene) => scene.id));

  for (const [familyIndex, family] of POSITIVE_FAMILIES.entries()) {
    for (const [languageIndex, language] of LANGUAGES.entries()) {
      const candidates = scenes.filter((scene) => scene.family === family && scene.languageVariant === language);
      const firstCount = Math.round(candidates.length * 0.6);
      const remaining = candidates.length - firstCount;
      let secondCount = Math.floor(remaining / 2);
      let thirdCount = Math.floor(remaining / 2);
      if (remaining % 2 === 1) {
        if ((familyIndex + languageIndex) % 2 === 0) secondCount += 1;
        else thirdCount += 1;
      }
      byId["batch-1"]!.push(...candidates.slice(0, firstCount).map((scene) => scene.id));
      byId["batch-2"]!.push(...candidates.slice(firstCount, firstCount + secondCount).map((scene) => scene.id));
      byId["batch-3"]!.push(...candidates.slice(firstCount + secondCount, firstCount + secondCount + thirdCount).map((scene) => scene.id));
    }
  }
  return ["batch-1", "batch-2", "batch-3"].map((id) => ({ id, sceneIds: byId[id]! }));
}
