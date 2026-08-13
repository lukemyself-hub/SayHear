import {
  CompiledContextIntegrityError,
  ProviderDispatchError,
  type ContextCompiler,
  type ConversationTextChampion,
  type ConversationTextModel,
  type ProviderEgressPort,
  type ProviderEgressRepository,
} from "@sayhear/application";

export function createProviderEgressPort(dependencies: {
  champion: ConversationTextChampion;
  clock: () => Date;
  contextCompiler: Pick<ContextCompiler, "renderPermittedPayload">;
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
      if (claim.outcome === "already_claimed") {
        throw new ProviderDispatchError(
          "unavailable",
          "Another request already owns this GenerationCommand.",
          false,
        );
      }

      let payload;
      try {
        payload = dependencies.contextCompiler.renderPermittedPayload(
          claim.context,
        );
      } catch (error) {
        if (error instanceof CompiledContextIntegrityError) {
          throw new ProviderDispatchError("policy_blocked");
        }
        throw error;
      }
      let firstTokenRecorded = false;
      for await (const event of dependencies.model.stream({
        instructions: payload.instructions,
        locale: claim.context.locale,
        messages: payload.messages,
        model: claim.model,
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        if (event.type === "delta" && !firstTokenRecorded) {
          firstTokenRecorded = true;
          const accepted =
            await dependencies.repository.recordFirstToken({
              modelRunAttemptId: input.modelRunAttemptId,
              now: dependencies.clock(),
            });
          if (!accepted) {
            throw new ProviderDispatchError(
              "unavailable",
              "The Provider result arrived after its execution fence expired.",
              false,
            );
          }
        } else if (event.type === "completed") {
          const accepted =
            await dependencies.repository.recordProviderCompletion({
              completion: event,
              modelRunAttemptId: input.modelRunAttemptId,
              now: dependencies.clock(),
            });
          if (!accepted) {
            throw new ProviderDispatchError(
              "unavailable",
              "The Provider result arrived after its execution fence expired.",
              false,
            );
          }
        } else if (event.type === "tool_call") {
          // Provider-native function calls are forwarded to the Harness
          // untouched. The Provider Egress Port intentionally does not consult
          // the Conversation Action Catalog or decide whether the call is
          // admissible: that is the Harness's bounded responsibility, and a
          // tool_call against an empty Catalog must fail closed upstream.
        }
        yield event;
      }
    },
  };
}
