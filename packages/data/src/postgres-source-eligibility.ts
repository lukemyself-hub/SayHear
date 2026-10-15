/**
 * Shared source-eligibility SQL for every path that may send retained original
 * conversation text to a model (recent background, controlled history review).
 *
 * The three predicates below used to be written out separately in the recent
 * source read, the dispatch/commit freshness recheck and (for history) a third
 * place. They are one rule, so they live here once:
 *
 *  - base availability: the Event is active, the revision is its current
 *    revision, not content-purged, and final or corrected;
 *  - explicit control association: an active Forget exclusion or a Correction
 *    that deactivated a linked Claim version names the revision's Evidence
 *    (ADR-0149: only explicit association, never semantic matching);
 *  - Assistant binding: an Assistant reply is only as eligible as the user
 *    revision whose request generated it.
 *
 * Fragments take SQL expressions (not values) so the callers keep their own
 * aliases and parameters.
 */

/**
 * `jsonb` of the first explicit control association on a revision, or SQL NULL
 * when none exists. Forget outranks Correction when both exist.
 */
export function controlExclusionSql(input: {
  revisionId: string;
  userId: string;
}): string {
  return `COALESCE(
    (
      SELECT jsonb_build_object(
        'controlId', exclusion.memory_forget_request_id::text,
        'reason', 'forget_association'
      )
      FROM evidence_items item
      INNER JOIN memory_forget_evidence_exclusions exclusion
        ON exclusion.evidence_item_id = item.evidence_item_id
       AND exclusion.user_id = item.user_id
      WHERE item.user_id = ${input.userId}
        AND item.source_revision_id = ${input.revisionId}
        AND item.status = 'active'
        AND exclusion.status = 'active'
      ORDER BY exclusion.created_at
      LIMIT 1
    ),
    (
      SELECT jsonb_build_object(
        'controlId', correction.memory_claim_correction_id::text,
        'reason', 'correction_association'
      )
      FROM claim_evidence_links link
      INNER JOIN evidence_items item
        ON item.evidence_item_id = link.evidence_item_id
       AND item.user_id = link.user_id
      INNER JOIN memory_claim_corrections correction
        ON correction.deactivated_claim_version_id =
          link.memory_claim_version_id
       AND correction.user_id = link.user_id
      WHERE link.user_id = ${input.userId}
        AND link.status = 'active'
        AND item.source_revision_id = ${input.revisionId}
      ORDER BY correction.created_at
      LIMIT 1
    )
  )`;
}

/** Final or corrected transcripts are the only text a model may be sent. */
export const ELIGIBLE_TRANSCRIPT_STATUSES_SQL = "('final', 'corrected')";

/**
 * Boolean: the user revision that generated an Assistant event is still that
 * event's current, non-purged, active revision. A superseded request makes its
 * reply ineligible (the adjacent-reply rule of a Correction).
 */
export function generatingUserRevisionIsCurrentSql(input: {
  generatingRevisionId: string;
  userId: string;
}): string {
  return `EXISTS (
    SELECT 1
    FROM conversation_event_revisions generating_revision
    INNER JOIN conversation_events generating_event
      ON generating_event.conversation_event_id =
        generating_revision.conversation_event_id
     AND generating_event.user_id = generating_revision.user_id
    WHERE generating_revision.conversation_event_revision_id =
        ${input.generatingRevisionId}
      AND generating_revision.user_id = ${input.userId}
      AND generating_event.lifecycle_status = 'active'
      AND generating_event.current_revision_id =
        generating_revision.conversation_event_revision_id
      AND generating_revision.content_purged_at IS NULL
  )`;
}
