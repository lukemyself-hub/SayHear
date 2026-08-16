import {
  CompiledContextIntegrityError,
  normalizeProviderActionProposal,
  ProviderDispatchError,
  type ContextCompiler,
  type ConversationTextChampion,
  type ConversationTextModel,
  type ProviderEgressPort,
  type ProviderEgressRepository,
  type RecoveryGate,
} from "@sayhear/application";

export function createProviderEgressPort(dependencies: {
  champion: ConversationTextChampion;
  clock: () => Date;
  contextCompiler: Pick<ContextCompiler, "renderPermittedPayload">;
  model: ConversationTextModel;
  recoveryGate?: RecoveryGate;
  repository: ProviderEgressRepository;
}): ProviderEgressPort {
  return {
    async *stream(input) {
      if (dependencies.recoveryGate && input.userId) {
        await dependencies.recoveryGate.requireOpen(input.userId);
      }
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
        ...(input.functions && input.functions.length > 0
          ? { functions: input.functions }
          : {}),
        ...(input.toolsDisabled === undefined
          ? {}
          : { toolsDisabled: input.toolsDisabled }),
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
          if (
            input.functions &&
            input.functions.length > 0 &&
            input.requestEventRevisionId
          ) {
            const normalized = normalizeProviderActionProposal({
              functions: input.functions,
              rawArguments: event.rawArguments,
              rawFunctionName: event.rawFunctionName,
              requestEventRevisionId: input.requestEventRevisionId,
            });
            if (normalized.type === "invalid") {
              throw new ProviderDispatchError("invalid_response");
            }
            yield { proposal: normalized.proposal, type: "action_proposal" };
          } else {
            // Keep the legacy raw event available to the empty-Catalog
            // conformance test. Once the Harness publishes Functions, the
            // adapter normalizes this provider-native selection here.
            yield event;
          }
          continue;
        }
        yield event;
      }
    },
  };
}
