"use client";

import { useState } from "react";

import { BIOS, CORRECTION_COPY, type Scenario } from "./fixtures";

export function VariantCSnapshot({ scenario }: { scenario: Scenario }) {
  const [correctionOpen, setCorrectionOpen] = useState(false);

  if (!scenario.showBio) {
    return (
      <section className="pbioPulse">
        <div className={`pbioStateBlock pbioState${scenario.status}`}>
          <h2>{scenario.holdTitle}</h2>
          <p>{scenario.holdBody}</p>
        </div>
      </section>
    );
  }

  const bioKey = scenario.bioKey;
  if (!bioKey) {
    return null;
  }
  const bio = BIOS.C[bioKey];

  return (
    <section className="pbioPulse">
      <header className="pbioPulseHeader">
        <p className="pbioLetterEyebrow">SayHear's current understanding</p>
        <h1>As of {scenario.lastUpdatedAtShort}</h1>
        <span className={`pbioStatusChip pbioStatus${scenario.status}`}>
          {scenario.status === "current" ? "Current" : scenario.status === "updating" ? "Updating" : "Unavailable"}
        </span>
      </header>
      {scenario.banner && (
        <p className={`pbioBanner pbioTone${scenario.banner.tone}`}>{scenario.banner.text}</p>
      )}
      <div className="pbioPulseCard">
        {bio.snapshot.map((paragraph, index) => (
          <p key={index} className="pbioPulseSnapshot">
            {paragraph}
          </p>
        ))}
        <h2>Since the last version</h2>
        {bio.changes.length > 0 ? (
          <ul className="pbioChangeList">
            {bio.changes.map((change) => (
              <li key={change.text}>
                <span className={`pbioChangeBadge pbioBadge${change.badge}`}>{change.badge}</span>
                {change.text}
                <span className="pbioSourceChip">{change.source}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pbioMuted">{bio.changesNote}</p>
        )}
      </div>
      <div className="pbioPulseControls">
        {scenario.refreshState === "available" && (
          <button type="button" className="pbioRefreshButton">
            Refresh — rewrite from current memory
          </button>
        )}
        {scenario.refreshState === "in-progress" && (
          <button type="button" className="pbioRefreshButton" disabled>
            Refreshing…
          </button>
        )}
        {scenario.refreshState === "failed" && (
          <button type="button" className="pbioRefreshButton">Retry the rewrite</button>
        )}
        {scenario.refreshState === "cooldown" && (
          <button type="button" className="pbioRefreshButton" disabled>
            Refresh available {scenario.nextManualRefreshAt}
          </button>
        )}
        <footer className="pbioPulseMeta">
          {scenario.versionLabel && <span>{scenario.versionLabel}</span>}
          {scenario.nextScheduledAt && <span>Next scheduled rewrite {scenario.nextScheduledAt}</span>}
          <span>Rewriting re-tells; it doesn't fix wrong facts.</span>
          <button type="button" onClick={() => setCorrectionOpen((open) => !open)}>
            {correctionOpen ? "Close" : "Tell SayHear something's off"}
          </button>
        </footer>
        {correctionOpen && (
          <div className="pbioCorrectionPanel">
            <p>
              <strong>{CORRECTION_COPY.title}</strong> {CORRECTION_COPY.body}
            </p>
            <p className="pbioCorrectionNote">{CORRECTION_COPY.prototypeNote}</p>
          </div>
        )}
      </div>
    </section>
  );
}
