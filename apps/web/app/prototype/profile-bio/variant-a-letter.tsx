"use client";

import { useState } from "react";

import { BIOS, CORRECTION_COPY, type Scenario } from "./fixtures";

export function VariantALetter({ scenario }: { scenario: Scenario }) {
  const [correctionOpen, setCorrectionOpen] = useState(false);

  if (!scenario.showBio) {
    return (
      <article className="pbioLetter">
        <p className="pbioLetterEyebrow">SayHear's current understanding of you</p>
        <h1 className="pbioLetterTitle">{scenario.holdTitle}</h1>
        <div className="pbioLetterBody">
          <p>{scenario.holdBody}</p>
        </div>
      </article>
    );
  }

  const bioKey = scenario.bioKey;
  if (!bioKey) {
    return null;
  }
  const bio = BIOS.A[bioKey];

  return (
    <article className="pbioLetter">
      <p className="pbioLetterEyebrow">SayHear's current understanding of you</p>
      {scenario.banner && (
        <p className={`pbioBanner pbioTone${scenario.banner.tone}`}>{scenario.banner.text}</p>
      )}
      <div className="pbioLetterBody">
        {bio.paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <p className="pbioLetterSignature">— SayHear</p>
      <footer className="pbioLetterMeta">
        <span>
          {scenario.versionLabel} · written {scenario.lastUpdatedAt}
        </span>
        {scenario.nextScheduledAt && <span>Next scheduled rewrite {scenario.nextScheduledAt}</span>}
        <span className="pbioRefreshQuiet">
          {scenario.refreshState === "available" && <button type="button">Refresh</button>}
          {scenario.refreshState === "in-progress" && <span className="pbioMuted">Refreshing…</span>}
          {scenario.refreshState === "failed" && <button type="button">Try the rewrite again</button>}
          {scenario.refreshState === "cooldown" && (
            <span className="pbioMuted">Rewrite available again {scenario.nextManualRefreshAt}</span>
          )}
        </span>
      </footer>
      <div className="pbioCorrection">
        <button type="button" onClick={() => setCorrectionOpen((open) => !open)}>
          {correctionOpen ? "Close" : CORRECTION_COPY.title}
        </button>
        {correctionOpen && (
          <div className="pbioCorrectionPanel">
            <p>{CORRECTION_COPY.body}</p>
            <p className="pbioCorrectionNote">{CORRECTION_COPY.prototypeNote}</p>
          </div>
        )}
      </div>
    </article>
  );
}
