-- 1A.3b B1 / #200: Candidate Review and Predicate Registry governance
-- (SPEC #193 §8, ADR-0046–0053, ADR-0122). Human review dispositions are
-- synchronous typed operator commands over conditional database updates; no
-- durable workflow is created for a human disposition. Predicate Change
-- Proposals are user-content-free governance records: the proposal schema
-- structurally has no field able to carry a subject user, Evidence reference,
-- typed user value, Entity reference, or verbatim text (ADR-0122). Only the
-- owner-scoped link table connects a Proposal to a private MemoryCandidate;
-- Full Purge deletes the link and retains the governance identity and its
-- immutable version history (ADR-0053 / SPEC §8.3).
--
-- Operator discipline (SPEC §8.1 / §8.5): every disposition, cancel and
-- reconsider derives the owner from the database session, re-verifies the
-- `candidate_review` capability, the recent step-up, the Candidate state and
-- the authoritative deadline in the same transaction, and appends a
-- content-free audit row. Queue browsing keeps the capability but no step-up
-- (ADR-0122); a dedicated content-free audit table avoids overloading the
-- generation-command-shaped sensitive_access_audits vocabulary.

CREATE TABLE predicate_change_proposals (
  predicate_change_proposal_id UUID PRIMARY KEY,
  -- Current reviewed version pointer (CAS-updated only when a version is
  -- appended; never mutates an existing version).
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE predicate_change_proposal_versions (
  predicate_change_proposal_version_id UUID PRIMARY KEY,
  predicate_change_proposal_id UUID NOT NULL
    REFERENCES predicate_change_proposals(predicate_change_proposal_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  -- Registry version the draft was authored against (review baseline).
  base_registry_version INTEGER NOT NULL CHECK (base_registry_version > 0),
  -- Opaque proposed Predicate identity for the future release; the reviewer
  -- rewrites the concept label, never copying a model-proposed concept.
  proposed_predicate_identity TEXT NOT NULL CHECK (proposed_predicate_identity <> ''),
  -- Generic concept label + definition + draft value schema + synthetic
  -- examples: reviewer-authored, user-content-free by construction.
  entry_label TEXT NOT NULL CHECK (entry_label <> ''),
  entry_definition TEXT NOT NULL CHECK (entry_definition <> ''),
  entry_value_schema JSONB NOT NULL,
  entry_synthetic_examples JSONB NOT NULL,
  governance_rationale TEXT NOT NULL CHECK (governance_rationale <> ''),
  reviewer_principal_id TEXT NOT NULL CHECK (reviewer_principal_id <> ''),
  -- Product-value rejection / cancel structured reason codes; NULL for a
  -- plain registry-change draft.
  reason_code TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('awaiting_release', 'published', 'rejected', 'canceled')),
  decision_scope TEXT NOT NULL
    CHECK (decision_scope IN ('registry_change', 'product_value_rejection')),
  supersedes_version_id UUID
    REFERENCES predicate_change_proposal_versions(
      predicate_change_proposal_version_id
    ),
  created_at TIMESTAMPTZ NOT NULL,
  -- Set inside the release migration's own transaction: the 90-day boundary
  -- is anchored to the release commit, never to a sweeper or worker time.
  published_registry_version INTEGER CHECK (published_registry_version > 0),
  published_at TIMESTAMPTZ,
  UNIQUE (predicate_change_proposal_id, revision),
  -- One live (non-superseded) draft per proposal at a time: a superseding
  -- version supersedes exactly the previously current version.
  CHECK (
    supersedes_version_id IS NULL
    OR supersedes_version_id <> predicate_change_proposal_version_id
  ),
  CHECK (
    status <> 'published'
    OR (published_registry_version IS NOT NULL AND published_at IS NOT NULL)
  ),
  CHECK (
    status = 'published'
    OR (published_registry_version IS NULL AND published_at IS NULL)
  ),
  -- Product-value rejections are terminal versions with a closed reason;
  -- registry-change drafts never carry a rejection reason.
  CHECK (
    decision_scope <> 'product_value_rejection'
    OR (status = 'rejected' AND reason_code = 'concept_no_product_value')
  ),
  CHECK (
    decision_scope <> 'registry_change'
    OR (status IN ('awaiting_release', 'published', 'canceled') AND reason_code IS NULL)
  )
);

CREATE UNIQUE INDEX predicate_change_proposal_versions_supersedes_idx
  ON predicate_change_proposal_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

ALTER TABLE predicate_change_proposals
  ADD CONSTRAINT predicate_change_proposals_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES predicate_change_proposal_versions(
    predicate_change_proposal_version_id
  );

-- Owner-scoped association (SPEC §8.3): the ONLY governance row that points
-- at a private MemoryCandidate. Full Purge deletes it; the Proposal identity
-- and version history survive as user-content-free governance records.
CREATE TABLE predicate_change_proposal_candidate_links (
  predicate_change_proposal_candidate_link_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_candidate_id UUID NOT NULL,
  predicate_change_proposal_id UUID NOT NULL
    REFERENCES predicate_change_proposals(predicate_change_proposal_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (memory_candidate_id, user_id),
  FOREIGN KEY (memory_candidate_id, user_id)
    REFERENCES memory_candidates(memory_candidate_id, user_id),
  -- One active association per candidate: re-review after a cancel goes
  -- through a successor Candidate, never the same terminal row (ADR-0046).
  UNIQUE (predicate_change_proposal_id, user_id, memory_candidate_id)
);

CREATE INDEX predicate_change_proposal_candidate_links_proposal_idx
  ON predicate_change_proposal_candidate_links(predicate_change_proposal_id);

-- Content-free operator audit for every disposition, cancel and reconsider
-- (SPEC §8.1): no rationale, draft, or private content — only the typed
-- command, target identity, outcome, operator principal, policy version and
-- time. Retained as an owner envelope whose target identity is redacted by
-- Full Purge with a 30-day read deadline after active-system deletion
-- (ADR-0130), mirroring sensitive_access_audits. The clear/verify handlers
-- reuse the redaction adapters (`redact_sensitive_access_audits` /
-- `verify_sensitive_access_audits_redacted`) because the table shape is the
-- same; the adapters are table-generic and never certify their own result.
CREATE TABLE candidate_review_audits (
  candidate_review_audit_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  command TEXT NOT NULL
    CHECK (
      command IN (
        'map_existing', 'reject', 'approve_for_registry_change',
        'cancel', 'reconsider', 'queue_read', 'proposal_read'
      )
    ),
  target_type TEXT NOT NULL
    CHECK (target_type IN ('memory_candidate', 'predicate_change_proposal', 'purged_owner')),
  target_id UUID,
  disposition TEXT NOT NULL CHECK (disposition IN ('allowed', 'denied')),
  reason TEXT,
  operator_principal_id TEXT NOT NULL CHECK (operator_principal_id <> ''),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (target_type IN ('memory_candidate', 'predicate_change_proposal')
      AND target_id IS NOT NULL)
    OR (target_type = 'purged_owner' AND target_id IS NULL)
    OR (command = 'queue_read'
        AND target_type = 'memory_candidate' AND target_id IS NULL)
  )
);

CREATE INDEX candidate_review_audits_user_time_idx
  ON candidate_review_audits(user_id, recorded_at);

-- The `candidate_review` capability joins the closed capability vocabulary:
-- queue browsing and Candidate semantic reads require it without step-up,
-- while every command and full Evidence inspection keep step-up and audit
-- (ADR-0122 / SPEC §8.5).
ALTER TABLE internal_diagnostic_access_grants
  DROP CONSTRAINT internal_diagnostic_access_grants_capability_check;
ALTER TABLE internal_diagnostic_access_grants
  ADD CONSTRAINT internal_diagnostic_access_grants_capability_check
  CHECK (capability IN ('conversation_content:read', 'candidate_review'));

-- Candidate remap after a Registry release (ADR-0122 §registry release):
-- the publication transaction emits one outbox event, and the handler below
-- inserts idempotent per-candidate remap commands keyed by
-- `candidate-remap/<candidate-id>/<registry-version>/<policy-version>`
-- (command_type + subject_type + subject_id + source_revision + policy_version
-- uniqueness on workflow_commands). Recovery scan re-runs the same insert.
ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (
    command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'journal_regeneration', 'owner_full_purge', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup', 'entity_identity_revalidation',
      'model_role', 'episode_build', 'episode_maintenance', 'candidate_remap',
      'predicate_registry_release'
    )
  );

ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_subject_type_check;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_subject_type_check
  CHECK (
    subject_type IN (
      'daily_session', 'app_user', 'entity', 'memory_claim',
      'conversation_event_revision', 'memory_candidate', 'predicate_registry'
    )
  );

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (
    aggregate_type IN (
      'daily_session', 'app_user', 'conversation_event_revision',
      'memory_claim', 'entity', 'memory_candidate', 'predicate_registry'
    )
  );

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (
    event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'journal_regeneration_requested',
      'owner_full_purge_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested', 'memory_correction_followup_requested',
      'entity_identity_revalidation_requested', 'model_role_requested',
      'episode_build_requested', 'episode_maintenance_requested',
      'predicate_registry_released', 'candidate_remap_requested'
    )
  );
