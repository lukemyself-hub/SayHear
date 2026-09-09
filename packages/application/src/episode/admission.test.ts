import { describe, expect, it } from "vitest";

import {
  asDailySessionId,
  asEpisodeId,
  asEvidenceItemId,
  asUserId,
} from "@sayhear/domain";

import {
  boundaryWindow,
  boundaryWindowsOverlap,
  episodeDedupeFingerprint,
  episodeSemanticTarget,
  evaluateEpisodeMaterialChange,
  normalizeEpisodeKind,
  planEpisodeAdmission,
  planEpisodeRejectionDisposition,
  planEpisodeStaleDisposition,
} from "./admission";
import type { EpisodeBuildModelRequest, EpisodeProposal } from "./types";

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");

function episodeUuid(suffix: string | number) {
  return `01990000-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function evidenceInput(itemId: string | number, sourceText: string) {
  return {
    evidenceItemId: asEvidenceItemId(episodeUuid(itemId)),
    locatorType: "text_span",
    locatorKey: `0:${sourceText.length}`,
    sourceText,
    locale: "en",
  };
}

function buildRequest(
  overrides: Partial<EpisodeBuildModelRequest> = {},
): EpisodeBuildModelRequest {
  return {
    userId,
    dailySessionId: asDailySessionId(episodeUuid(1)),
    sourceRevision: 3,
    kindCatalog: [
      "sh.episode.trip",
      "sh.episode.relocation",
      "sh.episode.project_phase",
      "sh.episode.occurrence",
      "sh.episode.other",
    ],
    evidence: [],
    activeEpisodes: [],
    ...overrides,
  };
}

function baseProposal(
  overrides: Partial<EpisodeProposal> = {},
): EpisodeProposal {
  return {
    proposedKind: "sh.episode.trip",
    label: "Tokyo business trip",
    temporalAnchor: { start: { date: "2026-03-10", precision: "exact" } },
    phase: "planned",
    kindFields: { destination: "Tokyo" },
    citedEvidenceItemIds: [asEvidenceItemId(episodeUuid(1))],
    realWorldOccurrence: true,
    ...overrides,
  };
}

const tripEpisode = (suffix: string | number) => asEpisodeId(episodeUuid(suffix));

describe("deterministic episode admission", () => {
  it("downgrades an unmapped kind to the other catch-all", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "I fly to Tokyo next Monday")],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({ proposedKind: "sh.episode.vacation" }),
      request,
    });
    expect(plan.action).toBe("create_episode");
    expect(plan.kind).toBe("sh.episode.other");
  });

  it("keeps every catalog kind including other", () => {
    expect(normalizeEpisodeKind("sh.episode.trip")).toBe("sh.episode.trip");
    expect(normalizeEpisodeKind("sh.episode.other")).toBe("sh.episode.other");
  });

  it("rejects proposals with no cited evidence", () => {
    const plan = planEpisodeAdmission({
      proposal: baseProposal({ citedEvidenceItemIds: [] }),
      request: buildRequest(),
    });
    expect(plan).toMatchObject({
      action: "reject",
      rejectionCode: "cited_evidence_missing",
    });
  });

  it("rejects citations outside the frozen evidence snapshot", () => {
    const plan = planEpisodeAdmission({
      proposal: baseProposal(),
      request: buildRequest({
        evidence: [evidenceInput(2, "unrelated text")],
      }),
    });
    expect(plan).toMatchObject({
      action: "reject",
      rejectionCode: "evidence_ineligible",
    });
  });

  it("rejects a topic or emotion expression without a real-world anchor", () => {
    const plan = planEpisodeAdmission({
      proposal: baseProposal({
        realWorldOccurrence: false,
        citedEvidenceItemIds: [asEvidenceItemId(episodeUuid(1))],
      }),
      request: buildRequest({
        evidence: [evidenceInput(1, "work has been exhausting lately")],
      }),
    });
    expect(plan).toMatchObject({
      action: "reject",
      rejectionCode: "no_real_world_anchor",
    });
  });

  it("rejects coarse anchors silently completed into exact dates", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "I move to Osaka this spring")],
    });
    expect(
      planEpisodeAdmission({
        proposal: baseProposal({
          temporalAnchor: { start: { precision: "exact" } },
        }),
        request,
      }),
    ).toMatchObject({ action: "reject", rejectionCode: "temporal_anchor_invalid" });
    expect(
      planEpisodeAdmission({
        proposal: baseProposal({
          temporalAnchor: { start: { date: "2026-03-10", precision: "unknown" } },
        }),
        request,
      }),
    ).toMatchObject({ action: "reject", rejectionCode: "temporal_anchor_invalid" });
    expect(
      planEpisodeAdmission({
        proposal: baseProposal({
          temporalAnchor: { start: { date: "2026-13-01", precision: "month" } },
        }),
        request,
      }),
    ).toMatchObject({ action: "reject", rejectionCode: "temporal_anchor_invalid" });
  });

  it("rejects typed fields outside the kind schema", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "I fly to Tokyo next Monday")],
    });
    expect(
      planEpisodeAdmission({
        proposal: baseProposal({ kindFields: { jetlag: "severe" } }),
        request,
      }),
    ).toMatchObject({ action: "reject", rejectionCode: "typed_field_invalid" });
    expect(
      planEpisodeAdmission({
        proposal: baseProposal({
          kindFields: { destination: 7 } as unknown as Record<string, string>,
        }),
        request,
      }),
    ).toMatchObject({ action: "reject", rejectionCode: "typed_field_invalid" });
  });

  it("rejects entity anchors that do not resolve to active owner entities", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "I fly to Tokyo next Monday")],
      activeEpisodes: [
        {
          episodeId: tripEpisode(2),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" } },
          entityAnchorIds: [],
          label: "Tokyo trip",
        },
      ],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({ entityAnchorIds: ["missing-entity"] }),
      resolvableEntityIds: [tripEpisode(3)],
      request,
    });
    expect(plan).toMatchObject({
      action: "reject",
      rejectionCode: "entity_anchor_ambiguous",
    });
  });

  it("creates a new episode when no active episode can match", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "I fly to Tokyo next Monday")],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal(),
      request,
    });
    expect(plan).toMatchObject({
      action: "create_episode",
      resolutionStatus: "new",
      kind: "sh.episode.trip",
    });
  });

  it("continues the unique overlapping episode and never rewrites old content", () => {
    const existingEpisodeId = tripEpisode("3");
    const request = buildRequest({
      evidence: [
        evidenceInput(1, "The second day in Tokyo we met the client"),
      ],
      activeEpisodes: [
        {
          episodeId: existingEpisodeId,
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" }, end: { date: "2026-03-15", precision: "exact" } },
          entityAnchorIds: [],
          label: "Tokyo business trip",
        },
      ],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({
        temporalAnchor: { start: { date: "2026-03-11", precision: "exact" } },
        phase: "ongoing",
      }),
      request,
    });
    expect(plan).toMatchObject({
      action: "continue_episode",
      episodeId: existingEpisodeId,
      resolutionStatus: "matched",
    });
  });

  it("keeps an ambiguous two-hit candidate unresolved without merging", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "Another day walking around Tokyo")],
      activeEpisodes: [
        {
          episodeId: tripEpisode(4),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" }, end: { date: "2026-03-15", precision: "exact" } },
          entityAnchorIds: [],
          label: "March Tokyo trip",
        },
        {
          episodeId: tripEpisode(5),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-12", precision: "exact" }, end: { date: "2026-03-20", precision: "exact" } },
          entityAnchorIds: [],
          label: "Later Tokyo trip",
        },
      ],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({ temporalAnchor: { start: { date: "2026-03-13", precision: "exact" } } }),
      request,
    });
    expect(plan).toMatchObject({
      action: "stay_unresolved",
      resolutionStatus: "unresolved",
    });
  });

  it("continues through an explicit continuity span when anchors are too coarse", () => {
    const request = buildRequest({
      evidence: [
        evidenceInput(1, "The second day of the Tokyo trip we met the client"),
      ],
      activeEpisodes: [
        {
          episodeId: tripEpisode(6),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" } },
          entityAnchorIds: [],
          label: "Tokyo business trip",
        },
      ],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({
        temporalAnchor: { start: { precision: "unknown" } },
        explicitContinuity: {
          evidenceItemId: asEvidenceItemId(episodeUuid(1)),
          span: "second day of the Tokyo trip",
        },
      }),
      request,
    });
    expect(plan).toMatchObject({
      action: "continue_episode",
      episodeId: tripEpisode(6),
      resolutionStatus: "matched",
      explicitContinuitySpan: "second day of the Tokyo trip",
    });
  });

  it("stays unresolved when an invalid continuity span falls back to ambiguity", () => {
    const request = buildRequest({
      evidence: [evidenceInput(1, "Another day in a different city")],
      activeEpisodes: [
        {
          episodeId: tripEpisode(7),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" } },
          entityAnchorIds: [],
          label: "Tokyo trip",
        },
        {
          episodeId: tripEpisode(8),
          kind: "sh.episode.trip",
          temporalAnchor: { start: { date: "2026-03-12", precision: "exact" } },
          entityAnchorIds: [],
          label: "Second Tokyo trip",
        },
      ],
    });
    const plan = planEpisodeAdmission({
      proposal: baseProposal({
        temporalAnchor: { start: { date: "2026-03-14", precision: "exact" } },
        explicitContinuity: {
          evidenceItemId: asEvidenceItemId(episodeUuid(1)),
          span: "span that never appears in the source",
        },
      }),
      request,
    });
    expect(plan).toMatchObject({
      action: "stay_unresolved",
      resolutionStatus: "unresolved",
    });
  });
});

describe("episode boundary windows", () => {
  it("expands month and year precision without inventing precision", () => {
    expect(boundaryWindow({ date: "2026-03", precision: "month" })).toEqual({
      lo: "2026-03-01",
      hi: "2026-03-31",
    });
    expect(boundaryWindow({ date: "2026", precision: "year" })).toEqual({
      lo: "2026-01-01",
      hi: "2026-12-31",
    });
    expect(
      boundaryWindow({ precision: "unknown" }),
    ).toBeNull();
    expect(
      boundaryWindow({ precision: "approximate" }),
    ).toBeNull();
  });

  it("only overlaps when windows provably intersect", () => {
    expect(
      boundaryWindowsOverlap(
        { date: "2026-03", precision: "month" },
        { date: "2026-03-15", precision: "exact" },
      ),
    ).toBe(true);
    expect(
      boundaryWindowsOverlap(
        { date: "2026-03", precision: "month" },
        { date: "2026-04-01", precision: "exact" },
      ),
    ).toBe(false);
    expect(
      boundaryWindowsOverlap(
        { precision: "unknown" },
        { date: "2026-03-15", precision: "exact" },
      ),
    ).toBe(false);
  });
});

describe("episode dedupe fingerprint and successor rules", () => {
  it("is stable for identical semantic targets and evidence sets", () => {
    const semanticTarget = episodeSemanticTarget({
      kind: "sh.episode.trip",
      plan: {
        action: "create_episode",
        kind: "sh.episode.trip",
        content: {
          kind: "sh.episode.trip",
          label: "x",
          temporalAnchor: { start: { date: "2026-03-10", precision: "exact" } },
          phase: "planned",
          kindFields: {},
        },
        resolutionStatus: "new",
      },
      proposal: baseProposal(),
      entityAnchorIds: ["entity-b", "entity-a"],
    });
    expect(semanticTarget).toContain("sh.episode.trip|new");
    const fingerprint = episodeDedupeFingerprint({
      userId,
      semanticTarget,
      evidenceRevisionIds: ["rev-2", "rev-1"],
      policyVersion: "episode-admission:v1",
      secret: "test-secret",
    });
    const repeated = episodeDedupeFingerprint({
      userId,
      semanticTarget,
      evidenceRevisionIds: ["rev-1", "rev-2"],
      policyVersion: "episode-admission:v1",
      secret: "test-secret",
    });
    expect(fingerprint).toBe(repeated);
    const changed = episodeDedupeFingerprint({
      userId,
      semanticTarget,
      evidenceRevisionIds: ["rev-1", "rev-3"],
      policyVersion: "episode-admission:v1",
      secret: "test-secret",
    });
    expect(changed).not.toBe(fingerprint);
  });

  it("treats only unseen evidence revisions as materially new", () => {
    expect(
      evaluateEpisodeMaterialChange({
        predecessorEvidenceRevisionIds: ["rev-1", "rev-2"],
        proposalEvidenceRevisionIds: ["rev-1", "rev-3"],
      }),
    ).toMatchObject({ materiallyNew: true });
    expect(
      evaluateEpisodeMaterialChange({
        predecessorEvidenceRevisionIds: ["rev-1", "rev-2"],
        proposalEvidenceRevisionIds: ["rev-2", "rev-1"],
      }),
    ).toMatchObject({ materiallyNew: false });
  });

  it("stale dispositions keep the original deadline, not the sweeper time", () => {
    const originalDeadline = new Date("2026-09-01T00:00:00Z");
    const now = new Date("2026-09-09T00:00:00Z");
    const plan = planEpisodeStaleDisposition({
      now,
      originalDeadline,
      userId,
      semanticTarget: "sh.episode.trip|new|2026-03-10|exact|",
      evidenceRevisionIds: ["rev-1"],
      policyVersion: "episode-admission:v1",
      secret: "test-secret",
    });
    expect(plan.terminalEffectiveAt).toEqual(originalDeadline);
    expect(plan.terminalContentExpiresAt).toEqual(
      new Date("2026-09-08T00:00:00Z"),
    );
  });

  it("rejection dispositions run from the decision time", () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const plan = planEpisodeRejectionDisposition({
      now,
      rejectionCode: "no_real_world_anchor",
      userId,
      semanticTarget: "sh.episode.trip|new|2026-03-10|exact|",
      evidenceRevisionIds: ["rev-1"],
      policyVersion: "episode-admission:v1",
      secret: "test-secret",
    });
    expect(plan.terminalEffectiveAt).toEqual(now);
    expect(plan.dispositionReasonCode).toBe("no_real_world_anchor");
  });
});
