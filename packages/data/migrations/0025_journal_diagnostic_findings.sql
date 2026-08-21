-- Journal validator diagnostics are advisory metadata, not publication gates.
-- The old epistemic status and model-valid boolean encoded decisions that are
-- no longer part of the Journal contract.
ALTER TABLE journal_statements
  DROP COLUMN epistemic_status;

ALTER TABLE journal_validation_results
  DROP COLUMN model_valid;

ALTER TABLE journal_validation_results
  ADD COLUMN diagnostic_status TEXT NOT NULL DEFAULT 'not_run'
    CHECK (diagnostic_status IN ('available', 'unavailable', 'not_run'));

CREATE TABLE journal_diagnostic_findings (
  journal_diagnostic_finding_id UUID PRIMARY KEY,
  journal_validation_result_id UUID NOT NULL REFERENCES journal_validation_results(journal_validation_result_id),
  journal_version_id UUID NOT NULL REFERENCES journal_versions(journal_version_id),
  journal_statement_id UUID NOT NULL REFERENCES journal_statements(journal_statement_id),
  code TEXT NOT NULL CHECK (code IN (
    'third_person_style',
    'evidence_grounding',
    'narrative_safety',
    'certainty_or_agreement'
  )),
  detail_code TEXT NOT NULL CHECK (detail_code IN (
    'first_person_expression',
    'evidence_support_unclear',
    'diagnosis_or_treatment_language',
    'prescriptive_language',
    'certainty_language',
    'agreement_language'
  )),
  CHECK (
    (code = 'third_person_style' AND detail_code = 'first_person_expression') OR
    (code = 'evidence_grounding' AND detail_code = 'evidence_support_unclear') OR
    (code = 'narrative_safety' AND detail_code IN ('diagnosis_or_treatment_language', 'prescriptive_language')) OR
    (code = 'certainty_or_agreement' AND detail_code IN ('certainty_language', 'agreement_language'))
  ),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (journal_validation_result_id, journal_statement_id, code, detail_code)
);

CREATE INDEX journal_diagnostic_findings_statement_idx
  ON journal_diagnostic_findings(journal_statement_id);

CREATE FUNCTION reject_journal_diagnostic_finding_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Journal diagnostic findings are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER journal_diagnostic_findings_immutable
BEFORE UPDATE OR DELETE ON journal_diagnostic_findings
FOR EACH ROW EXECUTE FUNCTION reject_journal_diagnostic_finding_mutation();
