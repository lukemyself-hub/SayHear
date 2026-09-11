-- 1A.3b C2 / issue #205.
--
-- Deterministic proactive-follow-up state, one-exchange reservation, atomic
-- use lineage and next-User-Event disposition. This migration deliberately
-- contains no model role, provider pin, command dispatcher or message path;
-- C3 consumes the typed seams after the G1 -> G2 -> G3 gates.
--
-- All rows are owner-scoped and all semantic history is append-only. The
-- manifests and locators are bounded JSON metadata, never copied user or
-- Assistant text. Full Purge deletes children before parents through the
-- same-change Purge Surface Registry entries.

CREATE TABLE proactive_followup_states (
  proactive_followup_state_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('open_loop', 'memory_claim')),
  target_id UUID NOT NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proactive_followup_state_id, user_id),
  UNIQUE (user_id, target_kind, target_id)
);

CREATE TABLE proactive_followup_state_versions (
  proactive_followup_state_version_id UUID PRIMARY KEY,
  proactive_followup_state_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('open_loop', 'memory_claim')),
  target_id UUID NOT NULL,
  target_version_id UUID NOT NULL,
  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible', 'suppressed')),
  suppression_reason TEXT CHECK (
    suppression_reason IN (
      'short_response', 'evaded', 'topic_changed', 'refused',
      'ambiguous_closure'
    )
  ),
  consecutive_soft_stop_count INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_soft_stop_count >= 0),
  suppressed_until_at TIMESTAMPTZ,
  release_reason TEXT CHECK (
    release_reason IN (
      'cooldown_elapsed', 'user_reopened', 'new_direct_evidence',
      'target_specific_permission', 'target_terminal_or_expired'
    )
  ),
  trigger_user_event_revision_id UUID,
  last_prompt_event_revision_id UUID,
  last_response_event_revision_id UUID,
  last_used_at TIMESTAMPTZ,
  trigger_exchange_no INTEGER CHECK (trigger_exchange_no > 0),
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proactive_followup_state_id, revision),
  UNIQUE (proactive_followup_state_version_id, user_id),
  UNIQUE (
    proactive_followup_state_version_id,
    proactive_followup_state_id,
    user_id
  ),
  FOREIGN KEY (proactive_followup_state_id, user_id)
    REFERENCES proactive_followup_states(proactive_followup_state_id, user_id),
  FOREIGN KEY (trigger_user_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id),
  FOREIGN KEY (last_prompt_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id),
  FOREIGN KEY (last_response_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id),
  CHECK (
    (eligibility_status = 'suppressed' AND suppression_reason IS NOT NULL AND release_reason IS NULL)
    OR (eligibility_status = 'eligible' AND suppression_reason IS NULL AND suppressed_until_at IS NULL AND release_reason IS NOT NULL)
  ),
  CHECK (eligibility_status = 'eligible' OR suppressed_until_at IS NULL OR suppressed_until_at > created_at)
);

ALTER TABLE proactive_followup_states
  ADD CONSTRAINT proactive_followup_states_current_version_fk
  FOREIGN KEY (current_version_id, proactive_followup_state_id, user_id)
  REFERENCES proactive_followup_state_versions(
    proactive_followup_state_version_id, proactive_followup_state_id, user_id
  );

CREATE UNIQUE INDEX proactive_followup_states_current_version_idx
  ON proactive_followup_states(current_version_id)
  WHERE current_version_id IS NOT NULL;

CREATE INDEX proactive_followup_state_versions_due_idx
  ON proactive_followup_state_versions(user_id, suppressed_until_at)
  WHERE eligibility_status = 'suppressed' AND suppressed_until_at IS NOT NULL;

CREATE INDEX proactive_followup_state_versions_owner_idx
  ON proactive_followup_state_versions(user_id, proactive_followup_state_id, revision DESC);

CREATE FUNCTION reject_proactive_followup_state_version_mutation() RETURNS trigger
AS $$
BEGIN
  RAISE EXCEPTION 'proactive follow-up state versions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proactive_followup_state_versions_immutable
  BEFORE UPDATE ON proactive_followup_state_versions
  FOR EACH ROW EXECUTE FUNCTION reject_proactive_followup_state_version_mutation();

CREATE TABLE proactive_followup_reservations (
  proactive_followup_reservation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  continuous_exchange_no INTEGER NOT NULL CHECK (continuous_exchange_no > 0),
  main_generation_command_id UUID NOT NULL,
  segment_generation_command_id UUID,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('open_loop', 'memory_claim')),
  target_id UUID NOT NULL,
  target_version_id UUID NOT NULL,
  selection_manifest JSONB NOT NULL CHECK (jsonb_typeof(selection_manifest) = 'object'),
  selection_policy_version TEXT NOT NULL CHECK (selection_policy_version <> ''),
  status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'released', 'abandoned')),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  committed_use_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  UNIQUE (proactive_followup_reservation_id, user_id),
  UNIQUE (daily_session_id, user_id, continuous_exchange_no),
  CHECK (
    (status = 'committed' AND committed_use_id IS NOT NULL)
    OR (status <> 'committed' AND committed_use_id IS NULL)
  ),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (main_generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id),
  FOREIGN KEY (segment_generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id)
);

CREATE INDEX proactive_followup_reservations_active_idx
  ON proactive_followup_reservations(user_id, status, created_at)
  WHERE status = 'active';

CREATE TABLE proactive_followup_uses (
  proactive_followup_use_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  proactive_followup_reservation_id UUID NOT NULL,
  daily_session_id UUID NOT NULL,
  continuous_exchange_no INTEGER NOT NULL CHECK (continuous_exchange_no > 0),
  main_generation_command_id UUID NOT NULL,
  segment_generation_command_id UUID NOT NULL,
  compiled_context_id UUID NOT NULL,
  prompt_user_event_revision_id UUID NOT NULL,
  prompt_user_event_sequence BIGINT NOT NULL CHECK (prompt_user_event_sequence > 0),
  assistant_event_id UUID NOT NULL,
  assistant_event_revision_id UUID NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('open_loop', 'memory_claim')),
  target_id UUID NOT NULL,
  target_version_id UUID NOT NULL,
  expression_kind TEXT NOT NULL CHECK (expression_kind IN ('question', 'acknowledgment')),
  final_text_locator JSONB NOT NULL CHECK (
    jsonb_typeof(final_text_locator) = 'object'
    AND final_text_locator->>'kind' = 'assistant_event_revision'
    AND final_text_locator->>'segment' = 'proactive_followup'
    AND final_text_locator->>'ordinal' = '0'
  ),
  selection_policy_version TEXT NOT NULL CHECK (selection_policy_version <> ''),
  prompt_policy_version TEXT NOT NULL CHECK (prompt_policy_version <> ''),
  policy_bundle JSONB NOT NULL CHECK (jsonb_typeof(policy_bundle) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proactive_followup_use_id, user_id),
  UNIQUE (proactive_followup_reservation_id, user_id),
  UNIQUE (user_id, daily_session_id, continuous_exchange_no),
  UNIQUE (user_id, assistant_event_revision_id),
  FOREIGN KEY (proactive_followup_reservation_id, user_id)
    REFERENCES proactive_followup_reservations(proactive_followup_reservation_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (main_generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id),
  FOREIGN KEY (segment_generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id),
  FOREIGN KEY (compiled_context_id, user_id)
    REFERENCES compiled_contexts(compiled_context_id, user_id),
  FOREIGN KEY (prompt_user_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id),
  FOREIGN KEY (assistant_event_id, user_id)
    REFERENCES conversation_events(conversation_event_id, user_id),
  FOREIGN KEY (assistant_event_revision_id, assistant_event_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, conversation_event_id, user_id
    )
);

CREATE INDEX proactive_followup_uses_target_idx
  ON proactive_followup_uses(user_id, target_kind, target_id, created_at);

ALTER TABLE proactive_followup_reservations
  ADD CONSTRAINT proactive_followup_reservations_committed_use_fk
  FOREIGN KEY (committed_use_id, user_id)
  REFERENCES proactive_followup_uses(proactive_followup_use_id, user_id);

CREATE TABLE proactive_followup_dispositions (
  proactive_followup_disposition_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  proactive_followup_use_id UUID NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('open_loop', 'memory_claim')),
  target_id UUID NOT NULL,
  target_version_id UUID NOT NULL,
  trigger_user_event_revision_id UUID NOT NULL,
  trigger_user_event_sequence BIGINT NOT NULL CHECK (trigger_user_event_sequence > 0),
  signal TEXT NOT NULL CHECK (
    signal IN (
      'no_stop_signal', 'short_response', 'evaded', 'refused',
      'topic_changed', 'ambiguous_closure'
    )
  ),
  final_text_locator JSONB NOT NULL CHECK (jsonb_typeof(final_text_locator) = 'object'),
  outcome TEXT NOT NULL CHECK (outcome IN ('unchanged', 'suppressed')),
  state_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proactive_followup_use_id, trigger_user_event_revision_id),
  UNIQUE (proactive_followup_disposition_id, user_id),
  FOREIGN KEY (proactive_followup_use_id, user_id)
    REFERENCES proactive_followup_uses(proactive_followup_use_id, user_id),
  FOREIGN KEY (trigger_user_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id),
  FOREIGN KEY (state_version_id, user_id)
    REFERENCES proactive_followup_state_versions(
      proactive_followup_state_version_id, user_id
    )
);

CREATE INDEX proactive_followup_dispositions_trigger_idx
  ON proactive_followup_dispositions(user_id, trigger_user_event_revision_id);
