import { shuffled } from "./protocol";
import type { V6Scene } from "./protocol-v6";

export const V6_SAMPLE_SEED = 20720260923;
export const V6_PAIRWISE_SIZE = 10;
export const V6_LANGUAGE_QUOTAS = { en: 5, zh: 3, code_switch: 2 } as const;
export const V6_FAMILY_MINIMUMS = {
  positive_open_loop: 3,
  positive_memory: 3,
  stateful_suppression: 2,
  competing_pool: 1,
} as const;
export const V6_PROTECTED_REQUIREMENTS = [
  "refusal",
  "short_answer",
  "topic_change",
  "direct_task",
] as const;

/** Selects exactly ten actual emit scenes or returns null when quotas cannot be met. */
export function selectV6PairwiseSample(input: Readonly<{
  candidates: readonly V6Scene[];
  completeStatefulSceneIds: ReadonlySet<string>;
}>): readonly V6Scene[] | null {
  const ordered = shuffled(input.candidates, V6_SAMPLE_SEED);
  const selected: V6Scene[] = [];
  const languages = { en: 0, zh: 0, code_switch: 0 };
  const families = new Map<string, number>();
  const topics = new Map<string, number>();
  let visits = 0;

  const canComplete = (index: number): boolean => {
    const remaining = ordered.slice(index);
    for (const language of Object.keys(V6_LANGUAGE_QUOTAS) as Array<keyof typeof V6_LANGUAGE_QUOTAS>) {
      const need = V6_LANGUAGE_QUOTAS[language] - languages[language];
      if (need < 0 || remaining.filter((scene) => scene.languageVariant === language).length < need) return false;
    }
    for (const [family, minimum] of Object.entries(V6_FAMILY_MINIMUMS)) {
      const need = minimum - (families.get(family) ?? 0);
      if (need > remaining.filter((scene) => scene.family === family).length) return false;
    }
    const completeStatefulCount = selected.filter((scene) => input.completeStatefulSceneIds.has(scene.id)).length;
    const possibleStateful = remaining.filter((scene) => input.completeStatefulSceneIds.has(scene.id)).length;
    if (completeStatefulCount + possibleStateful < 2) return false;
    for (const category of V6_PROTECTED_REQUIREMENTS) {
      if (selected.some((scene) => scene.protectedCategories.includes(category))) continue;
      if (!remaining.some((scene) => scene.protectedCategories.includes(category))) return false;
    }
    return selected.length + remaining.length >= V6_PAIRWISE_SIZE;
  };

  const search = (index: number): boolean => {
    visits += 1;
    if (visits > 2_000_000) return false;
    if (selected.length === V6_PAIRWISE_SIZE) {
      return languages.en === 5 && languages.zh === 3 && languages.code_switch === 2 &&
        Object.entries(V6_FAMILY_MINIMUMS).every(([family, minimum]) => (families.get(family) ?? 0) >= minimum) &&
        selected.filter((scene) => input.completeStatefulSceneIds.has(scene.id)).length >= 2 &&
        V6_PROTECTED_REQUIREMENTS.every((category) => selected.some((scene) => scene.protectedCategories.includes(category)));
    }
    if (index >= ordered.length || !canComplete(index)) return false;
    const scene = ordered[index]!;
    const language = scene.languageVariant;
    if (languages[language] < V6_LANGUAGE_QUOTAS[language] && (topics.get(scene.topic) ?? 0) < 3) {
      selected.push(scene);
      languages[language] += 1;
      families.set(scene.family, (families.get(scene.family) ?? 0) + 1);
      topics.set(scene.topic, (topics.get(scene.topic) ?? 0) + 1);
      if (search(index + 1)) return true;
      selected.pop();
      languages[language] -= 1;
      families.set(scene.family, (families.get(scene.family) ?? 1) - 1);
      topics.set(scene.topic, (topics.get(scene.topic) ?? 1) - 1);
    }
    return search(index + 1);
  };

  return search(0) ? [...selected] : null;
}
