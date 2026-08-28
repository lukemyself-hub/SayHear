import { describe, expect, it } from "vitest";

import { loadPredicateRegistrySnapshot } from "../predicate-registry/index";
import {
  buildRetrievalQuery,
} from "./query-construction";
import {
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  type RetrievalQueryConstructionSources,
  type RetrievalRegistryMaterial,
} from "./types";

const registrySnapshot = loadPredicateRegistrySnapshot(1);
const registry: RetrievalRegistryMaterial = {
  registryVersion: registrySnapshot.registryVersion,
  entryFor(predicateId) {
    return (
      registrySnapshot.entries.find(
        (entry) => entry.predicateId === predicateId,
    ) ?? null
    );
  },
  localizations: registrySnapshot.localizations,
};

function sources(
  overrides: Partial<RetrievalQueryConstructionSources> = {},
): RetrievalQueryConstructionSources {
  return {
    currentInput: { revisionId: "rev-current", text: "" },
    priorUserEvents: [],
    currentTopic: null,
    dialogueRevision: 4,
    selfEntityId: "entity-self",
    labelIndex: [],
    resolverHints: [],
    ...overrides,
  };
}

const registryMaterial = registry;

describe("buildRetrievalQuery", () => {
  it("resolves entities through uniquely matching current labels", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "小王今天来过吗" },
        labelIndex: [
          { entityId: "entity-wang", label: "小王", labelKind: "primary", locale: "zh" },
          { entityId: "entity-li", label: "小李", labelKind: "primary", locale: "zh" },
        ],
      }),
      registry: registryMaterial,
    });
    expect(query.resolvedEntities).toEqual([
      { entityId: "entity-wang", basis: "label", surface: "小王" },
    ]);
    expect(query.lexicalTerms).toContain("小王");
    expect(query.sourceRefs).toContainEqual({
      kind: "current_user_event",
      revisionId: "rev-current",
    });
  });

  it("does not resolve an ambiguous label shared by two entities", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "王老师是谁" },
        labelIndex: [
          { entityId: "entity-a", label: "王老师", labelKind: "primary", locale: "zh" },
          { entityId: "entity-b", label: "王老师", labelKind: "alias", locale: "zh" },
        ],
      }),
      registry: registryMaterial,
    });
    expect(query.resolvedEntities).toEqual([]);
  });

  it("resolves entities through validated resolver hints", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "我哥哥说明天回来" },
        resolverHints: [
          { entityId: "entity-brother", phrase: "哥哥", locale: "zh" },
        ],
      }),
      registry: registryMaterial,
    });
    expect(query.resolvedEntities).toEqual([
      { entityId: "entity-brother", basis: "resolver_hint", surface: "哥哥" },
    ]);
  });

  it("uses prior exchange user events but never assistant events as sources", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-3", text: "他呢" },
        priorUserEvents: [
          { revisionId: "rev-2", text: "我同事小周升职了" },
          { revisionId: "rev-1", text: "上次聊过" },
        ],
      }),
      registry: registryMaterial,
    });
    expect(query.userTexts).toEqual(["他呢", "我同事小周升职了", "上次聊过"]);
    expect(query.sourceRefs).toContainEqual({
      kind: "exchange_user_event",
      revisionId: "rev-2",
      ordinal: 1,
    });
    expect(query.sourceRefs).toContainEqual({
      kind: "exchange_user_event",
      revisionId: "rev-1",
      ordinal: 2,
    });
    // The time word arrives through a prior user event.
    expect(query.timeWordClasses).toContain("last_time");
  });

  it("feeds source-valid current_topic terms but records the dialogue revision", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "嗯嗯" },
        currentTopic: "搬家",
        dialogueRevision: 6,
      }),
      registry: registryMaterial,
    });
    expect(query.lexicalTerms).toContain("搬家");
    expect(query.sourceRefs).toContainEqual({
      kind: "current_topic",
      dialogueRevision: 6,
    });
  });

  it("matches published registry lexical aliases into predicate candidates", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "我同事帮我搬家" },
      }),
      registry: registryMaterial,
    });
    const surfaces = query.predicateCandidates.map((c) => c.predicateId);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(query.lexicalTerms.length).toBeGreaterThan(0);
    expect(query.sourceRefs).toContainEqual({
      kind: "registry_lexical_alias",
      registryVersion: registrySnapshot.registryVersion,
    });
  });

  it("computes canonical keys for self-subject predicates with resolved object entities", () => {
    const colleague = queryWithText("我同事小王帮我搬家");
    expect(colleague.canonicalKeys.length).toBeGreaterThan(0);
    expect(colleague.canonicalKeys.every((key) => key.startsWith("v1|"))).toBe(true);

    function queryWithText(text: string) {
      return buildRetrievalQuery({
        sources: sources({
          currentInput: { revisionId: "rev-current", text },
          labelIndex: [
            { entityId: "entity-wang", label: "小王", labelKind: "primary", locale: "zh" },
          ],
        }),
        registry: registryMaterial,
      });
    }
  });

  it("extracts time words and explicit date tokens", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "2023年夏天以前我住在上海" },
      }),
      registry: registryMaterial,
    });
    expect(query.timeWordClasses).toContain("past");
    expect(query.dateTokens).toContain("2023");
  });

  it("marks zero signal when no lane has any input", () => {
    const query = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "。。。" },
      }),
      registry: registryMaterial,
    });
    expect(query.lanePlan.map((lane) => lane.enabled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(query.zeroSignal).toBe(true);
  });

  it("enables the english lane only when ascii word content exists", () => {
    const withEnglish = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "my colleague helped" },
      }),
      registry: registryMaterial,
    });
    expect(withEnglish.lanePlan[2]).toEqual({
      lane: "english_fts",
      enabled: true,
      notEnabledReason: null,
    });

    const chineseOnly = buildRetrievalQuery({
      sources: sources({
        currentInput: { revisionId: "rev-current", text: "同事帮忙搬家" },
      }),
      registry: registryMaterial,
    });
    expect(chineseOnly.lanePlan[2]?.enabled).toBe(false);
  });

  it("carries the query-construction policy version", () => {
    const query = buildRetrievalQuery({
      sources: sources(),
      registry: registryMaterial,
    });
    expect(query.policyVersion).toBe(RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION);
  });
});
