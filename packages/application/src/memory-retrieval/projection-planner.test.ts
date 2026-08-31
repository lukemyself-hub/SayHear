import { describe, expect, it } from "vitest";

import { loadPredicateRegistrySnapshot } from "../predicate-registry/index";
import { planClaimRetrievalProjections } from "./projection-planner";
import {
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  normalizeRetrievalTerm,
} from "./types";

const snapshot = loadPredicateRegistrySnapshot(1);

function entryFor(predicateId: string) {
  const entry = snapshot.entries.find(
    (candidate) => candidate.predicateId === predicateId,
  );
  if (!entry) throw new Error(`missing registry entry ${predicateId}`);
  return entry;
}

function localizationsFor(predicateId: string) {
  return snapshot.localizations.filter(
    (localization) => localization.predicateId === predicateId,
  );
}

const labels = {
  "entity-self": {
    zh: "我",
    en: "Luke",
    aliases: ["阿卢"],
  },
  "entity-wang": {
    zh: "小王",
    en: "Wang",
    aliases: ["王工"],
  },
};

describe("planClaimRetrievalProjections", () => {
  it("projects one row per locale for a self-subject objective claim", () => {
    const entry = entryFor("sh.place.residence");
    const rows = planClaimRetrievalProjections({
      entry,
      localizations: localizationsFor("sh.place.residence"),
      claim: {
        memoryClaimId: "claim-1",
        predicateId: "sh.place.residence",
        subjectEntityId: "entity-self",
        objectEntityId: null,
      },
      version: {
        memoryClaimVersionId: "version-1",
        kind: "objective",
        typedValue: "上海",
        temporal: {
          temporalStatus: "current",
          validFrom: new Date("2023-06-01T00:00:00Z"),
          validFromPrecision: "exact",
          validTo: null,
          validToPrecision: "unknown",
        },
      },
      labels,
    });
    expect(rows.map((row) => row.locale).sort()).toEqual(["en", "zh"]);
    expect(rows.every((row) => row.viewDirection === "self")).toBe(true);
    expect(rows.every((row) => row.status === "active")).toBe(true);
    const zh = rows.find((row) => row.locale === "zh")!;
    expect(zh.retrievalText).toContain("上海");
    expect(zh.retrievalText).toContain("居住地");
    const terms = rows.flatMap((row) => row.lexicalTerms);
    expect(terms).toContain("上海");
    expect(terms).toContain("Luke".toLowerCase());
    expect(terms).toContain("阿卢".toLowerCase());
    expect(terms).toContain("2023");
  });

  it("uses the forward view direction for directed relationship claims and includes both parties", () => {
    const predicateId = "sh.relationship.manager_of";
    const rows = planClaimRetrievalProjections({
      entry: entryFor(predicateId),
      localizations: localizationsFor(predicateId),
      claim: {
        memoryClaimId: "claim-2",
        predicateId,
        subjectEntityId: "entity-self",
        objectEntityId: "entity-wang",
      },
      version: {
        memoryClaimVersionId: "version-2",
        kind: "objective",
        typedValue: "",
        temporal: {
          temporalStatus: "current",
          validFrom: null,
          validFromPrecision: "unknown",
          validTo: null,
          validToPrecision: "unknown",
        },
      },
      labels,
    });
    expect(rows.every((row) => row.viewDirection === "forward")).toBe(true);
    const terms = rows.flatMap((row) => row.lexicalTerms);
    expect(terms).toContain("小王");
    expect(terms).toContain("王工");
    expect(terms).toContain(normalizeRetrievalTerm("上司"));
    const zh = rows.find((row) => row.locale === "zh")!;
    expect(zh.retrievalText).toContain("小王");
  });

  it("renders the self subject as a stable owner reference, never its id", () => {
    // Issue #126 evidence runs: the Self Entity carries no label by design,
    // so every self-subject claim rendered as a bare UUID in recallable
    // text. The owner reference is quotable; it must never become a lexical
    // term (it would make every self-subject claim match every query).
    const predicateId = "sh.relationship.partner_of";
    const rows = planClaimRetrievalProjections({
      entry: entryFor(predicateId),
      localizations: localizationsFor(predicateId),
      claim: {
        memoryClaimId: "claim-self",
        predicateId,
        subjectEntityId: "entity-owner",
        objectEntityId: "entity-wang",
      },
      version: {
        memoryClaimVersionId: "version-self",
        kind: "objective",
        typedValue: "",
        temporal: {
          temporalStatus: "current",
          validFrom: null,
          validFromPrecision: "unknown",
          validTo: null,
          validToPrecision: "unknown",
        },
      },
      labels: {
        "entity-wang": labels["entity-wang"]!,
      },
      selfEntityId: "entity-owner",
    });
    const zh = rows.find((row) => row.locale === "zh")!;
    expect(zh.retrievalText).toContain("用户与小王");
    expect(zh.retrievalText).not.toContain("entity-owner");
    const en = rows.find((row) => row.locale === "en")!;
    expect(en.retrievalText).toContain("the user and Wang");
    expect(rows.flatMap((row) => row.lexicalTerms)).not.toContain("用户");
    expect(rows.flatMap((row) => row.lexicalTerms)).not.toContain("the user");
  });

  it("marks ended temporality in the retrieval text", () => {
    const predicateId = "sh.relationship.colleague_of";
    const rows = planClaimRetrievalProjections({
      entry: entryFor(predicateId),
      localizations: localizationsFor(predicateId),
      claim: {
        memoryClaimId: "claim-3",
        predicateId,
        subjectEntityId: "entity-self",
        objectEntityId: "entity-wang",
      },
      version: {
        memoryClaimVersionId: "version-3",
        kind: "objective",
        typedValue: "",
        temporal: {
          temporalStatus: "ended",
          validFrom: new Date("2020-01-01T00:00:00Z"),
          validFromPrecision: "exact",
          validTo: new Date("2023-01-01T00:00:00Z"),
          validToPrecision: "exact",
        },
      },
      labels,
    });
    const zh = rows.find((row) => row.locale === "zh")!;
    expect(zh.retrievalText).toContain("已结束");
    const en = rows.find((row) => row.locale === "en")!;
    expect(en.retrievalText).toContain("ended");
    expect(rows.flatMap((row) => row.lexicalTerms)).toContain("2020");
  });

  it("spreads array typed values into lexical terms", () => {
    const entry = entryFor("sh.project.participation");
    const rows = planClaimRetrievalProjections({
      entry,
      localizations: localizationsFor("sh.project.participation"),
      claim: {
        memoryClaimId: "claim-4",
        predicateId: "sh.project.participation",
        subjectEntityId: "entity-self",
        objectEntityId: null,
      },
      version: {
        memoryClaimVersionId: "version-4",
        kind: "objective",
        typedValue: ["北极星计划", "青禾计划"],
        temporal: {
          temporalStatus: "current",
          validFrom: null,
          validFromPrecision: "unknown",
          validTo: null,
          validToPrecision: "unknown",
        },
      },
      labels,
    });
    const terms = rows.flatMap((row) => row.lexicalTerms);
    expect(terms).toContain("北极星计划");
    expect(terms).toContain("青禾计划");
  });

  it("carries the projection policy version and normalizes every term", () => {
    const predicateId = "sh.place.residence";
    const rows = planClaimRetrievalProjections({
      entry: entryFor(predicateId),
      localizations: localizationsFor(predicateId),
      claim: {
        memoryClaimId: "claim-5",
        predicateId,
        subjectEntityId: "entity-self",
        objectEntityId: null,
      },
      version: {
        memoryClaimVersionId: "version-5",
        kind: "objective",
        typedValue: "上海",
        temporal: {
          temporalStatus: "current",
          validFrom: null,
          validFromPrecision: "unknown",
          validTo: null,
          validToPrecision: "unknown",
        },
      },
      labels,
    });
    expect(
      rows.every(
        (row) => row.projectionPolicyVersion === CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
      ),
    ).toBe(true);
    expect(
      rows.every((row) =>
        row.lexicalTerms.every(
          (term) => term === normalizeRetrievalTerm(term) && term !== "",
        ),
      ),
    ).toBe(true);
    expect(rows.every((row) => row.retrievalText !== "")).toBe(true);
  });
});
