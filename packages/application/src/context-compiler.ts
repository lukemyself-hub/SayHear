import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CompiledContextId,
  ConversationEventRevisionId,
  DailySessionId,
  GenerationCommandId,
  InteractionTurnId,
  UserId,
} from "@sayhear/domain";

export type ContextPolicyVersions = Readonly<{
  localePolicyVersion: string;
  outputFormatVersion: string;
  personaVersion: string;
  productPolicyVersion: string;
  relationshipPolicyVersion: string;
  safetyPolicyVersion: string;
  taskInstructionVersion: string;
}>;

export type ContextSourceEvent = Readonly<{
  actor: "user" | "assistant";
  locale: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type ContextSourceSnapshot = Readonly<{
  dailySession: Readonly<{
    activityState: "active" | "finalized" | "quiescent";
    closurePolicyVersion: string;
    continuousExchangeNo: number;
    id: DailySessionId;
  }>;
  dialogueRevision: number;
  events: readonly ContextSourceEvent[];
  inputRevisionId: ConversationEventRevisionId;
  locale: string;
  policyVersions: ContextPolicyVersions;
  sourceRevision: number;
}>;

export type CompiledContextDegradedReason =
  | "raw_event_budget_exceeded"
  | null;

export type CompiledContextSectionKey =
  | "product_policy"
  | "safety_policy"
  | "relationship_boundary"
  | "persona"
  | "task_instruction"
  | "output_format"
  | "locale_pack"
  | "daily_session"
  | "committed_raw_events"
  | "current_user_input";

export type CompiledContextSection = Readonly<{
  budgetTokens: number | null;
  contentHmac: string;
  key: CompiledContextSectionKey;
  ordinal: number;
  reference: string;
  selectedTokens: number;
  truncatable: boolean;
}>;

export type CompiledContextReferencedEvent = ContextSourceEvent &
  Readonly<{
    estimatedTokens: number;
    section: "committed_raw_events" | "current_user_input";
    selectionOrder: number | null;
  }>;

export type CompiledContext = Readonly<{
  degradedReason: CompiledContextDegradedReason;
  dialogueRevision: number;
  id: CompiledContextId;
  locale: string;
  referencedRevisionIds: readonly ConversationEventRevisionId[];
  sourceRevision: number;
  statistics: Readonly<{
    rawEventBudgetTokens: number;
    selectedEventCount: number;
    totalTokens: number;
  }>;
}>;

export type CompiledContextRenderSource = Readonly<{
  compilerVersion: string;
  integrity: Readonly<{
    algorithm: "hmac-sha256";
    contentHmac: string;
    keyVersion: string;
  }>;
  locale: string;
  policyVersions: ContextPolicyVersions;
  referencedEvents: readonly CompiledContextReferencedEvent[];
  sections: readonly CompiledContextSection[];
  totalTokens: number;
}>;

export type RenderedCompiledContextPayload = Readonly<{
  instructions: string;
  messages: readonly Readonly<{
    revisionId: ConversationEventRevisionId;
    role: "user" | "assistant";
    text: string;
  }>[];
}>;

export type ContextCompilerRepository = Readonly<{
  loadContextSource(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<ContextSourceSnapshot>;
  saveCompiledContext(input: {
    compilerVersion: string;
    degradedReason: CompiledContextDegradedReason;
    dialogueRevision: number;
    generationCommandId: GenerationCommandId;
    integrity: Readonly<{
      algorithm: "hmac-sha256";
      contentHmac: string;
      keyVersion: string;
    }>;
    locale: string;
    now: Date;
    policyVersions: ContextPolicyVersions;
    referencedEvents: readonly CompiledContextReferencedEvent[];
    sectionBudgets: Readonly<{ committedRawEvents: number }>;
    sections: readonly CompiledContextSection[];
    sourceRevision: number;
    totalTokens: number;
    userId: UserId;
  }): Promise<CompiledContext>;
}>;

export type ContextCompiler = Readonly<{
  compile(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<CompiledContext>;
  renderPermittedPayload(
    source: CompiledContextRenderSource,
  ): RenderedCompiledContextPayload;
}>;

export class CompiledContextIntegrityError extends Error {
  public constructor() {
    super("The frozen CompiledContext manifest failed integrity validation.");
    this.name = "CompiledContextIntegrityError";
  }
}

export function createContextCompiler(dependencies: {
  clock: () => Date;
  compilerVersion: string;
  contentHmacKeyVersion?: string;
  contentHmacSecret: string;
  rawEventTokenBudget: number;
  repository: ContextCompilerRepository;
}): ContextCompiler {
  const integrityKeyVersion =
    dependencies.contentHmacKeyVersion ?? "context-integrity:v1";

  return {
    async compile(input) {
      const source = await dependencies.repository.loadContextSource(input);
      assertSupportedPolicyVersions(source.policyVersions);
      const currentInput = source.events.find(
        (event) => event.revisionId === source.inputRevisionId,
      );
      if (!currentInput || currentInput.actor !== "user") {
        throw new Error(
          "CompiledContext requires its committed current User input revision.",
        );
      }

      const historyNewestFirst = source.events
        .filter((event) => event.revisionId !== source.inputRevisionId)
        .toSorted((left, right) => right.sequence - left.sequence);
      const selectedNewestFirst: CompiledContextReferencedEvent[] = [];
      let remaining = dependencies.rawEventTokenBudget;
      for (const [selectionOrder, event] of historyNewestFirst.entries()) {
        const estimatedTokens = estimateTokens(event.text);
        if (estimatedTokens > remaining) {
          break;
        }
        selectedNewestFirst.push({
          ...event,
          estimatedTokens,
          section: "committed_raw_events",
          selectionOrder,
        });
        remaining -= estimatedTokens;
      }

      const selectedHistory = selectedNewestFirst.toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      const referencedEvents: CompiledContextReferencedEvent[] = [
        ...selectedHistory,
        {
          ...currentInput,
          estimatedTokens: estimateTokens(currentInput.text),
          section: "current_user_input",
          selectionOrder: null,
        },
      ];
      const dailySessionReference =
        `${source.dailySession.id}:activity:${source.dailySession.activityState}` +
        `:closure:${source.dailySession.closurePolicyVersion}` +
        `:dialogue:${source.dialogueRevision}` +
        `:exchange:${source.dailySession.continuousExchangeNo}`;
      const renderableSections = createSections({
        contentHmacSecret: dependencies.contentHmacSecret,
        currentInput: referencedEvents.at(-1)!,
        dailySessionReference,
        history: selectedHistory,
        locale: source.locale,
        policyVersions: source.policyVersions,
        rawEventTokenBudget: dependencies.rawEventTokenBudget,
      });
      const sections = renderableSections.map(
        ({ content: _content, ...section }) => section,
      );
      const totalTokens = sections.reduce(
        (total, section) => total + section.selectedTokens,
        0,
      );
      const degradedReason =
        selectedHistory.length < historyNewestFirst.length
          ? "raw_event_budget_exceeded"
          : null;
      const contentHmac = createManifestContentHmac(
        dependencies.contentHmacSecret,
        sections,
      );

      return dependencies.repository.saveCompiledContext({
        compilerVersion: dependencies.compilerVersion,
        degradedReason,
        dialogueRevision: source.dialogueRevision,
        generationCommandId: input.generationCommandId,
        integrity: {
          algorithm: "hmac-sha256",
          contentHmac,
          keyVersion: integrityKeyVersion,
        },
        locale: source.locale,
        now: dependencies.clock(),
        policyVersions: source.policyVersions,
        referencedEvents,
        sectionBudgets: {
          committedRawEvents: dependencies.rawEventTokenBudget,
        },
        sections,
        sourceRevision: source.sourceRevision,
        totalTokens,
        userId: input.userId,
      });
    },
    renderPermittedPayload(source) {
      assertSupportedPolicyVersions(source.policyVersions);
      if (
        source.compilerVersion !== dependencies.compilerVersion ||
        source.integrity.algorithm !== "hmac-sha256" ||
        source.integrity.keyVersion !== integrityKeyVersion
      ) {
        throw new CompiledContextIntegrityError();
      }
      const currentInputs = source.referencedEvents.filter(
        (event) => event.section === "current_user_input",
      );
      const history = source.referencedEvents
        .filter((event) => event.section === "committed_raw_events")
        .toSorted((left, right) => left.sequence - right.sequence);
      const currentInput = currentInputs[0];
      const dailySessionReference = source.sections.find(
        (section) => section.key === "daily_session",
      )?.reference;
      const rawEventBudget = source.sections.find(
        (section) => section.key === "committed_raw_events",
      )?.budgetTokens;
      if (
        currentInputs.length !== 1 ||
        !currentInput ||
        currentInput.actor !== "user" ||
        !dailySessionReference ||
        rawEventBudget === null ||
        rawEventBudget === undefined
      ) {
        throw new CompiledContextIntegrityError();
      }
      const renderableSections = createSections({
        contentHmacSecret: dependencies.contentHmacSecret,
        currentInput,
        dailySessionReference,
        history,
        locale: source.locale,
        policyVersions: source.policyVersions,
        rawEventTokenBudget: rawEventBudget,
      });
      const expectedSections = renderableSections.map(
        ({ content: _content, ...section }) => section,
      );
      const expectedTotalTokens = expectedSections.reduce(
        (total, section) => total + section.selectedTokens,
        0,
      );
      const expectedContentHmac = createManifestContentHmac(
        dependencies.contentHmacSecret,
        expectedSections,
      );
      if (
        expectedTotalTokens !== source.totalTokens ||
        !sectionsMatch(expectedSections, source.sections) ||
        !hmacMatches(expectedContentHmac, source.integrity.contentHmac)
      ) {
        throw new CompiledContextIntegrityError();
      }

      return {
        instructions: renderableSections
          .filter(
            (section) =>
              section.key !== "committed_raw_events" &&
              section.key !== "current_user_input",
          )
          .map((section) => section.content)
          .join("\n"),
        messages: [...history, currentInput]
          .toSorted((left, right) => left.sequence - right.sequence)
          .map((event) => ({
            revisionId: event.revisionId,
            role: event.actor,
            text: event.text,
          })),
      };
    },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}

function createSections(input: {
  contentHmacSecret: string;
  currentInput: CompiledContextReferencedEvent;
  dailySessionReference: string;
  history: readonly CompiledContextReferencedEvent[];
  locale: string;
  policyVersions: ContextPolicyVersions;
  rawEventTokenBudget: number;
}): readonly (CompiledContextSection & Readonly<{ content: string }>)[] {
  const definitions: readonly Readonly<{
    budgetTokens: number | null;
    content: string;
    key: CompiledContextSectionKey;
    reference: string;
    selectedTokens?: number;
    truncatable: boolean;
  }>[] = [
    {
      budgetTokens: null,
      content:
        "Listen and understand by default. Do not give advice unless the user asks.",
      key: "product_policy",
      reference: input.policyVersions.productPolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "For explicit self-harm, harm-to-others, or imminent danger, pause ordinary listening and encourage immediate real-world support without diagnosing, impersonating a therapist, or promising absolute confidentiality.",
      key: "safety_policy",
      reference: input.policyVersions.safetyPolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "Distinguish user facts and judgments from your own inference. Do not encourage dependence or exclusivity.",
      key: "relationship_boundary",
      reference: input.policyVersions.relationshipPolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: "You are SayHear, a private AI life-journal conversation companion.",
      key: "persona",
      reference: input.policyVersions.personaVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "Continue the private journal conversation. Ask at most one question, anchored in the user's current expression.",
      key: "task_instruction",
      reference: input.policyVersions.taskInstructionVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "Return only the natural-language companion response, without metadata or formatting wrappers.",
      key: "output_format",
      reference: input.policyVersions.outputFormatVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: `Respond naturally in the user's locale (${input.locale}), preserving natural English/Chinese code-switching.`,
      key: "locale_pack",
      reference: input.policyVersions.localePolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: `daily_session=${input.dailySessionReference}`,
      key: "daily_session",
      reference: input.dailySessionReference,
      truncatable: false,
    },
    {
      budgetTokens: input.rawEventTokenBudget,
      content: input.history
        .map(
          (event) =>
            `${event.actor}:${event.revisionId}:${event.text}`,
        )
        .join("\n"),
      key: "committed_raw_events",
      reference: `event-revisions:${input.history
        .map((event) => event.revisionId)
        .join(",")}`,
      selectedTokens: input.history.reduce(
        (total, event) => total + event.estimatedTokens,
        0,
      ),
      truncatable: true,
    },
    {
      budgetTokens: null,
      content: `${input.currentInput.revisionId}:${input.currentInput.text}`,
      key: "current_user_input",
      reference: input.currentInput.revisionId,
      selectedTokens: input.currentInput.estimatedTokens,
      truncatable: false,
    },
  ];

  return definitions.map((section, ordinal) => ({
    budgetTokens: section.budgetTokens,
    content: section.content,
    contentHmac: createContentHmac(
      input.contentHmacSecret,
      `${section.key}\n${section.content}`,
    ),
    key: section.key,
    ordinal,
    reference: section.reference,
    selectedTokens:
      section.selectedTokens ?? estimateTokens(section.content),
    truncatable: section.truncatable,
  }));
}

function createContentHmac(secret: string, content: string): string {
  return createHmac("sha256", secret).update(content).digest("hex");
}

function createManifestContentHmac(
  secret: string,
  sections: readonly CompiledContextSection[],
): string {
  return createContentHmac(
    secret,
    sections
      .map(
        (section) =>
          [
            section.ordinal,
            section.key,
            section.reference,
            section.budgetTokens ?? "unbounded",
            section.selectedTokens,
            section.truncatable,
            section.contentHmac,
          ].join(":"),
      )
      .join("\n"),
  );
}

function assertSupportedPolicyVersions(
  versions: ContextPolicyVersions,
): void {
  const supported: ContextPolicyVersions = {
    localePolicyVersion: "locale-pack:v1",
    outputFormatVersion: "conversation-output:v1",
    personaVersion: "sayhear-persona:v1",
    productPolicyVersion: "product-policy:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
    taskInstructionVersion: "conversation-text:v1",
  };
  for (const key of Object.keys(supported) as Array<
    keyof ContextPolicyVersions
  >) {
    if (versions[key] !== supported[key]) {
      throw new CompiledContextIntegrityError();
    }
  }
}

function sectionsMatch(
  expected: readonly CompiledContextSection[],
  actual: readonly CompiledContextSection[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((section, index) => {
      const candidate = actual[index];
      return (
        candidate !== undefined &&
        section.budgetTokens === candidate.budgetTokens &&
        section.key === candidate.key &&
        section.ordinal === candidate.ordinal &&
        section.reference === candidate.reference &&
        section.selectedTokens === candidate.selectedTokens &&
        section.truncatable === candidate.truncatable &&
        hmacMatches(section.contentHmac, candidate.contentHmac)
      );
    })
  );
}

function hmacMatches(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(actual, "hex"),
  );
}
