# Journal

The Owner reads automatically delivered Journals by date, copies or exports the
published text, and opens that day's original Conversation.

## Sub-features

- `journal-empty`: no Journal produces an explicit empty state, not fabricated prose.
- `journal-date`: selected dates show their own current Journal or notice.
- `journal-delivery`: an eligible ended exchange eventually publishes a Journal.
- `journal-copy-export`: copy and the text-file export preserve the selected Journal.
- `journal-conversation`: the backlink opens that day's read-only Conversation.

## How to get to it (user POV)

- Choose `日记` in module navigation (`/internal/journals`).
- Choose a listed date or open `/internal/journals?date=YYYY-MM-DD`.
- Choose `复制`, `导出` (a `sayhear-journal-YYYY-MM-DD.txt` download), or `查看当天聊天` when a Journal exists.
- Say something substantive in chat and stop. Delivery follows the inactivity
  window and the next scheduled scan; there is no generate or end button.

## Driving it with Playwright

Preconditions: healthy Owner instance. Delivery/copy/export/date-entry journeys
need an exchange that ends, so launch the `live` or `provider` profile; `local`
has a fixed clock and no exchange ever ends there. The `cross-date` journey
launches `timeline` or `fault`: both carry the test-only file clock, and
`fault`'s fault file stays empty unless a journey writes it.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" journal` for the empty
  journey. It chooses the exact `日记` link and checks the real region's notice.
- Require `page.getByRole('region', { name: '日记' })` to contain
  `还没有可读的日记` in an empty launch.
- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" delivery` on a fresh
  `live` or `provider` instance. It covers `journal-delivery`, `journal-date`,
  `journal-copy-export` and `journal-conversation` in one pass:
  - sends substantive synthetic text through the composer and stays idle past the
    60 s inactivity window;
  - calls `/api/internal/recovery/scan` with the instance's scanner secret, as the
    GitHub Actions schedule does, and reloads `/internal/journals` until `复制`
    appears;
  - requires `delivery-stored.json` to show the session `quiescent` by
    `inactivity_timeout`, one `published` workflow outcome, one Journal with a
    current version, and dispatched outbox events;
  - reloads, clicks the `/internal/journals?date=...` link, and visits that URL;
  - chooses `page.getByRole('button', { name: '复制', exact: true })` and compares
    the clipboard with the visible prose;
  - chooses `导出`, saves the download as `delivery-export.txt`, and requires the
    suggested name, the date line and the prose;
  - follows `查看当天聊天` and requires that date's read-only messages.
- On `provider` the same journey makes paid `journal.draft` and `journal.validate`
  calls; `delivery-stored.json` records their Provider and model. Its workflow
  steps took 13 to 17 s in the one attempt so far, and a scan that overlapped them
  returned 500 after waiting ten seconds for the Owner row lock
  ([#341](https://github.com/lukemyself-hub/SayHear/issues/341)). That attempt
  ran before the journey tolerated failed scans, so no `provider` Journal has
  been observed yet.
- Cross-date journey: run `... cross-date` on `timeline` with a fresh instance.
  It sends a day-1 exchange, advances the controlled test clock two minutes, runs
  the scheduled scan until the first Journal publishes, advances the clock 24
  hours, sends a day-2 exchange, and publishes the second Journal. It then reads
  each date through its module date entry and its URL, compares the rendered
  prose with that date's stored statements, copies, exports and follows
  查看当天聊天, requiring each date's own expression and not the other's. The
  clock file is re-read per request; no session row or generation result is
  edited. Two 2026-10-13 attempts lost a Journal workflow to the #340 deadlock
  (`dev-345-cross-date-1` at day-1, `dev-345-cross-date-2` at day-2 after day-1
  published); real-run evidence for this journey waits for that fix.

## Gotchas

- Empty-state success does not verify publication, copy, export, or the backlink.
  Report those journeys as unmet when no published Journal exists.
- The `delivery` journey proves admission, outbox, Workflow steps, role calls,
  publication and the Portal on the local Workflow runtime. Hosted Vercel
  Workflow dispatch, callback redelivery and the real schedule stay unverified.
  Do not insert a Journal row to claim delivery.
- The journey runs no scan during the idle window, so its first scan dispatches
  fast-path extraction, dialogue state and Journal eligibility together. Their
  transactions deadlock in most runs, and when the Journal path is the victim no
  Journal is published
  ([#340](https://github.com/lukemyself-hub/SayHear/issues/340); 3 of 13 runs).
  The journey then fails and writes `delivery-unpublished.json`; both 2026-10-13
  `cross-date` attempts failed the same way and wrote
  `cross-date-unpublished-<date>.json`. Confirm with
  `grep "deadlock detected" postgres.log` before suspecting the driver.
- After the exchange ends, `今天` incorrectly shows an empty chat while the dated
  navigation link still exposes that day's messages
  ([#344](https://github.com/lukemyself-hub/SayHear/issues/344)). The journey records
  `todayShowsEndedExchange: false`. After the product fix, require `true` and add
  a same-day follow-up message assertion before calling this path verified.
- Journal is not freely editable or manually approved. Do not invent a generate
  button or weaken automatic delivery to a service-method invocation.
- Export is plain text and refuses Journals over 20,000 characters or a stale
  selected date; read the downloaded file rather than accepting a download event.
