-- Journal diagnostic findings missed the 0019 purge-pass upgrade (the table
-- was added later in 0025): normal-path UPDATE/DELETE stays absolute; DELETE
-- is allowed only under a verified purge pass, same as evidence items (0010)
-- and journal artifacts (0011). Without this, any purge after a journal
-- eligibility run that produced findings fails deterministically.
CREATE OR REPLACE FUNCTION reject_journal_diagnostic_finding_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND sayhear_purge_pass_active() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Journal diagnostic findings are immutable' USING ERRCODE = '55000';
END;
$$;
