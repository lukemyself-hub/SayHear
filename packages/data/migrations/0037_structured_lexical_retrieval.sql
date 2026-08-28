-- 1A.3a / #116: Structured-Lexical Retrieval Baseline (ADR-0115, SPEC #107
-- "Retrieval", architecture §10). Three deterministic lanes — structured
-- exact, lexical_terms[] GIN overlap, pg_catalog.english FTS — under one
-- versioned 200 ms shared deadline, fail-closed per the lane health matrix.
-- No pgvector, no embedding, no pg_trgm.
--
-- claim_retrieval_projections is the rebuildable retrieval index of ONE
-- ClaimVersion (architecture §7.11): retrieval_text and lexical_terms derive
-- deterministically from the Predicate Registry snapshot, entity labels, the
-- typed value, and time expressions — never from User Event prose. Rows are
-- maintained write-through in the same transaction as the version advance and
-- re-fenced at query time; the projection is never authoritative.
--
-- retrieval_runs / retrieval_run_candidates store the no-prose run ledger:
-- stable references, normalized terms, structured reason codes, and timing
-- only (no Event text, no Evidence quotes, no retrieval_text copies).

-- Versioned, immutable policy parameters. The 200 ms deadline and the
-- per-lane candidate cap are tunable from production evidence through a new
-- policy version, never edited in place.
CREATE TABLE retrieval_policies (
  policy_version TEXT PRIMARY KEY,
  deadline_ms INTEGER NOT NULL CHECK (deadline_ms > 0),
  candidate_limit_per_lane INTEGER NOT NULL
    CHECK (candidate_limit_per_lane > 0 AND candidate_limit_per_lane <= 100),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO retrieval_policies (
  policy_version,
  deadline_ms,
  candidate_limit_per_lane,
  created_at
)
VALUES (
  'memory-retrieval:v1',
  200,
  25,
  CURRENT_TIMESTAMP
);

CREATE FUNCTION reject_retrieval_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Retrieval policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER retrieval_policies_immutable
BEFORE UPDATE OR DELETE ON retrieval_policies
FOR EACH ROW
EXECUTE FUNCTION reject_retrieval_policy_mutation();

CREATE TABLE claim_retrieval_projections (
  claim_retrieval_projection_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_id UUID NOT NULL,
  memory_claim_version_id UUID NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
  view_direction TEXT NOT NULL
    CHECK (view_direction IN ('self', 'forward', 'inverse', 'symmetric')),
  -- deterministic per-locale rendering from registry + labels + typed value;
  -- never a copy of User Event prose.
  retrieval_text TEXT NOT NULL CHECK (retrieval_text <> ''),
  -- deterministic zh / en / code-switching term set (entity labels, verified
  -- aliases, registry lexical surfaces, typed value, time expressions).
  lexical_terms TEXT[] NOT NULL CHECK (array_length(lexical_terms, 1) > 0),
  english_search tsvector GENERATED ALWAYS AS (
    to_tsvector('pg_catalog.english', retrieval_text)
  ) STORED,
  projection_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (memory_claim_version_id, locale),
  UNIQUE (claim_retrieval_projection_id, user_id),
  FOREIGN KEY (memory_claim_version_id, memory_claim_id, user_id)
    REFERENCES memory_claim_versions(
      memory_claim_version_id, memory_claim_id, user_id
    )
);

CREATE INDEX claim_retrieval_projections_user_active_idx
  ON claim_retrieval_projections(user_id)
  WHERE status = 'active' AND content_purged_at IS NULL;

CREATE INDEX claim_retrieval_projections_claim_idx
  ON claim_retrieval_projections(memory_claim_id, user_id);

CREATE INDEX claim_retrieval_projections_lexical_terms_idx
  ON claim_retrieval_projections USING GIN (lexical_terms);

CREATE INDEX claim_retrieval_projections_english_search_idx
  ON claim_retrieval_projections USING GIN (english_search);

-- Rebuildable projection discipline (ADR-0089): rows freeze with the version
-- they project; the only in-place change is the lifecycle status (active ->
-- stale / deleted) and the purge marker (#123). Deletion is allowed for
-- fence teardown and the purge face — the rows are never authoritative.
CREATE FUNCTION enforce_claim_retrieval_projection_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND NEW.claim_retrieval_projection_id = OLD.claim_retrieval_projection_id
    AND NEW.user_id = OLD.user_id
    AND NEW.memory_claim_id = OLD.memory_claim_id
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.locale = OLD.locale
    AND NEW.view_direction = OLD.view_direction
    AND NEW.retrieval_text = OLD.retrieval_text
    AND NEW.lexical_terms = OLD.lexical_terms
    AND NEW.projection_policy_version = OLD.projection_policy_version
    AND NEW.created_at = OLD.created_at
    AND (
      -- lifecycle-only transitions, never backwards out of a terminal state
      (NEW.status <> OLD.status
        AND NEW.content_purged_at IS NOT DISTINCT FROM OLD.content_purged_at
        AND (
          (OLD.status = 'active' AND NEW.status IN ('stale', 'deleted'))
          OR (OLD.status = 'stale' AND NEW.status = 'deleted')
        ))
      OR
      -- the purge face (#123) sets the marker without touching the lifecycle
      (NEW.status = OLD.status
        AND OLD.content_purged_at IS NULL
        AND NEW.content_purged_at IS NOT NULL)
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Claim retrieval projection content is frozen'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER claim_retrieval_projections_frozen
BEFORE UPDATE ON claim_retrieval_projections
FOR EACH ROW
EXECUTE FUNCTION enforce_claim_retrieval_projection_freeze();

-- One row per Context memory query. The run ledger is append-only state:
-- `running` is the pre-flight insert; completion is an UPDATE of status,
-- timing, and codes only.
CREATE TABLE retrieval_runs (
  retrieval_run_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  source_event_revision_id UUID NOT NULL,
  compiled_context_id UUID,
  retrieval_policy_version TEXT NOT NULL
    REFERENCES retrieval_policies(policy_version),
  query_construction_policy_version TEXT NOT NULL,
  projection_policy_version TEXT NOT NULL,
  -- source kind + stable revision / id references only, never prose.
  query_source_refs JSONB NOT NULL
    CHECK (jsonb_typeof(query_source_refs) = 'array'),
  normalized_query_terms JSONB NOT NULL
    CHECK (jsonb_typeof(normalized_query_terms) = 'object'),
  lane_plan JSONB NOT NULL
    CHECK (jsonb_typeof(lane_plan) = 'array'),
  deadline_ms INTEGER NOT NULL CHECK (deadline_ms > 0),
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'degraded', 'failed')),
  degraded_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  deadline_exceeded_stage TEXT,
  timings JSONB NOT NULL CHECK (jsonb_typeof(timings) = 'object'),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (retrieval_run_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (source_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id, user_id
    ),
  FOREIGN KEY (compiled_context_id, user_id)
    REFERENCES compiled_contexts(compiled_context_id, user_id)
);

CREATE INDEX retrieval_runs_user_started_idx
  ON retrieval_runs(user_id, started_at DESC);

CREATE INDEX retrieval_runs_compiled_context_idx
  ON retrieval_runs(compiled_context_id)
  WHERE compiled_context_id IS NOT NULL;

-- Run-row state may only move forward: running -> completed / degraded /
-- failed with only the outcome columns changing, plus the one compile-commit
-- backfill of compiled_context_id (nullable until the CompiledContext save).
CREATE FUNCTION enforce_retrieval_run_outcome_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND NEW.retrieval_run_id = OLD.retrieval_run_id
    AND NEW.user_id = OLD.user_id
    AND NEW.daily_session_id = OLD.daily_session_id
    AND NEW.source_event_revision_id = OLD.source_event_revision_id
    AND NEW.retrieval_policy_version = OLD.retrieval_policy_version
    AND NEW.query_construction_policy_version = OLD.query_construction_policy_version
    AND NEW.projection_policy_version = OLD.projection_policy_version
    AND NEW.query_source_refs = OLD.query_source_refs
    AND NEW.normalized_query_terms = OLD.normalized_query_terms
    AND NEW.lane_plan = OLD.lane_plan
    AND NEW.deadline_ms = OLD.deadline_ms
    AND NEW.started_at = OLD.started_at
    AND (
      (
        OLD.status = 'running'
        AND NEW.status IN ('completed', 'degraded', 'failed')
      )
      OR
      (
        -- compile-commit link backfill, exactly once
        NEW.status = OLD.status
        AND OLD.compiled_context_id IS NULL
        AND NEW.compiled_context_id IS NOT NULL
      )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Retrieval run rows are immutable after the outcome update'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER retrieval_runs_outcome_update_guard
BEFORE UPDATE OR DELETE ON retrieval_runs
FOR EACH ROW
EXECUTE FUNCTION enforce_retrieval_run_outcome_update();

CREATE TABLE retrieval_run_candidates (
  retrieval_run_candidate_id UUID PRIMARY KEY,
  retrieval_run_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_version_id UUID NOT NULL,
  claim_retrieval_projection_id UUID NOT NULL,
  retrieval_lane TEXT NOT NULL
    CHECK (retrieval_lane IN ('structured_exact', 'lexical_term_overlap', 'english_fts')),
  matched_fields JSONB NOT NULL
    CHECK (jsonb_typeof(matched_fields) = 'array'),
  matched_terms JSONB NOT NULL
    CHECK (jsonb_typeof(matched_terms) = 'array'),
  trust_fence_results JSONB NOT NULL
    CHECK (jsonb_typeof(trust_fence_results) = 'array'),
  rank_components JSONB NOT NULL
    CHECK (jsonb_typeof(rank_components) = 'object'),
  final_rank INTEGER CHECK (final_rank > 0),
  selected_section TEXT
    CHECK (selected_section IN ('person_portrait', 'objective_memory', 'ai_impression')),
  selection_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  rejection_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (retrieval_run_id, memory_claim_version_id),
  UNIQUE (retrieval_run_candidate_id, user_id),
  FOREIGN KEY (retrieval_run_id, user_id)
    REFERENCES retrieval_runs(retrieval_run_id, user_id),
  FOREIGN KEY (memory_claim_version_id, user_id)
    REFERENCES memory_claim_versions(memory_claim_version_id, user_id),
  FOREIGN KEY (claim_retrieval_projection_id, user_id)
    REFERENCES claim_retrieval_projections(
      claim_retrieval_projection_id, user_id
    )
);

CREATE INDEX retrieval_run_candidates_run_idx
  ON retrieval_run_candidates(retrieval_run_id, user_id);

CREATE FUNCTION enforce_retrieval_run_candidate_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Retrieval run candidate rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER retrieval_run_candidates_immutable
BEFORE UPDATE OR DELETE ON retrieval_run_candidates
FOR EACH ROW
EXECUTE FUNCTION enforce_retrieval_run_candidate_immutability();

-- The CompiledContext carries the compact retrieval manifest (run id, policy
-- versions, source refs, normalized terms, lane plan, outcome counters); the
-- per-candidate detail stays in retrieval_run_candidates (Inspector joins).
ALTER TABLE compiled_contexts
  ADD COLUMN retrieval_manifest JSONB
    CHECK (retrieval_manifest IS NULL OR jsonb_typeof(retrieval_manifest) = 'object');

-- Retrieval failure closes the round's memory: the conversation continues
-- without any memory injection and the reason is recorded on the context
-- (ADR-0111 degradation; detailed codes live on the retrieval run).
ALTER TABLE compiled_contexts
  DROP CONSTRAINT compiled_contexts_degraded_reason_check;
ALTER TABLE compiled_contexts
  ADD CONSTRAINT compiled_contexts_degraded_reason_check
    CHECK (degraded_reason IN (
      'raw_event_budget_exceeded',
      'dialogue_state_failed',
      'dialogue_state_lagging',
      'rolling_summary_failed',
      'fast_path_pending',
      'memory_retrieval_failed'
    ));
