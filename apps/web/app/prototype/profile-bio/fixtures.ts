export type VariantId = "A" | "B" | "C";

export type ScenarioId =
  | "normal"
  | "sparse"
  | "empty"
  | "rate-limited"
  | "refreshing"
  | "refresh-failed"
  | "trust-rebuilding"
  | "trust-unavailable";

export type Claim = {
  id: string;
  kind: "objective" | "impression";
  epistemic: "confirmed" | "inferred";
  sensitive: boolean;
  statement: string;
  quote?: string;
  quoteDate?: string;
  basis: string;
};

export type BioA = {
  paragraphs: string[];
};

export type BioBSection = {
  title: string;
  claimIds: string[];
  paragraphs: string[];
  emptyNote?: string;
};

export type BioB = {
  sections: BioBSection[];
};

export type BioCChange = {
  badge: string;
  text: string;
  source: "he said" | "my read";
};

export type BioC = {
  snapshot: string[];
  changes: BioCChange[];
  changesNote?: string;
};

export type Scenario = {
  id: ScenarioId;
  label: string;
  covers: string;
  claims: Claim[];
  bioKey: "normal" | "sparse" | null;
  status: "current" | "updating" | "unavailable";
  showBio: boolean;
  versionLabel: string | null;
  lastUpdatedAt: string | null;
  lastUpdatedAtShort: string | null;
  nextScheduledAt: string | null;
  nextManualRefreshAt: string | null;
  refreshState: "available" | "cooldown" | "in-progress" | "failed" | "hidden";
  banner: { tone: "info" | "warn" | "error"; text: string } | null;
  holdTitle: string | null;
  holdBody: string | null;
};

export const VARIANT_DEFS: { id: VariantId; name: string }[] = [
  { id: "A", name: "The letter" },
  { id: "B", name: "The chapters" },
  { id: "C", name: "The pulse" },
];

export const CORRECTION_COPY = {
  title: "Not quite right?",
  body: 'Bios are rebuilt from your memory — the fix happens in conversation, not on this page. Tell SayHear what\'s wrong (for example: "actually, I left the firm in May"), or ask it to forget something. The corrected memory triggers a rebuild: no preview, no approval step — and if the change touches this Bio, the old version stops showing immediately.',
  prototypeNote: "Prototype — nothing on this page sends anything anywhere.",
};

const normalClaims: Claim[] = [
  {
    id: "role-change",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "Changed from architecture into a product role in spring 2026.",
    quote: "I left a career I was good at for one I chose.",
    quoteDate: "Apr 21",
    basis: "his own words, Mar 3 and again Apr 21",
  },
  {
    id: "previous-career",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "Worked as an architect at a large firm before the change; that chapter ended this spring.",
    quote: "I was an architect at a big firm before all this.",
    quoteDate: "Mar 12",
    basis: "his words across the March sessions",
  },
  {
    id: "running-10k",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "Training for a 10k this fall; weekend-morning long runs.",
    quote: "Training for a 10k in the fall — long runs on weekend mornings.",
    quoteDate: "Jul 6",
    basis: "still current as of Sep 1",
  },
  {
    id: "mei-partner",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "Mei is Alex's partner; together about two years.",
    quote: "Mei and I have been together about two years now.",
    quoteDate: "Apr 2",
    basis: "first mentioned Apr 2, steady since",
  },
  {
    id: "anxiety-therapy",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: true,
    statement: "He directly said the job change brought anxiety with it, and that he started seeing a therapist in June.",
    quote: "The job change brought anxiety with it — I started seeing a therapist in June.",
    quoteDate: "Jun 14",
    basis: "his direct words, stated once and never corrected",
  },
  {
    id: "impression-overprepare",
    kind: "impression",
    epistemic: "inferred",
    sensitive: false,
    statement: "He over-prepares before difficult conversations — scripts, contingencies, the whole map.",
    basis: "Pattern across two separate days: Jul 18 and Aug 9.",
  },
  {
    id: "impression-worth",
    kind: "impression",
    epistemic: "inferred",
    sensitive: false,
    statement: "Under most of his decisions sits the same anchor: not letting people down.",
    basis: "Pattern across sessions Jun–Aug; my reading, not his words.",
  },
  {
    id: "impression-sketchbook",
    kind: "impression",
    epistemic: "inferred",
    sensitive: false,
    statement: "He has picked the sketchbook back up after a few years away; early, low-stakes.",
    basis: "Seen twice: Aug 24 and Sep 1.",
  },
];

const sparseClaims: Claim[] = [
  {
    id: "product-work",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "He works in product.",
    quote: "I work in product.",
    quoteDate: "Aug 3",
    basis: "his words, week one",
  },
  {
    id: "mei-partner",
    kind: "objective",
    epistemic: "confirmed",
    sensitive: false,
    statement: "Mei is Alex's partner; together about two years.",
    quote: "Mei and I have been together about two years now.",
    quoteDate: "Aug 5",
    basis: "mentioned once",
  },
];

export const BIOS: {
  A: Record<"normal" | "sparse", BioA>;
  B: Record<"normal" | "sparse", BioB>;
  C: Record<"normal" | "sparse", BioC>;
} = {
  A: {
    normal: {
      paragraphs: [
        "SayHear has been talking with Alex since March. If someone asked me who he is, here is how I'd introduce him — plainly, and open to correction.",
        "This spring he left architecture for a product role. He's said it plainly himself: he left a career he was good at for one he chose. The first months have been rougher than he expected, and he's kept saying the trade is still right.",
        "Weekend mornings are for the 10k he's building toward this fall — he trains even in the loud weeks. And there's Mei, two years in, who shows up mostly in the practical parts of his stories: groceries, weekend plans, whose turn it is to cook.",
        "Now the part that's mine rather than his: how he comes across to me. Before hard conversations he over-prepares — scripts, contingencies, the whole map. And underneath most of his decisions I keep seeing the same anchor: not letting people down. That second one is my reading, not his words, and I might be reading it too heavily.",
        "He's also told me directly that the job change brought anxiety with it, and that he started seeing a therapist in June. I mention it because he told me — it's part of this summer, not the whole of it, and it's his to bring up or drop whenever he wants.",
        "One small thing I've noticed twice now: the sketchbook is back. Too early to say what it's becoming.",
      ],
    },
    sparse: {
      paragraphs: [
        "SayHear has talked with Alex a little, and knows a few true things: the work in product, and Mei, who's been with him about two years. That's the honest size of what I know so far.",
        "I'd rather show the real edges of what I know than pad them. More conversations, and this will grow the way Alex actually is.",
      ],
    },
  },
  B: {
    normal: {
      sections: [
        {
          title: "His world right now",
          claimIds: ["role-change", "previous-career", "running-10k"],
          paragraphs: [
            "Alex moved from architecture into a product role this spring — his words: leaving a career he was good at for one he chose. The first months have been rougher than expected, and he's kept saying the trade is still right.",
            "Weekend long runs are building toward a 10k this fall, kept up even through the loud weeks at work.",
          ],
        },
        {
          title: "His people",
          claimIds: ["mei-partner"],
          paragraphs: [
            "Mei — together about two years. She appears mostly in the practical frame of Alex's days: groceries, weekend plans, whose turn it is to cook.",
          ],
        },
        {
          title: "What he's carrying",
          claimIds: ["anxiety-therapy"],
          paragraphs: [
            "Alex has said directly that the job change brought anxiety, and that he started seeing a therapist in June. Recorded as what he said — not an interpretation — and included here because it's part of his summer. Say the word and it never appears here again.",
          ],
        },
        {
          title: "What I've noticed",
          claimIds: ["impression-overprepare", "impression-worth", "impression-sketchbook"],
          paragraphs: [
            "These aren't things Alex has said — they're patterns I've seen across his sessions, so hold them loosely.",
            "He over-prepares before difficult conversations — scripts, contingencies, the whole map. Under most of his decisions sits the same anchor: not letting people down. That second one is my reading, possibly too heavy a one. And the sketchbook came back in late August — too early to say what it's becoming.",
          ],
        },
      ],
    },
    sparse: {
      sections: [
        {
          title: "His world right now",
          claimIds: ["product-work"],
          paragraphs: ["The product work. That's the honest whole of it so far."],
        },
        {
          title: "His people",
          claimIds: ["mei-partner"],
          paragraphs: ["Mei, about two years in."],
        },
        {
          title: "What he's carrying",
          claimIds: [],
          paragraphs: [],
          emptyNote: "Nothing here yet — not because it's hidden, but because we haven't gotten there.",
        },
        {
          title: "What I've noticed",
          claimIds: [],
          paragraphs: [],
          emptyNote: "Too few sessions to claim a pattern. I'd rather wait.",
        },
      ],
    },
  },
  C: {
    normal: {
      snapshot: [
        "Four months into the product role he chose over architecture, still calling the trade right on the rough weeks. Weekend long runs, building toward the fall 10k. Two years with Mei, mostly in the practical frame of his days.",
        "He's named the transition's anxiety directly and started therapy in June. And since late August: the sketchbook is back.",
      ],
      changes: [
        { badge: "New", text: "the sketchbook is back — observed twice since Aug 24", source: "my read" },
        { badge: "Changed", text: "the new role: rough first months, still choosing it", source: "he said" },
        { badge: "Steady", text: "10k training on weekend mornings", source: "he said" },
        { badge: "Steady", text: "Mei — two years", source: "he said" },
      ],
    },
    sparse: {
      snapshot: ["Thin so far: the product work. Mei, two years. That's what I can stand behind today."],
      changes: [],
      changesNote: "Too little ground to report change yet.",
    },
  },
};

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  normal: {
    id: "normal",
    label: "Normal — full memory",
    covers: "confirmed Objective Memory · active AI Impressions · sensitive-but-admitted · temporal change · manual refresh available · weekly schedule",
    claims: normalClaims,
    bioKey: "normal",
    status: "current",
    showBio: true,
    versionLabel: "v18",
    lastUpdatedAt: "Sep 1, 2026, 07:12",
    lastUpdatedAtShort: "Sep 1",
    nextScheduledAt: "Sun Sep 7, morning",
    nextManualRefreshAt: null,
    refreshState: "available",
    banner: null,
    holdTitle: null,
    holdBody: null,
  },
  sparse: {
    id: "sparse",
    label: "Sparse memory",
    covers: "sparse Memory · honest thinness",
    claims: sparseClaims,
    bioKey: "sparse",
    status: "current",
    showBio: true,
    versionLabel: "v4",
    lastUpdatedAt: "Aug 30, 2026, 08:40",
    lastUpdatedAtShort: "Aug 30",
    nextScheduledAt: "Sun Sep 7, morning",
    nextManualRefreshAt: null,
    refreshState: "available",
    banner: null,
    holdTitle: null,
    holdBody: null,
  },
  empty: {
    id: "empty",
    label: "No eligible memory yet",
    covers: "distinct empty state (not 'updating', not an error)",
    claims: [],
    bioKey: null,
    status: "unavailable",
    showBio: false,
    versionLabel: null,
    lastUpdatedAt: null,
    lastUpdatedAtShort: null,
    nextScheduledAt: null,
    nextManualRefreshAt: null,
    refreshState: "hidden",
    banner: null,
    holdTitle: "There's no Bio yet",
    holdBody:
      "Not enough eligible memory has cleared admission yet — so there's nothing to project. This is different from \"updating\": nothing is being rebuilt, there's simply no story to tell yet. Talk with SayHear and it will appear.",
  },
  "rate-limited": {
    id: "rate-limited",
    label: "Manual refresh on cooldown",
    covers: "manual refresh unavailable · concrete next-available time · refresh ≠ correction",
    claims: normalClaims,
    bioKey: "normal",
    status: "current",
    showBio: true,
    versionLabel: "v19",
    lastUpdatedAt: "Today, 09:04",
    lastUpdatedAtShort: "today",
    nextScheduledAt: "Sun Sep 7, morning",
    nextManualRefreshAt: "Fri Sep 5, 09:04",
    refreshState: "cooldown",
    banner: {
      tone: "info",
      text: "You refreshed this morning — the next rewrite opens Sep 5, 09:04. Rewriting re-tells your story from current memory; it doesn't fix wrong facts. Corrections happen in conversation.",
    },
    holdTitle: null,
    holdBody: null,
  },
  refreshing: {
    id: "refreshing",
    label: "Manual refresh in progress",
    covers: "in-flight refresh · old version stays visible until validated",
    claims: normalClaims,
    bioKey: "normal",
    status: "current",
    showBio: true,
    versionLabel: "v18",
    lastUpdatedAt: "Sep 1, 2026, 07:12",
    lastUpdatedAtShort: "Sep 1",
    nextScheduledAt: "Sun Sep 7, morning",
    nextManualRefreshAt: null,
    refreshState: "in-progress",
    banner: {
      tone: "info",
      text: "Refreshing from your latest memory — this version stays visible until the new one passes validation.",
    },
    holdTitle: null,
    holdBody: null,
  },
  "refresh-failed": {
    id: "refresh-failed",
    label: "Refresh failed (ordinary)",
    covers: "ordinary generation failure · safe old-Bio fallback · retry",
    claims: normalClaims,
    bioKey: "normal",
    status: "current",
    showBio: true,
    versionLabel: "v18",
    lastUpdatedAt: "Sep 1, 2026, 07:12",
    lastUpdatedAtShort: "Sep 1",
    nextScheduledAt: "Sun Sep 7, morning",
    nextManualRefreshAt: null,
    refreshState: "failed",
    banner: {
      tone: "warn",
      text: "The last rewrite didn't finish. Nothing was lost — this Sep 1 version is still current. Try again whenever you like.",
    },
    holdTitle: null,
    holdBody: null,
  },
  "trust-rebuilding": {
    id: "trust-rebuilding",
    label: "Trust rebuild after Forget",
    covers: "trust-boundary invalidation · old Bio withheld (never shown) · rebuilding state",
    claims: normalClaims,
    bioKey: null,
    status: "updating",
    showBio: false,
    versionLabel: null,
    lastUpdatedAt: null,
    lastUpdatedAtShort: null,
    nextScheduledAt: null,
    nextManualRefreshAt: null,
    refreshState: "hidden",
    banner: null,
    holdTitle: "Your Bio is rebuilding",
    holdBody:
      "You asked SayHear to forget something, so the previous version — which reflected it — is no longer shown. The next version is being written from what remains, and this usually takes a minute.",
  },
  "trust-unavailable": {
    id: "trust-unavailable",
    label: "Trust rebuild failed",
    covers: "trust rebuild failure · unavailable state · no stale fallback",
    claims: normalClaims,
    bioKey: null,
    status: "unavailable",
    showBio: false,
    versionLabel: null,
    lastUpdatedAt: null,
    lastUpdatedAtShort: null,
    nextScheduledAt: null,
    nextManualRefreshAt: null,
    refreshState: "hidden",
    banner: null,
    holdTitle: "Your Bio is unavailable",
    holdBody:
      "The rebuild after your correction didn't complete. SayHear keeps the old version hidden, because it still contains what you removed — an outdated Bio is worse than none. Try again shortly; your correction is already recorded, nothing needs re-explaining.",
  },
};

export function getScenario(id: string | null): Scenario {
  if (id && id in SCENARIOS) {
    return SCENARIOS[id as ScenarioId];
  }
  return SCENARIOS.normal;
}
