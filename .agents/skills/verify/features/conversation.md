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

Preconditions: fresh empty conversation and an allowed write gate. The
`keyboard` and `history` journeys need a fresh instance and build their own
history through the composer. `interruption` needs the `fault` profile;
`cross-date` needs `timeline`; both use the controlled clock instead of editing
session rows. Past-date navigation needs a completed prior-day exchange.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" text` on `local`,
  `live` or `provider`. It fills
  `page.getByRole('textbox', { name: '想聊些什么？' })`, chooses the exact `发送`
  button, observes the real response endpoint and reply, and reloads.
- Require exactly one rendered user message and settled assistant message;
  `text-stored.json` must independently show matching canonical rows and the
  reply's model run attempt. On `provider` the attempt's Provider must be the
  launched one, the rendered reply must equal the stored reply, and the result
  records `visibleReplyMs` beside the stored first-token and completion times.
- The canned journey visits the session's date URL and requires
  `page.getByRole('region', { name: '历史聊天记录' })`, no composer, preserved text,
  then chooses the exact `返回今天` link and requires the composer again.
- Keyboard journey: run `node scripts/verify-control.mjs drive "$VERIFY_RUN"
  keyboard` on `local`, `live`, `timeline` or `fault`. It types one line, requires
  `Shift+Enter` to add exactly one newline with no
  `/api/internal/conversation/responses` request, starts a browser-level
  composition with CDP `Input.imeSetComposition` and requires Enter during it to
  send nothing, then sends one multiline message with a single Enter and requires
  exactly one request, the stored canonical text and a settled reply.
  `keyboard-stored.json` records the observed composition and keydown events.
  This is emulated browser input; a real operating-system IME stays
  human-pending.
- Long-history journey: run `... history` on `local`, `live`, `timeline` or
  `fault` with a fresh instance. It sends 28 exchanges through the composer
  (56 events, past
  the 50-message window), reloads to require the bounded 25-exchange window,
  scrolls to the top, sends one more exchange and requires the viewport not to
  move and `回到最新` to appear and re-pin; then opens
  `/internal?date=YYYY-MM-DD`, requires `加载更早消息`, loads the rest, and
  requires all 29 exchanges exactly once with the anchor's viewport offset
  preserved.
- Fault journey: run `... interruption` on `fault`. It writes a one-chunk
  ceiling to the test-only fault file, sends a real reply that interrupts after
  the first delta, requires the interrupted item, `Retry response` and no
  committed assistant message, advances the controlled clock 24 hours and
  requires the read-only date page to only guide (`前往当前交流`) without
  writing, then clears the fault file, retries on `/internal` and requires one
  settled assistant message, one canonical user message and an idempotent replay
  of the exact retry request. A real Provider or network interruption stays
  unverified.
- Past-date entry: the `delivery` journey clicks the exact
  `a[href='/internal?date=YYYY-MM-DD']` for the ended exchange's date and
  requires the same read-only history as the URL entry. A date before today comes
  from the controlled clock in `interruption` and `cross-date`.

## Gotchas

- The current date is represented by `今天`; it has no dated history link in
  navigation. The canned URL journey does not prove a past-date link.
- The `keyboard` and `history` journeys need a fresh instance and fail their
  fresh-launch assertion on a used one; they build their own long history and
  emulated composition instead of depending on seeds.
- The fixed clock is July 27, 2026 in Los Angeles; do not expect host-date labels.
  Crossing midnight uses the `timeline` profile's controlled clock (`cross-date`),
  never edited session rows.
- Deterministic reply text proves transport/UI/persistence only. It cannot prove
  model behavior, source interpretation, or natural conversation quality. One
  `provider` reply adds real transport and latency, still not quality or
  continuity; those belong to the continuity acceptance of Issue #321.
- The composer stays disabled while a reply is in flight. Wait for it to enable.
  Awaiting `response.finished()` on the NDJSON stream hung this driver.
