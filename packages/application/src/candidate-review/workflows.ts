import type { MemoryCandidateId, UserId, WorkflowCommandId } from "@sayhear/domain";

import { assertWorkflowSafe } from "../journal-eligibility";
import type { RemapOutcome } from "./review";
import { asMemoryCandidateId, asUserId } from "@sayhear/domain";
import { CANDIDATE_REVIEW_POLICY_VERSION } from "./types";

/**
 * Release/remap workflow runners for the Candidate Review slice (SPEC #193
 * §8.4, ADR-0122): the release transaction emits ONE `predicate_registry_
 * released` outbox event; this handler inserts idempotent per-candidate
 * `candidate-remap/<candidate-id>/<registry-version>/<policy-version>`
 * commands that re-enter normal mapping and admission. The recovery scan
 * backstops missed events and unfinished remaps by re-running the same
 * idempotent scan. No human command ever creates a durable workflow; the
 * remap commands are reconciliation work, not human dispositions.
 */

export type CandidateRemapOutcome = RemapOutcome;

export type CandidateRemapCommandRecord = Readonly<{
  userId: UserId;
  candidateId: MemoryCandidateId;
  registryVersion: number;
  policyVersion: string;
}>;

export type CandidateReviewWorkflowRepository = Readonly<{
  readRemapCommand(input: {
    workflowCommandId: WorkflowCommandId;
  }): Promise<CandidateRemapCommandRecord | null>;
  completeRemapCommand(input: {
    workflowCommandId: WorkflowCommandId;
  }): Promise<void>;
  /**
   * Registry version scope: the release workflow passes the RELEASED
   * version, so a later release re-arms remaps for Candidates whose earlier
   * remap completed without converging; the recovery backstop passes no
   * version and falls back to each Proposal's pinned published version.
   */
  selectPendingRemapCandidates(input: {
    registryVersion?: number;
  }): Promise<
    readonly Readonly<{
      userId: string;
      memoryCandidateId: string;
      registryVersion: number;
    }>[]
  >;
  /** Idempotent command + event insert; false when it already exists. */
  insertRemapCommand(input: {
    userId: string;
    memoryCandidateId: string;
    registryVersion: number;
    policyVersion?: string;
  }): Promise<boolean>;
}>;

export type PredicateRegistryReleaseResult = Readonly<{
  outcome: "released";
  remapCommandsCreated: number;
}>;

/**
 * Release handler (ADR-0122): derive the awaiting Candidates from the
 * PUBLISHED ProposalVersions (never from the outbox event itself, so a lost
 * event cannot strand a release) and insert one idempotent remap command per
 * still-eligible Candidate whose release deadline has not passed.
 */
export async function runPredicateRegistryReleaseWorkflow(input: {
  repository: CandidateReviewWorkflowRepository;
  /**
   * The released Registry version (the outbox event's aggregate revision).
   * Command identities are keyed by it, so a later release re-arms remaps
   * for Candidates the earlier release could not map.
   */
  registryVersion?: number;
  policyVersion?: string;
}): Promise<PredicateRegistryReleaseResult> {
  const policyVersion =
    input.policyVersion ?? CANDIDATE_REVIEW_POLICY_VERSION;
  if (policyVersion !== CANDIDATE_REVIEW_POLICY_VERSION) {
    throw new Error(
      "Candidate remap policy does not match the runtime policy version.",
    );
  }
  const pending = await input.repository.selectPendingRemapCandidates(
    input.registryVersion === undefined
      ? {}
      : { registryVersion: input.registryVersion },
  );
  let created = 0;
  for (const row of pending) {
    const inserted = await input.repository.insertRemapCommand({
      userId: row.userId,
      memoryCandidateId: row.memoryCandidateId,
      registryVersion: row.registryVersion,
      policyVersion,
    });
    if (inserted) created += 1;
  }
  return { outcome: "released", remapCommandsCreated: created };
}

export type CandidateRemapResult = Readonly<{
  outcome: CandidateRemapOutcome;
  workflowCommandId: WorkflowCommandId;
}>;

export async function runCandidateRemapWorkflow(input: {
  repository: CandidateReviewWorkflowRepository;
  workflowCommandId: WorkflowCommandId;
  runRemap(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    registryVersion: number;
  }): Promise<CandidateRemapOutcome>;
}): Promise<CandidateRemapResult> {
  const command = await input.repository.readRemapCommand({
    workflowCommandId: input.workflowCommandId,
  });
  if (!command) {
    throw new Error(
      `Candidate remap command ${input.workflowCommandId} does not exist.`,
    );
  }
  if (command.policyVersion !== CANDIDATE_REVIEW_POLICY_VERSION) {
    throw new Error(
      "Candidate remap command policy does not match runtime policy.",
    );
  }
  const outcome = await input.runRemap({
    userId: command.userId,
    candidateId: command.candidateId,
    registryVersion: command.registryVersion,
  });
  await input.repository.completeRemapCommand({
    workflowCommandId: input.workflowCommandId,
  });
  return { outcome, workflowCommandId: input.workflowCommandId };
}

/** Workflow-history safety for the remap workflow inputs (architecture 13.3). */
export function assertCandidateGovernanceWorkflowSafe(input: unknown): void {
  assertWorkflowSafe(input, "input");
}
