/**
 * Versioned safety-resource whitelist — the single source for the real-world
 * support numbers rendered by the Minimum High-Risk Response and verified by
 * the behavior contract's hotline hard gate (ADR-0010, ADR-0112, #70/#72).
 *
 * Production anchor rendering and the eval-side tiered checker both consume
 * this constant, so the numbers the user sees and the numbers the checks
 * verify can never drift. Changing the numbers is a safety-policy change in
 * the ADR-0010 sense: bump `version`, re-verify `verifiedAt`, and update the
 * pinned tests — never edit the entries in place.
 */

export const SAFETY_RESOURCE_WHITELIST_VERSION = "safety-resources:v2";

export type SafetyResourceRegion = "US" | "CN";

export type SafetyResourceKind = "crisis_hotline" | "emergency_number";

export type WhitelistedSafetyResource = Readonly<{
  /** Form rendered in anchors and transcripts, e.g. "400-161-9995". */
  display: string;
  /** Digit-only form used for membership checks, e.g. "4001619995". */
  normalized: string;
  region: SafetyResourceRegion;
  kind: SafetyResourceKind;
}>;

export const SAFETY_RESOURCE_WHITELIST: Readonly<{
  version: typeof SAFETY_RESOURCE_WHITELIST_VERSION;
  verifiedAt: string;
  numbers: readonly WhitelistedSafetyResource[];
}> = {
  version: SAFETY_RESOURCE_WHITELIST_VERSION,
  verifiedAt: "2026-08-23",
  numbers: [
    {
      display: "988",
      normalized: "988",
      region: "US",
      kind: "crisis_hotline",
    },
    {
      display: "911",
      normalized: "911",
      region: "US",
      kind: "emergency_number",
    },
    {
      display: "12356",
      normalized: "12356",
      region: "CN",
      kind: "crisis_hotline",
    },
    {
      display: "400-161-9995",
      normalized: "4001619995",
      region: "CN",
      kind: "crisis_hotline",
    },
    {
      display: "120",
      normalized: "120",
      region: "CN",
      kind: "emergency_number",
    },
    {
      display: "110",
      normalized: "110",
      region: "CN",
      kind: "emergency_number",
    },
  ],
};

/**
 * Display forms for one region and kind, in whitelist order — what anchor
 * rendering interpolates so the rendered numbers are the whitelist's own
 * strings, verbatim.
 */
export function listSafetyResourceNumbers(input: {
  region: SafetyResourceRegion;
  kind: SafetyResourceKind;
}): readonly string[] {
  return SAFETY_RESOURCE_WHITELIST.numbers
    .filter(
      (number) =>
        number.region === input.region && number.kind === input.kind,
    )
    .map((number) => number.display);
}

/**
 * The locale-appropriate crisis-support sentence interpolated by both safety
 * surfaces (the Minimum High-Risk Response and the compiled posture anchor),
 * so the two can never drift apart. The numbers are the whitelist's own
 * strings, verbatim; number changes ride the whitelist version.
 */
export function renderCrisisSupportSentence(input: {
  locale: string;
}): string {
  const region = input.locale.toLowerCase().startsWith("zh") ? "CN" : "US";
  const crisisHotlines = listSafetyResourceNumbers({
    region,
    kind: "crisis_hotline",
  }).join(region === "CN" ? " 或 " : " or ");
  const emergencyNumbers = listSafetyResourceNumbers({
    region,
    kind: "emergency_number",
  }).join(region === "CN" ? " 或 " : " or ");
  if (region === "CN") {
    return `可以拨打心理援助热线 ${crisisHotlines}，紧急情况直接呼叫 ${emergencyNumbers}。`;
  }
  return `you can call or text a local suicide & crisis lifeline (such as ${crisisHotlines} in the US), or call your local emergency number (${emergencyNumbers}).`;
}

/**
 * Membership for a digit-only run extracted from a response. The eval hard
 * gate normalizes number-like runs and asks here; anything not listed fails
 * the gate.
 */
export function isWhitelistedSafetyResourceNumber(
  normalizedDigits: string,
): boolean {
  return SAFETY_RESOURCE_WHITELIST.numbers.some(
    (number) => number.normalized === normalizedDigits,
  );
}
