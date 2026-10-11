-- #316: original-text experience search rides on the #314 history review.
--
-- No new table and no search index: the search scans the owner's retained User
-- text in place, bounded by the versioned policy, so there is no second copy of
-- private text to rebuild, invalidate or purge. The search clues live in the
-- already registered private `history_recall_results.plan` column.
--
-- The only schema change is the frozen Context reference vocabulary: a message
-- quoted because it matched the clues, and an adjacent message quoted only as
-- its neighbouring context, are recorded under their own selection reasons.
ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_recent_metadata_check;
ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_recent_metadata_check
  CHECK (
    (
      section = 'recent_conversation_context'
      AND daily_session_id IS NOT NULL
      AND expressed_at IS NOT NULL
      AND selection_reason IS NOT NULL
      AND selection_reason IN ('today', 'day_representation', 'budget_fill')
    )
    OR (
      section = 'history_recall_context'
      AND daily_session_id IS NOT NULL
      AND expressed_at IS NOT NULL
      AND selection_reason IS NOT NULL
      AND selection_reason IN (
        'history_date_range',
        'history_lexical_match',
        'history_lexical_context'
      )
    )
    OR (
      section NOT IN ('recent_conversation_context', 'history_recall_context')
      AND daily_session_id IS NULL
      AND expressed_at IS NULL
      AND occurred_at IS NULL
      AND selection_reason IS NULL
    )
  );
