# Text conversation and history

The Owner sends text, sees the assistant response, and can read persisted
messages by date without writing into a historical conversation.

## Sub-features

- `text-send`: button send clears the composer and renders a settled reply.
- `text-persist`: reload shows one canonical user and assistant message.
- `text-keyboard`: Enter sends, Shift+Enter adds a newline, IME composition does not submit.
- `history-read`: date URL renders read-only messages and returns to current chat.
- `history-navigation`: date links, older pages/messages, scroll position and interruption handling.

## How to get to it (user POV)

- Choose the `聊天` module or `今天` at `/internal`.
- Send using `发送` or Enter in `想聊些什么？`.
- Choose a past date in navigation, open `/internal?date=YYYY-MM-DD`, or follow
  a Journal's Conversation link.
- Choose `返回今天`/`返回交流`, `加载更早消息`, or `回到最新` when available.
- For an interrupted response, choose `Retry response` in current chat; historical
  interruptions lead back to today's conversation instead of mutating history.

## Driving it with Playwright

Preconditions: fresh empty conversation and an allowed write gate. For pagination
and scroll journeys, populate enough synthetic messages through the composer to
exceed the bounded window. Past-date navigation needs a completed prior-day exchange.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" text`. It fills
  `page.getByRole('textbox', { name: '想聊些什么？' })`, chooses the exact `发送`
  button, observes the real response endpoint and reply, and reloads.
- Require exactly one rendered user message and settled assistant message;
  `text-stored.json` must independently show matching canonical rows.
- The canned journey visits the session's date URL and requires
  `page.getByRole('region', { name: '历史聊天记录' })`, no composer, preserved text,
  then chooses the exact `返回今天` link and requires the composer again.
- Keyboard journey: fill the same textbox, use `input.press('Shift+Enter')`, and
  require a newline with no response request; use `input.press('Enter')` and
  require one response. During actual IME composition, Enter must not submit;
  a plain keypress alone does not verify IME behavior.
- Past-date entry: click the exact `a[href='/internal?date=YYYY-MM-DD']` using the
  actual seeded date. Require the same read-only history as the URL entry.
- Long-history journey: choose `page.getByRole('button', { name: '加载更早消息' })`;
  require older distinct messages and preserved reading position. Reading old
  content while a reply arrives must not force-scroll; `回到最新` must restore follow.
- Fault journey: use the existing test-only Provider interruption controls in a
  dedicated launch. Require an interrupted indicator and `Retry response`, then
  a separate retry result without duplicate user submission. Record the fault
  settings and canonical rows; ordinary replies do not prove retry recovery.

## Gotchas

- The current date is represented by `今天`; it has no dated history link in
  navigation. The canned URL journey does not prove a past-date link.
- Empty launch lacks prior dates, long history, interruptions, and Journal links;
  those journeys fail their seed preconditions until explicitly prepared.
- The fixed clock is July 27, 2026 in Los Angeles; do not expect host-date labels.
  Crossing midnight requires a controlled-clock journey, not editing session rows.
- Deterministic reply text proves transport/UI/persistence only. It cannot prove
  model behavior, source interpretation, or natural conversation quality.
