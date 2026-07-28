import { createHmac } from "node:crypto";

import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  UserId,
} from "@sayhear/domain";

export type ContextSourceEvent = Readonly<{
  actor: "user" | "assistant";
  locale: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type ContextSourceSnapshot = Readonly<{
  dialogueRevision: number;
  events: readonly ContextSourceEvent[];
  inputRevisionId: ConversationEventRevisionId;
  locale: string;
  sourceRevision: number;
}>;

export type CompiledContext = Readonly<{
  id: CompiledContextId;
  referencedRevisionIds: readonly ConversationEventRevisionId[];
}>;

export type ContextCompilerRepository = Readonly<{
  loadContextSource(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<ContextSourceSnapshot>;
  saveCompiledContext(input: {
    compilerVersion: string;
    contentHmac: string;
    degradedReason: "raw_event_budget_exceeded" | null;
    dialogueRevision: number;
    generationCommandId: GenerationCommandId;
    locale: string;
    now: Date;
    referencedEvents: readonly (ContextSourceEvent & {
      estimatedTokens: number;
    })[];
    sectionBudgets: Readonly<{ committedRawEvents: number }>;
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
}>;

export function createContextCompiler(dependencies: {
  clock: () => Date;
  compilerVersion: string;
  contentHmacSecret: string;
  rawEventTokenBudget: number;
  repository: ContextCompilerRepository;
}): ContextCompiler {
  return {
    async compile(input) {
      const source = await dependencies.repository.loadContextSource(input);
      const selectedNewestFirst: Array<
        ContextSourceEvent & { estimatedTokens: number }
      > = [];
      let remaining = dependencies.rawEventTokenBudget;
      let degraded = false;

      for (const event of [...source.events].reverse()) {
        const estimatedTokens = estimateTokens(event.text);
        const isCurrentInput = event.revisionId === source.inputRevisionId;
        if (isCurrentInput || estimatedTokens <= remaining) {
          selectedNewestFirst.push({ ...event, estimatedTokens });
          remaining = Math.max(0, remaining - estimatedTokens);
        } else {
          degraded = true;
        }
      }

      const referencedEvents = selectedNewestFirst.reverse();
      const contentHmac = createHmac(
        "sha256",
        dependencies.contentHmacSecret,
      )
        .update(
          referencedEvents
            .map((event) => `${event.revisionId}:${event.text}`)
            .join("\n"),
        )
        .digest("hex");

      return dependencies.repository.saveCompiledContext({
        compilerVersion: dependencies.compilerVersion,
        contentHmac,
        degradedReason: degraded ? "raw_event_budget_exceeded" : null,
        dialogueRevision: source.dialogueRevision,
        generationCommandId: input.generationCommandId,
        locale: source.locale,
        now: dependencies.clock(),
        referencedEvents,
        sectionBudgets: {
          committedRawEvents: dependencies.rawEventTokenBudget,
        },
        sourceRevision: source.sourceRevision,
        totalTokens: referencedEvents.reduce(
          (total, event) => total + event.estimatedTokens,
          0,
        ),
        userId: input.userId,
      });
    },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}
