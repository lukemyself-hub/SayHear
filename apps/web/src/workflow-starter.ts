import type { WorkflowStarter } from "@sayhear/application";
import { PURGE_WORKFLOW_SUBJECT_MANIFEST } from "@sayhear/application/purge-surface-registry";
import { start } from "workflow/api";

import {
  assertOwnerFullPurgeManifest,
  ownerFullPurgeWorkflow,
} from "./workflows/owner-full-purge.workflow";
import { dialogueStateWorkflow } from "./workflows/dialogue-state.workflow";
import { entityIdentityRevalidationWorkflow } from "./workflows/entity-identity-revalidation.workflow";
import { fastPathExtractionWorkflow } from "./workflows/fast-path-extraction.workflow";
import { journalEligibilityWorkflow } from "./workflows/journal-eligibility.workflow";
import { memoryConsolidationWorkflow } from "./workflows/memory-consolidation.workflow";
import { memoryCorrectionFollowupWorkflow } from "./workflows/memory-trust-followup.workflow";
import {
  journalRegenerationWorkflow,
  rollingSummaryWorkflow,
} from "./workflows/rolling-summary.workflow";
import { episodeBuildWorkflow } from "./workflows/episode-build.workflow";
import { episodeMaintenanceWorkflow } from "./workflows/episode-maintenance.workflow";
import { reflectionDailyWorkflow } from "./workflows/reflection-daily.workflow";
import { reflectionWeeklyWorkflow } from "./workflows/reflection-weekly.workflow";
import { reflectionMaintenanceWorkflow } from "./workflows/reflection-maintenance.workflow";
import { candidateRemapWorkflow } from "./workflows/candidate-remap.workflow";
import {
  modelRoleWorkflow,
  type ModelRoleWorkflowInput,
} from "./workflows/model-role.workflow";
import { predicateRegistryReleaseWorkflow } from "./workflows/predicate-registry-release.workflow";

export function createWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    const workflowInput = {
      workflowCommandId: input.workflowCommandId,
      subjectId: input.subjectId,
      sourceRevision: input.sourceRevision,
      policyVersion: input.policyVersion,
      expectedDataEpoch: input.expectedDataEpoch,
    };
    let run;
    if (input.eventType === "rolling_summary_requested") {
      run = await start(rollingSummaryWorkflow, [workflowInput]);
    } else if (input.eventType === "dialogue_state_requested") {
      run = await start(dialogueStateWorkflow, [workflowInput]);
    } else if (input.eventType === "journal_eligibility_requested") {
      run = await start(journalEligibilityWorkflow, [workflowInput]);
    } else if (input.eventType === PURGE_WORKFLOW_SUBJECT_MANIFEST.eventType) {
      assertOwnerFullPurgeManifest(input);
      run = await start(ownerFullPurgeWorkflow, [
        {
          workflowCommandId: input.workflowCommandId,
          subjectId: input.subjectId,
          expectedDataEpoch: input.expectedDataEpoch,
          purgeSurfaceRegistryVersion: input.purgeSurfaceRegistryVersion,
          externalIntegrationManifestVersion:
            input.externalIntegrationManifestVersion,
          workflowSubjectManifestVersion: input.workflowSubjectManifestVersion,
        },
      ]);
    } else if (input.eventType === "journal_regeneration_requested") {
      if (!input.actionExecutionId) {
        throw new Error("Journal regeneration outbox event has no Action execution.");
      }
      run = await start(journalRegenerationWorkflow, [
        {
          ...workflowInput,
          actionExecutionId: input.actionExecutionId,
        },
      ]);
    } else if (input.eventType === "fast_path_extraction_requested") {
      run = await start(fastPathExtractionWorkflow, [workflowInput]);
    } else if (
      input.eventType === "daily_consolidation_requested" ||
      input.eventType === "weekly_consolidation_requested" ||
      input.eventType === "memory_sweeper_requested"
    ) {
      run = await start(memoryConsolidationWorkflow, [workflowInput]);
    } else if (input.eventType === "memory_correction_followup_requested") {
      run = await start(memoryCorrectionFollowupWorkflow, [workflowInput]);
    } else if (input.eventType === "entity_identity_revalidation_requested") {
      run = await start(entityIdentityRevalidationWorkflow, [workflowInput]);
    } else if (input.eventType === "model_role_requested") {
      if (
        !input.modelRole ||
        !input.generationCommandId ||
        !input.modelRunAttemptId ||
        input.attemptNo === undefined ||
        !input.attemptKind ||
        !input.rolloutPin
      ) {
        throw new Error(
          "Model role outbox event has incomplete attempt metadata.",
        );
      }
      const modelRoleInput = {
        ...workflowInput,
        modelRole: input.modelRole,
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        attemptNo: input.attemptNo,
        attemptKind: input.attemptKind,
        rolloutPin: input.rolloutPin,
      } as ModelRoleWorkflowInput;
      run = await start(modelRoleWorkflow, [modelRoleInput]);
    } else if (input.eventType === "episode_build_requested") {
      if (!input.ownerId) {
        throw new Error(
          "Episode build outbox event has no content-free owner identity.",
        );
      }
      run = await start(episodeBuildWorkflow, [
        { ...workflowInput, ownerId: input.ownerId },
      ]);
    } else if (input.eventType === "episode_maintenance_requested") {
      run = await start(episodeMaintenanceWorkflow, [workflowInput]);
    } else if (input.eventType === "reflection_daily_requested") {
      if (!input.claimBaselineDigest) {
        throw new Error("Reflection daily outbox event has no claim-baseline digest.");
      }
      if (!input.ownerId) {
        throw new Error(
          "Reflection daily outbox event has no content-free owner identity.",
        );
      }
      run = await start(reflectionDailyWorkflow, [
        {
          ...workflowInput,
          ownerId: input.ownerId,
          claimBaselineDigest: input.claimBaselineDigest,
        },
      ]);
    } else if (input.eventType === "reflection_weekly_requested") {
      if (
        !input.weekIdentifier ||
        !input.windowStartDate ||
        !input.windowEndDate ||
        !input.sourceDigest
      ) {
        throw new Error("Reflection weekly outbox event has no frozen window identity.");
      }
      if (!input.ownerId) {
        throw new Error(
          "Reflection weekly outbox event has no content-free owner identity.",
        );
      }
      run = await start(reflectionWeeklyWorkflow, [
        {
          ...workflowInput,
          ownerId: input.ownerId,
          weekIdentifier: input.weekIdentifier,
          windowStartDate: input.windowStartDate,
          windowEndDate: input.windowEndDate,
          sourceDigest: input.sourceDigest,
        },
      ]);
    } else if (input.eventType === "reflection_maintenance_requested") {
      run = await start(reflectionMaintenanceWorkflow, [workflowInput]);
    } else if (input.eventType === "predicate_registry_released") {
      run = await start(predicateRegistryReleaseWorkflow, [workflowInput]);
    } else if (input.eventType === "candidate_remap_requested") {
      run = await start(candidateRemapWorkflow, [workflowInput]);
    } else {
      throw new Error(`Unsupported outbox event type: ${input.eventType}`);
    }
    return { workflowReceiptId: run.runId };
  };
}
