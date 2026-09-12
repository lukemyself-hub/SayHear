# Issue #206 implementation contract

## Goal

Add the C3 execution seam for one optional, independently generated proactive
follow-up segment after an ordinary Conversation Decision. The segment is
tools-disabled, hidden while it is generated, and can only become visible as
part of the same Complete Assistant Response transaction as the main response.

## Expected production change

- Production files: about 7 TypeScript files plus one forward SQL migration.
- Production TypeScript: about 450 lines; tests and this contract are not
  counted in the bound.
- Architecture boundaries: 2 — application Harness/Segment stage and
  PostgreSQL response/proactive persistence.
- Migration: yes; add the Assistant Event generation-lineage link table and
  allow the explicit `proactive_followup` generation stage.
- Runtime/release wiring: no production enablement. The role stays closed until
  the evaluated release manifest opens it.
- Risk: HIGH, because the response commit must preserve fail-closed fencing and
  atomic Event/use/usage-marker behavior.

## Implementation layers

1. **Application seam.** Define the typed Segment stage and output validator;
   integrate it into the Harness only after a completed main response with no
   ordinary question. Segment output is buffered and emitted only after the
   repository reports a successful combined commit. Add unit/conformance tests
   for skip, success, invalid output, interruption, and no retry.
2. **Persistence seam.** Add the forward migration and purge-surface entry;
   extend response commit to compose the main and segment text, write both
   lineage links, and call the existing C2 atomic use commit in the same
   transaction. A pre-display fence omits the segment and commits the main
   response only. Add focused PostgreSQL fixture coverage where the database is
   available.
3. **Integration gate.** Reconcile the Issue/ADR contract, run targeted tests,
   typechecks, boundary and purge inventory checks, then the full available
   suite once. Keep the proactive role disabled and record any unavailable
   real-PostgreSQL or hosted evidence explicitly.

## Validation

- `CI=true pnpm exec vitest run packages/application/src/conversation-agent-harness.test.ts packages/application/src/proactive-followup.test.ts`
- `CI=true pnpm exec vitest run packages/ai/src/conversation-agent-harness.conformance.test.ts`
- `CI=true pnpm typecheck`
- `CI=true pnpm check:boundaries`
- `CI=true pnpm check:purge-surfaces`
- `TEST_DATABASE_URL=... CI=true pnpm exec vitest run tests/system/proactive-followup.system.test.ts` when the real PostgreSQL fixture is available.
- Final `CI=true pnpm validate` if dependency/build/database prerequisites are available.
