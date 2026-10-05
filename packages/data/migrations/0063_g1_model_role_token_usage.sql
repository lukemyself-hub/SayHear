-- G1 content-free token monitoring: persist the four-role attempt spend.
--
-- input_tokens/output_tokens already exist on model_run_attempts. Reasoning,
-- cached input, and provider-reported total were only visible inside the
-- Provider process, so a released G1 run could not prove what it actually
-- spent, including failed, retried, and discarded attempts. This migration
-- adds the three missing counters as nullable BIGINTs. Unknown is NULL, never
-- an invented zero or a derived sum; a non-negative CHECK keeps a malformed
-- count out of the ledger. No prompt, Provider output schema, model, cap, gate, routing, or
-- retry behavior changes.
ALTER TABLE model_run_attempts
  ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cached_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT;

ALTER TABLE model_run_attempts
  ADD CONSTRAINT model_run_attempts_reasoning_tokens_check
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  ADD CONSTRAINT model_run_attempts_cached_tokens_check
    CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  ADD CONSTRAINT model_run_attempts_total_tokens_check
    CHECK (total_tokens IS NULL OR total_tokens >= 0);
