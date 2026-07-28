import {
  ProviderDispatchError,
  type ConversationTextChampion,
  type ConversationTextModel,
  type ProviderEgressPort,
  type ProviderEgressRepository,
} from "@sayhear/application";

export function createProviderEgressPort(dependencies: {
  champion: ConversationTextChampion;
  clock: () => Date;
  model: ConversationTextModel;
  repository: ProviderEgressRepository;
}): ProviderEgressPort {
  return {
    async *stream(input) {
      const claim = await dependencies.repository.claimDispatch({
        champion: dependencies.champion,
        compiledContextId: input.compiledContextId,
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        now: dependencies.clock(),
      });
      if (claim.outcome === "blocked") {
        throw new ProviderDispatchError(claim.category);
      }

      const instructions = renderInstructions(claim);
      let firstTokenRecorded = false;
      for await (const event of dependencies.model.stream({
        instructions,
        messages: claim.messages,
        model: claim.model,
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        if (event.type === "delta" && !firstTokenRecorded) {
          firstTokenRecorded = true;
          await dependencies.repository.recordFirstToken({
            modelRunAttemptId: input.modelRunAttemptId,
            now: dependencies.clock(),
          });
        }
        yield event;
      }
    },
  };
}

function renderInstructions(input: {
  locale: string;
  localePolicyVersion: string;
  productPolicyVersion: string;
  promptVersion: string;
  relationshipPolicyVersion: string;
  safetyPolicyVersion: string;
}): string {
  const supportedVersions = {
    localePolicyVersion: "locale-pack:v1",
    productPolicyVersion: "product-policy:v1",
    promptVersion: "conversation-text:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
  } as const;
  for (const [field, expected] of Object.entries(supportedVersions)) {
    if (input[field as keyof typeof supportedVersions] !== expected) {
      throw new ProviderDispatchError("policy_blocked");
    }
  }

  return [
    "You are SayHear, a private AI life-journal conversation companion.",
    "Listen and understand by default. Do not give advice unless the user asks.",
    "Ask at most one question, anchored in the user's current expression.",
    "Distinguish user facts and judgments from your own inference.",
    "For explicit self-harm, harm-to-others, or imminent danger, pause ordinary listening and encourage immediate real-world support without diagnosing, impersonating a therapist, or promising absolute confidentiality.",
    `Respond naturally in the user's locale (${input.locale}), preserving natural English/Chinese code-switching.`,
  ].join("\n");
}
