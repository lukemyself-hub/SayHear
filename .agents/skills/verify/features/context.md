# Context Inspector

The Owner opens the recorded Context of an assistant response through its message
link or the tool lookup. Sensitive source content remains separately gated.

## Sub-features

- `context-entry`: navigation reaches the tool.
- `context-message-link`: a response's `查看 context` carries the correct command ID.
- `context-lookup`: inspecting that command displays its recorded Context or explicit denial.
- `context-source-gates`: capabilities, recent step-up, and auditing protect exact content.

## How to get to it (user POV)

- Choose `检查工具`, then `Context Inspector` (`/internal/context-inspector`).
- Choose `查看 context` beside a persisted assistant message.
- Paste a command ID into `GenerationCommand ID` and choose `Inspect`.
- Open `/internal/context-inspector?generation_command_id=...` for a known command.

## Driving it with Playwright

Preconditions: healthy Owner instance. A persisted reply supplies a real command
ID; permission/step-up requirements must be met through the normal product path
before any sensitive-read success can be claimed.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" context` for entry only.
  Require the exact `Context Inspector` heading and `GenerationCommand ID` textbox.
- After a text journey, choose
  `page.getByRole('link', { name: '查看 context', exact: true })`. Require the URL
  to contain that reply's command ID, and correlate it with recorded response proof.
- Independently fill `page.getByRole('textbox', { name: 'GenerationCommand ID' })`
  with the same ID and choose the exact `Inspect` button. Capture GET response,
  result/denial, and screen. The message-link and typed lookup are separate entries.
- For authorized inspection, require the real recorded generation summary,
  injection/exclusion data, and lineage, with no product-state mutation.
- With no recent step-up or insufficient capability, require explicit denial and
  absence of raw source text. Compare content-free audit outcome using a read-only
  database check; never create a grant in order to report step-up passed.

## Gotchas

- The empty fixture has no command; a text journey is needed for message-link
  and lookup verification. Tool entry alone does not prove Context inspection.
- The fixture session grants no recent sensitive-read verification. Exact-content
  success needs real step-up; the local inert OAuth client cannot complete it.
- Keep raw source/excerpts out of proof from a real Owner environment. Formal
  evidence uses only synthetic records in an isolated acceptance environment.
