# Journal

The Owner reads automatically delivered Journals by date, copies or exports the
published text, and opens that day's original Conversation.

## Sub-features

- `journal-empty`: no Journal produces an explicit empty state, not fabricated prose.
- `journal-date`: selected dates show their own current Journal or notice.
- `journal-delivery`: an eligible ended exchange eventually publishes a Journal.
- `journal-copy-export`: copy and PNG export preserve the selected Journal.
- `journal-conversation`: the backlink opens that day's read-only Conversation.

## How to get to it (user POV)

- Choose `日记` in module navigation (`/internal/journals`).
- Choose a listed date or open `/internal/journals?date=YYYY-MM-DD`.
- Choose `复制`, `导出` (PNG), or the Journal's Conversation link when a Journal exists.
- Continue expression in chat and end the exchange normally to receive automatic delivery.

## Driving it with Playwright

Preconditions: healthy Owner instance. Delivery/copy/export/date-entry journeys
require an eligible exchange, functioning asynchronous generation, and a published
synthetic Journal; the baseline seed has none.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" journal` for the empty
  journey. It chooses the exact `日记` link and checks the real region's notice.
- Require `page.getByRole('region', { name: '日记' })` to contain
  `还没有可读的日记` in an empty launch.
- Published journey: send substantive synthetic content and a genuine ending
  through the composer. Observe normal background delivery; require readable
  prose at `/internal/journals`, correct logical date/version, and persistence
  after reload. Record Workflow results as well as the screen.
- Date journey: click the matching `/internal/journals?date=...` link and separately
  visit that URL. Require the date's own prose/notice rather than the latest day's.
- Choose `page.getByRole('button', { name: '复制', exact: true })`; read clipboard
  after granting the isolated browser clipboard permission and compare to visible
  prose. Choose `page.getByRole('button', { name: '导出', exact: true })` while
  awaiting a download; save and open the PNG, checking actual content and dimensions.
- Follow the rendered `/internal?date=...` link and require read-only messages for
  that same date. Retain downloaded exports with the other proof.

## Gotchas

- Empty-state success does not verify publication, copy, export, or the backlink.
  Report those journeys as unmet when no published Journal exists.
- Local Next dev plus deterministic conversation replies is not proof that hosted
  Journal Workflow/role execution works. Do not insert a Journal row to claim delivery.
- Journal is not freely editable or manually approved. Do not invent a generate
  button or weaken automatic delivery to a service-method invocation.
- There are size guards and stale-version checks on export; inspect the actual
  downloaded image rather than accepting a click/download event as success.
