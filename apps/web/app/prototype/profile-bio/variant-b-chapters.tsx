"use client";

import { useState } from "react";

import { BIOS, CORRECTION_COPY, type Scenario } from "./fixtures";

const STATUS_LABEL = { current: "Current", updating: "Updating", unavailable: "Unavailable" } as const;

export function VariantBChapters({ scenario }: { scenario: Scenario }) {
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);

  if (!scenario.showBio) {
    return (
      <section className="pbioFile">
        <FileHeader scenario={scenario} />
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
  const bio = BIOS.B[bioKey];

  return (
    <section className="pbioFile">
      <FileHeader scenario={scenario} />
      {scenario.banner && (
        <p className={`pbioBanner pbioTone${scenario.banner.tone}`}>{scenario.banner.text}</p>
      )}
      <div className="pbioFileSections">
        {bio.sections.map((section) => {
          const claims = scenario.claims.filter((claim) => section.claimIds.includes(claim.id));
          const isOpen = openSection === section.title;
          return (
            <article key={section.title} className="pbioChapter">
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
              {section.paragraphs.length === 0 && <p className="pbioMuted">{section.emptyNote}</p>}
              {claims.length > 0 && (
                <div className="pbioChapterFooter">
                  <button type="button" onClick={() => setOpenSection(isOpen ? null : section.title)}>
                    {isOpen ? "Hide what this is based on" : "What this is based on"}
                  </button>
                </div>
              )}
              {isOpen && (
                <ul className="pbioBasisList">
                  {claims.map((claim) => (
                    <li key={claim.id}>
                      <div className="pbioClaimStatement">{claim.statement}</div>
                      {claim.quote && (
                        <div className="pbioClaimQuote">
                          “{claim.quote}”
                          {claim.quoteDate && <span className="pbioQuoteDate"> — {claim.quoteDate}</span>}
                        </div>
                      )}
                      <div className="pbioClaimMeta">
                        <span className="pbioClaimKind">
                          {claim.epistemic === "confirmed" ? "fact, as he told it" : "my impression"}
                        </span>
                        {claim.sensitive && <span className="pbioSensitiveTag"> · sensitive</span>}
                        <span> · {claim.basis}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
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
    </section>
  );
}

function FileHeader({ scenario }: { scenario: Scenario }) {
  return (
    <header className="pbioFileHeader">
      <div>
        <p className="pbioLetterEyebrow">SayHear's current understanding</p>
        <h1>How SayHear sees you</h1>
      </div>
      <span className={`pbioStatusChip pbioStatus${scenario.status}`}>{STATUS_LABEL[scenario.status]}</span>
      <div className="pbioFileMeta">
        {scenario.versionLabel && <span>{scenario.versionLabel}</span>}
        {scenario.lastUpdatedAt && <span>written {scenario.lastUpdatedAt}</span>}
        {scenario.nextScheduledAt && <span>next scheduled rewrite {scenario.nextScheduledAt}</span>}
      </div>
      <div className="pbioFileActions">
        {scenario.refreshState === "available" && <button type="button" className="pbioRefreshButton">Rewrite from current memory</button>}
        {scenario.refreshState === "in-progress" && <button type="button" className="pbioRefreshButton" disabled>Rewriting…</button>}
        {scenario.refreshState === "failed" && <button type="button" className="pbioRefreshButton">Retry the rewrite</button>}
        {scenario.refreshState === "cooldown" && (
          <button type="button" className="pbioRefreshButton" disabled>
            Rewrite available {scenario.nextManualRefreshAt}
          </button>
        )}
      </div>
    </header>
  );
}
