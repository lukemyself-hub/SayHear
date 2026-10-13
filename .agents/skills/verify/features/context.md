# Context Inspector

The Owner opens the recorded Context of an assistant response through its message
link or the tool lookup. Sensitive source content remains separately gated.

## Sub-features

- `context-entry`: navigation reaches the tool.
- `context-message-link`: a response's `查看 context` carries the correct command ID.
- `context-lookup`: inspecting that command displays its recorded Context or explicit denial.
- `context-source-gates`: capabilities, recent step-up, and auditing protect exact content.
  The exact-content read is `GET /api/internal/inspection/conversation-content`;
  the Portal has no control for it.

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
- After `text` or `delivery`, run `drive "$VERIFY_RUN" context-trace`. It covers
  `context-message-link`, `context-lookup` and the denial half of
  `context-source-gates`:
  - chooses `page.getByRole('link', { name: '查看 context', exact: true })` and
    requires the URL's command ID to equal the stored reply's;
  - requires `page.getByRole('region', { name: 'Generation summary' })` to show
    that command and the stored attempt's `provider / model`;
  - reaches the tool through `检查工具`, fills
    `page.getByRole('textbox', { name: 'GenerationCommand ID' })` and chooses the
    exact `Inspect` button, requiring the same summary;
  - calls the exact-content endpoint with the fixture session and requires 403
    `elevated_capability_required`, no user text, and one new `denied` row in
    `sensitive_access_audits`.
- Allowed read: the `oauth` journey repeats the denied read, completes the real
  GitHub Evidence verification from Reflection Inspector, then requires 200 with
  the requested content, a recent `step_up_authenticated_at`, and `denied` then
  `allowed` audit rows. Never create a grant in order to report step-up passed.
- Injection/exclusion data and lineage groups under the summary are not asserted
  by any journey; inspect the saved ARIA snapshot when they matter.

## Gotchas

- The empty fixture has no command; a text journey is needed for message-link
  and lookup verification. Tool entry alone does not prove Context inspection.
- The fixture session grants no recent sensitive-read verification. Exact-content
  success needs the real step-up of the `oauth` profile.
- On the deterministic adapter the summary reads `openai / gpt-5.4`, the champion
  label that adapter keeps. Only `provider` shows a Provider that was called.
- Keep raw source/excerpts out of proof from a real Owner environment. Formal
  evidence uses only synthetic records in an isolated acceptance environment.
