"use client";

// PROTOTYPE (issue #173) — Three structurally different variants of the user-facing Profile Bio + refresh
// experience (A letter / B chapters / C pulse), switchable via ?variant= over ?scenario= synthetic claim
// sets. Throwaway: Luke's human verdict decides; this is never production code.

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { SCENARIOS, VARIANT_DEFS, getScenario, type ScenarioId, type VariantId } from "./fixtures";
import { VariantALetter } from "./variant-a-letter";
import { VariantBChapters } from "./variant-b-chapters";
import { VariantCSnapshot } from "./variant-c-snapshot";

const LEGEND = [
  {
    heading: "Question (issue #173)",
    body: "What should the Profile Bio and refresh experience look and feel like, so it reads as SayHear's grounded understanding — not a database dump, not a flattering personality test, not an editable identity claim?",
  },
  {
    heading: "Variants",
    body: "A — The letter: one narrative voice, epistemic status woven into prose only, quiet controls. B — The chapters: structured document with explicit status chip and per-section basis expandables. C — The pulse: compressed snapshot where temporal change and explicit epistemic chips are primary.",
  },
  {
    heading: "Narrative voice",
    body: "All three variants narrate in third person — synthetic persona Alex (he/him), by name — per Luke's verdict 2026-09-04: it reads like SayHear introducing the person, closer to the §14.2 framing \"if someone asked me who this person is\". Page chrome (titles, buttons, status, banners, correction panel) stays second person; only the Bio narrative is third person.",
  },
  {
    heading: "Open question for #174",
    body: "Where the real narrative name and pronoun come from (Self Entity label? account profile?) and how code-switched / bilingual names render is undecided. Alex is a placeholder.",
  },
  {
    heading: "Verdicts so far (Luke)",
    body: "B's structure wins on content richness and clarity. All bios narrate in third person (Alex, he/him); chrome stays second person. The basis expandable reads like a Claim Inspector: each claim with time markers, the user's original words quoted with date, and kind labels (\"fact, as he told it\" / \"my impression\") demoted to quiet muted annotations. \"Not quite right?\" is one entry at the page bottom, not per chapter. Boundary to re-check at SPEC time: keep it in human words + dates (no claim IDs or technical references), on demand only — §14.3 keeps the default interface free of technicalized citation panels.",
  },
  {
    heading: "Ground rules baked into every variant",
    body: "Old Bio never shows after a trust-boundary change (ADR-0056). No preview, approval, or text editing; refresh and correction are separate actions (ADR-0057, ADR-0001). Status copy comes from the server in the real product. The 24h manual-refresh cooldown is a placeholder — issue #163 leaves the real interval open.",
  },
];

export function ProfileBioPrototype() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [legendOpen, setLegendOpen] = useState(false);

  const variantParam = searchParams.get("variant");
  const variant: VariantId =
    variantParam === "A" || variantParam === "B" || variantParam === "C" ? variantParam : "A";
  const scenario = getScenario(searchParams.get("scenario"));

  const setParams = useCallback(
    (next: { variant?: VariantId; scenario?: ScenarioId }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.variant) {
        params.set("variant", next.variant);
      }
      if (next.scenario) {
        params.set("scenario", next.scenario);
      }
      router.replace(`/prototype/profile-bio?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const cycleVariant = useCallback(
    (direction: 1 | -1) => {
      const index = VARIANT_DEFS.findIndex((def) => def.id === variant);
      const next = VARIANT_DEFS[(index + direction + VARIANT_DEFS.length) % VARIANT_DEFS.length];
      if (!next) {
        return;
      }
      setParams({ variant: next.id });
    },
    [setParams, variant],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) {
        return;
      }
      if (event.key === "ArrowLeft") {
        cycleVariant(-1);
      } else {
        cycleVariant(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleVariant]);

  const currentDef = VARIANT_DEFS.find((def) => def.id === variant);

  return (
    <main className="shell pbioShell">
      {variant === "A" && <VariantALetter scenario={scenario} />}
      {variant === "B" && <VariantBChapters scenario={scenario} />}
      {variant === "C" && <VariantCSnapshot scenario={scenario} />}

      {process.env.NODE_ENV !== "production" && (
        <>
          {legendOpen && (
            <aside className="pbioLegend">
              {LEGEND.map((entry) => (
                <div key={entry.heading}>
                  <h3>{entry.heading}</h3>
                  <p>{entry.body}</p>
                </div>
              ))}
              <div>
                <h3>Scenarios</h3>
                <ul>
                  {Object.values(SCENARIOS).map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.label}</strong> — {entry.covers}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="pbioCorrectionNote">
                All controls are inert. Arrow keys cycle variants. Refresh semantics: ordinary failures may
                keep the old Bio; trust-boundary states never do.
              </p>
            </aside>
          )}
          <div className="pbioSwitcher">
            <button type="button" aria-label="Previous variant" onClick={() => cycleVariant(-1)}>
              ←
            </button>
            <span className="pbioSwitcherLabel">
              {variant} — {currentDef?.name}
            </span>
            <button type="button" aria-label="Next variant" onClick={() => cycleVariant(1)}>
              →
            </button>
            <select
              aria-label="Scenario"
              value={scenario.id}
              onChange={(event) => setParams({ scenario: event.target.value as ScenarioId })}
            >
              {Object.values(SCENARIOS).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button type="button" aria-label="About this prototype" onClick={() => setLegendOpen((open) => !open)}>
              ?
            </button>
          </div>
        </>
      )}
    </main>
  );
}
