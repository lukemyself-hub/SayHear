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
    } else {
      throw new Error(`Unsupported outbox event type: ${input.eventType}`);
    }
    return { workflowReceiptId: run.runId };
  };
}
