import {
  asGenerationCommandId,
  asInteractionTurnId,
  asUserId,
  createProactiveFollowupMaintenanceService,
  createProactiveFollowupSegmentStage,
  PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS,
  PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
  type CompiledContextId,
  type GenerationCommandId,
  type InteractionTurnId,
  type ModelRoleCommandService,
  type ModelRoleProviderEgress,
  type ProactiveFollowupCandidate,
  type ProactiveFollowupLaneSnapshot,
  type ProactiveFollowupModelProvider,
  type ProactiveFollowupOpportunityKind,
  type ProactiveFollowupSegmentStage,
  type ProactiveFollowupStateSnapshot,
  type UserId,
} from "@sayhear/application";
import {
  PostgresOpenLoopRepository,
  PostgresProactiveFollowupRepository,
} from "@sayhear/data";

/**
 * G2 proactive lane adapter (issue #207 layer 2c). Binds the pure
 * `ProactiveFollowupSegmentStage` to the Postgres readers, the reservation
 * store, and the Context Compiler, mirroring the 2b extract-lane shape:
 * composition exposes the stage, the workflow owns the crash path, and the
 * recovery scanner owns the maintenance trigger. No migration; reads and
 * writes stay on the existing C2 tables.
 *
 * Two documented conservative defaults live here until their dedicated
 * sources land: an unknown lane sensitivity stays sensitive (gentle framing,
 * ranked last), and exchange-mention detection reports false (a dedicated
 * mention pipeline must replace it; tracked as a follow-up).
 */
export function createProactiveFollowupLane(input: Readonly<{
  clock: () => Date;
  modelRoleCommandService: Pick<
    ModelRoleCommandService,
    "admit" | "configuration" | "discardAttempt" | "recordAttemptResult"
  >;
  providerEgress: ModelRoleProviderEgress;
  provider: ProactiveFollowupModelProvider;
  proactiveRepository: PostgresProactiveFollowupRepository;
  openLoopRepository: PostgresOpenLoopRepository;
  openLoopExtractionPolicyVersion: string;
  compiler: Readonly<{
    compile(input: Readonly<{
      generationCommandId: GenerationCommandId;
      interactionTurnId: InteractionTurnId;
      userId: UserId;
    }>): Promise<Readonly<{ id: CompiledContextId }>>;
  }>;
  opportunity?: ProactiveFollowupOpportunityKind;
}>): Readonly<{
  stage: ProactiveFollowupSegmentStage;
  maintenanceService: ReturnType<
    typeof createProactiveFollowupMaintenanceService
  >;
}> {
  const proactiveRepository = input.proactiveRepository;
  const openLoopRepository = input.openLoopRepository;
  const extractionPolicyVersion = input.openLoopExtractionPolicyVersion;

  const stage = createProactiveFollowupSegmentStage({
    clock: input.clock,
    modelRoleCommandService: input.modelRoleCommandService,
    providerEgress: input.providerEgress,
    provider: input.provider,
    ...(input.opportunity === undefined ? {} : { opportunity: input.opportunity }),
    compiler: {
      compileSegmentContext: async (compileInput) => {
        const compiled = await input.compiler.compile({
          generationCommandId: asGenerationCommandId(
            String(compileInput.generationCommandId),
          ),
          interactionTurnId: asInteractionTurnId(
            String(compileInput.interactionTurnId),
          ),
          userId: asUserId(String(compileInput.userId)),
        });
        return compiled.id;
      },
    },
    reservations: {
      reserveSelection: (reservationInput) =>
        proactiveRepository.reserveSelection(reservationInput),
      bindSegmentCommand: (bindInput) =>
        proactiveRepository.bindSegmentCommand(bindInput),
      abandonSegment: (abandonInput) =>
        proactiveRepository.abandonSegment(abandonInput),
      releaseOmittedSegment: (releaseInput) =>
        proactiveRepository.releaseOmittedSegment(releaseInput),
      recordDisposition: (dispositionInput) =>
        proactiveRepository.recordDisposition(dispositionInput),
    },
    readers: {
      readTurnContext: (readerInput) =>
        proactiveRepository.readTurnContext({
          userId: String(readerInput.userId),
          requestEventRevisionId: readerInput.requestEventRevisionId,
          mainGenerationCommandId: readerInput.mainGenerationCommandId,
        }),
      readDialogue: (readerInput) =>
        proactiveRepository.readDialogueSnapshot({
          userId: String(readerInput.userId),
          dailySessionId: readerInput.turn.dailySessionId,
          dialogueRevision: readerInput.turn.dialogueRevision,
          sourceRevision: readerInput.turn.currentSourceRevision,
          currentUserEventSequence:
            readerInput.turn.currentUserEventSequence,
          requestEventRevisionId: readerInput.requestEventRevisionId,
        }),
      readOpenLane: async (readerInput) => {
        const userId = String(readerInput.userId);
        const watermark = {
          sourceRevision: readerInput.turn.currentSourceRevision,
          coveredThroughSequence:
            readerInput.turn.currentUserEventSequence,
        };
        const unsettled = await openLoopRepository.hasUnsettledExtraction({
          userId,
          policyVersion: extractionPolicyVersion,
          throughSequence: readerInput.turn.currentUserEventSequence,
        });
        if (unsettled) {
          const incomplete: ProactiveFollowupLaneSnapshot = {
            name: "open_loop",
            enabled: true,
            status: "incomplete",
            watermark,
            manifestVersion:
              PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
            integrity: "valid",
            candidates: [],
          };
          return incomplete;
        }
        const rows = await openLoopRepository.readOpenLane({
          userId,
          now: readerInput.now,
          watermarkReadable: true,
        });
        const formation = await openLoopRepository.readLoopFormation({
          userId,
          openLoopIds: rows.map((row) => String(row.openLoopId)),
        });
        const candidates: ProactiveFollowupCandidate[] = rows.map((row) => {
          const lineage = formation[String(row.openLoopId)];
          return {
            targetKind: "open_loop",
            targetId: String(row.openLoopId),
            targetVersionId: row.openLoopVersionId,
            source: "open_loop",
            sourceRank: null,
            evidenceAt: row.evidenceAt,
            expectedStartAt: row.expectedStartAt,
            openLoopKind:
              row.kind === "upcoming_event" || row.kind === "awaited_outcome"
                ? row.kind
                : null,
            expiresAt: row.expiresAt,
            sensitive: true,
            lastUsedAt: lineage?.lastUsedAt ?? null,
            current: true,
            eligible: row.followupEligible && !row.suppressed,
            trustFence: "valid",
            mentionedInExchange: false,
            formedInCurrentTurn:
              lineage?.sourceEventRevisionId ===
              readerInput.requestEventRevisionId,
          };
        });
        return {
          name: "open_loop",
          enabled: true,
          status: "complete",
          watermark,
          manifestVersion:
            PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
          integrity: "valid",
          candidates,
        };
      },
      readMemoryLane: async (readerInput) => {
        const userId = String(readerInput.userId);
        const manifestVersion = PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS[0];
        const read = await proactiveRepository.readMemoryLaneCandidates({
          userId,
          mainGenerationCommandId: readerInput.mainGenerationCommandId,
        });
        if (
          !read ||
          read.sourceRevision !== readerInput.turn.currentSourceRevision
        ) {
          return {
            name: "memory",
            enabled: true,
            status: "unavailable",
            watermark: null,
            manifestVersion,
            integrity: "invalid",
            candidates: [],
          };
        }
        const candidates: ProactiveFollowupCandidate[] = read.candidates.map(
          (candidate) => ({
            targetKind: "memory_claim",
            targetId: candidate.claimId,
            targetVersionId: candidate.claimVersionId,
            source: candidate.source,
            sourceRank: candidate.sourceRank,
            evidenceAt: candidate.evidenceAt,
            subjectRole: candidate.subjectRole,
            sensitive: candidate.sensitive,
            lastUsedAt: null,
            current: candidate.current,
            eligible: candidate.eligible,
            trustFence: candidate.trustFence,
            trustFenceResults: candidate.trustFenceResults,
            // A dedicated exchange-mention pipeline must replace this
            // documented false default (tracked as a follow-up).
            mentionedInExchange: false,
            formedInCurrentTurn: false,
          }),
        );
        return {
          name: "memory",
          enabled: true,
          status: "complete",
          watermark: {
            sourceRevision: read.sourceRevision,
            coveredThroughSequence: readerInput.turn.currentUserEventSequence,
          },
          manifestVersion,
          integrity: "valid",
          candidates,
        };
      },
      readTargetSummary: (readerInput) => {
        if (readerInput.targetKind !== "open_loop") {
          return proactiveRepository
            .readMemoryLaneCandidates({
              userId: String(readerInput.userId),
              mainGenerationCommandId: readerInput.mainGenerationCommandId,
              claimVersionId: readerInput.targetVersionId,
            })
            .then(
              (read) =>
                read?.candidates.find(
                  (candidate) =>
                    candidate.claimVersionId === readerInput.targetVersionId,
                )?.summaryText ?? null,
            );
        }
        return openLoopRepository.readCurrentSummary({
          userId: String(readerInput.userId),
          openLoopId: readerInput.targetId,
          now: readerInput.now,
        });
      },
      readStates: async (readerInput) => {
        const states = await Promise.all(
          readerInput.candidates.map((candidate) =>
            proactiveRepository.readState({
              userId: String(readerInput.userId),
              targetKind: candidate.targetKind,
              targetId: candidate.targetId,
              now: readerInput.now,
            }),
          ),
        );
        return states.filter(
          (state): state is ProactiveFollowupStateSnapshot => state !== null,
        );
      },
      readEventRevisionText: (readerInput) =>
        proactiveRepository.readEventRevisionText({
          userId: String(readerInput.userId),
          revisionId: readerInput.revisionId,
        }),
      listUsesAwaitingDisposition: (readerInput) =>
        proactiveRepository.listUsesAwaitingDisposition({
          userId: String(readerInput.userId),
          ...(readerInput.limit === undefined
            ? {}
            : { limit: readerInput.limit }),
        }),
    },
  });

  const maintenanceService = createProactiveFollowupMaintenanceService({
    clock: input.clock,
    reconcileTerminalReservations: (scanInput) =>
      proactiveRepository.reconcileTerminalReservationsGlobal(scanInput),
  });

  return { stage, maintenanceService };
}
