/**
 * Versioned prompt artifacts resolved by the Context Compiler at compile time
 * (issue #73, ADR-0111, architecture §15.6).
 *
 * The persona is a structured artifact in three independently versioned
 * blocks: the Persona Contract Invariant (identity, relationship, trust, and
 * safety commitments shared by all future Personas), the Canonical Persona
 * self-concept and voice, and the operational behavior anchors. Locale packs
 * carry per-language tone and wording habits under their own version
 * identities rather than as translations of each other (ADR-0072), and the
 * task instruction differs per GenerationCommand stage (ADR-0094).
 *
 * Version resolution is fail-closed: an unknown persona, locale, or task
 * version fails the compile, so no Assistant Response ships with an absent or
 * defaulted identity layer. The first-version prose here carries the previous
 * single-layer wording forward; the canonical Persona and locale-pack prose is
 * authored and accepted through the behavior-contract evidence protocol in the
 * final 1A.2P ticket.
 */

import {
  CHINESE_LOCALE_PACK_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
} from "./conversation-behavior";

export {
  CHINESE_LOCALE_PACK_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
};

export const PERSONA_CONTRACT_INVARIANT_VERSION =
  "persona-contract-invariant:v1";

export const CANONICAL_PERSONA_VERSION = "canonical-persona:v1";

export const PERSONA_BEHAVIOR_ANCHORS_VERSION = "persona-behavior-anchors:v1";

export const CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION =
  "task-instruction-decision:v1";

export const ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION =
  "task-instruction-action-finalization:v1";

export type GenerationCommandStage = "decision" | "action_finalization";

export class PromptArtifactResolutionError extends Error {
  public constructor(layer: string, version: string) {
    super(
      `The ${layer} version "${version}" cannot be resolved to a registered prompt artifact; the compile fails closed.`,
    );
    this.name = "PromptArtifactResolutionError";
  }
}

const PERSONA_CONTRACT_INVARIANT_CONTENT: Readonly<Record<string, string>> = {
  [PERSONA_CONTRACT_INVARIANT_VERSION]: [
    "Persona Contract Invariant (shared by every version of this persona):",
    "SayHear is an AI, never a human. It does not present itself as a therapist,",
    "counselor, coach, or romantic partner, and it does not encourage dependence",
    "or exclusivity. It distinguishes the user's facts and judgments from its own",
    "inference. No style or register change may relax these commitments.",
  ].join("\n"),
};

const CANONICAL_PERSONA_CONTENT: Readonly<Record<string, string>> = {
  [CANONICAL_PERSONA_VERSION]: [
    "Canonical Persona (self-concept and voice):",
    "You are SayHear, a private AI life-journal conversation companion.",
  ].join("\n"),
};

const PERSONA_BEHAVIOR_ANCHORS_CONTENT: Readonly<Record<string, string>> = {
  [PERSONA_BEHAVIOR_ANCHORS_VERSION]: [
    "Persona behavior anchors:",
    "- Selective Curiosity: ask at most one question per response, and only when it serves understanding of the user's current expression.",
    "- Curiosity Stop Signal: after the user refuses, avoids, or changes the topic, stop pursuing that direction.",
    "- Playful Warmth: keep ordinary conversation warm and lively.",
    "- Conversational Rhythm: match the user's pace; a complete response may ask zero questions.",
    "- Grounded Persona Perspective: hold your own measured perspective instead of agreeing with every user judgment.",
    "- Capability-Honest Directness: state plainly when something is not supported; never fabricate capabilities.",
  ].join("\n"),
};

const LOCALE_PACK_CONTENT: Readonly<Record<string, (locale: string) => string>> =
  {
    [ENGLISH_LOCALE_PACK_VERSION]: (locale) =>
      [
        "English locale pack:",
        `Respond naturally in the user's locale (${locale}); mixed English/Chinese code-switching is natural speech, not an error to correct.`,
      ].join("\n"),
    [CHINESE_LOCALE_PACK_VERSION]: (locale) =>
      [
        "中文 locale pack：",
        `用自然、口语化的中文回应用户（用户 locale：${locale}）；中英夹杂的 code-switching 是自然的说话方式，不需要纠正或翻译。`,
      ].join("\n"),
  };

const TASK_INSTRUCTION_CONTENT: Readonly<
  Record<GenerationCommandStage, Readonly<Record<string, string>>>
> = {
  decision: {
    [CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION]:
      "Continue the private journal conversation. Ask at most one question, anchored in the user's current expression.",
  },
  action_finalization: {
    [ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION]:
      "Finalize this turn's response after the admitted Conversation Action. Let the frozen Action Finalization Receipt alone determine what may be claimed about the Action outcome; answer the user's current expression without opening new directions or further questions.",
  },
};

export type ResolvedPromptArtifacts = Readonly<{
  canonicalPersona: string;
  localePack: string;
  personaBehaviorAnchors: string;
  personaContractInvariant: string;
  taskInstruction: string;
}>;

/**
 * Resolve the versioned identity layers for one compile. When a
 * `generationStage` is provided, the task instruction version must be the one
 * registered for that stage, so the two GenerationCommand stages can never
 * silently share an instruction. Any unresolvable version throws
 * `PromptArtifactResolutionError`; the caller must treat it as a failed
 * compile.
 */
export function resolvePromptArtifacts(input: {
  generationStage?: GenerationCommandStage;
  locale: string;
  policyVersions: Readonly<{
    canonicalPersonaVersion: string;
    localePolicyVersion: string;
    personaBehaviorAnchorsVersion: string;
    personaContractInvariantVersion: string;
    taskInstructionVersion: string;
  }>;
}): ResolvedPromptArtifacts {
  const { policyVersions } = input;
  const personaContractInvariant = resolveRegisteredContent(
    "Persona Contract Invariant",
    PERSONA_CONTRACT_INVARIANT_CONTENT,
    policyVersions.personaContractInvariantVersion,
  );
  const canonicalPersona = resolveRegisteredContent(
    "Canonical Persona",
    CANONICAL_PERSONA_CONTENT,
    policyVersions.canonicalPersonaVersion,
  );
  const personaBehaviorAnchors = resolveRegisteredContent(
    "persona behavior anchors",
    PERSONA_BEHAVIOR_ANCHORS_CONTENT,
    policyVersions.personaBehaviorAnchorsVersion,
  );
  const localePackRenderer = LOCALE_PACK_CONTENT[policyVersions.localePolicyVersion];
  if (!localePackRenderer) {
    throw new PromptArtifactResolutionError(
      "locale pack",
      policyVersions.localePolicyVersion,
    );
  }
  const stageInstructions = input.generationStage === undefined
    ? Object.values(TASK_INSTRUCTION_CONTENT).flatMap((stage) =>
        Object.entries(stage),
      )
    : Object.entries(TASK_INSTRUCTION_CONTENT[input.generationStage]);
  const taskInstructionEntry = stageInstructions.find(
    ([version]) => version === policyVersions.taskInstructionVersion,
  );
  if (!taskInstructionEntry) {
    throw new PromptArtifactResolutionError(
      input.generationStage === undefined
        ? "task instruction"
        : `task instruction for the ${input.generationStage} GenerationCommand stage`,
      policyVersions.taskInstructionVersion,
    );
  }
  return {
    canonicalPersona,
    localePack: localePackRenderer(input.locale),
    personaBehaviorAnchors,
    personaContractInvariant,
    taskInstruction: taskInstructionEntry[1],
  };
}

function resolveRegisteredContent(
  layer: string,
  registry: Readonly<Record<string, string>>,
  version: string,
): string {
  const content = registry[version];
  if (!content) {
    throw new PromptArtifactResolutionError(layer, version);
  }
  return content;
}
