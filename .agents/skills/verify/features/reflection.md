# Reflection Inspector

The Owner reads current Daily or Weekly Reflection prose and traces its lineage.
Opening the user's exact Evidence requires a separate recent verification.

## Sub-features

- `reflection-entry`: tool route and direct permalink open the Inspector.
- `reflection-scope`: Daily/Weekly selection lists the appropriate records.
- `reflection-trace`: opening a record shows current prose, lineage, and dispositions.
- `reflection-evidence`: collapsed Evidence does not prefetch; expansion needs step-up and audit.

## How to get to it (user POV)

- Choose `检查工具`, then `Reflection Inspector` in the tool list.
- Open `/internal/reflection-inspector` or its `?reflection_id=...` permalink.
- Choose a scope in `Reflection 范围`, open a listed record, or type `Reflection ID (optional)` and choose `Inspect`.
- Choose `Verify again to view original Evidence` before expanding an exact excerpt.

## Driving it with Playwright

Preconditions: healthy Owner instance. Prose/trace journeys require generated
synthetic Daily/Weekly records in an isolated G1 acceptance environment with valid
authorization; do not enable G1 or invent pins as verification scaffolding.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" reflection` for direct
  entry only. Require the exact `Reflection Inspector` heading and Evidence
  verification button. It does not claim a generated Reflection exists.
- Tool-list entry: choose the exact `检查工具` link, then the rendered
  `a[href='/internal/reflection-inspector']`. Require the same Inspector.
- Use `page.getByRole('group', { name: 'Reflection 范围' })` to scope the real Daily/Weekly controls;
  require only the matching records and then open a record's actual button.
- Fill `page.getByRole('textbox', { name: 'Reflection ID (optional)' })` with a
  known generated ID and choose the exact `Inspect` button. Separately visit the
  permalink. Require matching current prose/version, source lineage, validation,
  Candidate disposition, Claim eligibility and Bio impact when present.
- Before expanding Evidence, capture network traffic and require no exact-excerpt
  request. Without recent verification, expansion must deny without source text
  and record its content-free audit. Complete normal GitHub step-up, expand one
  excerpt, and verify only that requested excerpt plus audit. Prose should remain
  readable with its Owner capability without repeated step-up.

## Gotchas

- The baseline has no Reflections and closes their write switch. Daily/Weekly
  trace and Evidence journeys fail their seed/authorization preconditions here;
  an empty list or visible button does not verify them.
- Normal Owner login and sensitive Evidence verification are distinct. Do not
  manually set a grant timestamp to claim successful reauthentication.
- Published prose and later regeneration failure are different states; verify
  the actual current version before claiming the readable Reflection was lost.
