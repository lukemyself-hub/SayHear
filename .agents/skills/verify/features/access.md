# Owner access

Only the configured Internal Owner can enter the Portal. An anonymous visitor
reaches GitHub sign-in without seeing conversation content.

## Sub-features

- `access-signin`: root and protected pages lead to GitHub sign-in.
- `access-anonymous`: protected API returns 401 without a session.
- `access-owner`: authenticated Owner reaches the real composer and access state.
- `access-oauth`: real GitHub callback maps only the configured Owner.
- `access-refusal`: a GitHub account that is not the Owner gets no session.
- `access-signout`: sign-out removes the database session.

## How to get to it (user POV)

- Open `/` or `/internal` in the browser.
- Open `/internal/journals`, `/internal/context-inspector`, or `/internal/reflection-inspector` without a session.
- Choose `Sign in with GitHub` on the sign-in page.
- Open `/api/auth/signout` and choose `Sign out`. The Portal has no sign-out control.

## Driving it with Playwright

Preconditions: healthy isolated instance; a fresh anonymous browser context for
denial checks. The canned journey requires no GitHub credentials.

- Run `node scripts/verify-control.mjs drive "$VERIFY_RUN" access`. It visits `/`,
  requires `/api/auth/signin`, locates `page.getByRole('button', { name: 'Sign in with GitHub' })`,
  and independently requires `/api/internal/access` to return 401.
- For each protected page above, use `page.goto(state.origin + path)` in an
  anonymous context. Require sign-in, the original callback path, and no content.
- `doctor` verifies the seeded Owner's `/internal` response and enabled write gate.
  This proves normal database-session consumption, not OAuth login.
- Real OAuth journey: launch the `oauth` profile and run
  `node scripts/verify-control.mjs drive "$VERIFY_RUN" oauth`. A person signs in
  to GitHub in the opened window. It requires the Owner composer after the
  callback, `/api/internal/access` 200, and exactly one `auth_sessions` row for
  the Owner, then continues into the Evidence verification of
  [Context Inspector](context.md) and ends with sign-out.
- When the GitHub account signs in through Google, run `drive "$VERIFY_RUN"
  oauth-manual` instead. The person performs the same steps in their own browser
  and the driver requires the same rows: one Owner session after a logged
  callback, a `denied` audit, a recent grant after a second callback, an
  `allowed` audit, then zero sessions.
- Refusal journey: launch `oauth-stranger` and run the same command. The instance
  maps its Owner to a synthetic subject, so the same GitHub account is a
  non-Owner. It requires the real callback, a landing page other than `/internal`
  with `error=OAuthCreateAccount`, 401, zero sessions, and an unchanged
  `internal_owner_identities` row count.
- Sign-out journey: `drive "$VERIFY_RUN" signout` on a fixture-session profile, or
  the tail of the `oauth` journey. Require 401, zero `auth_sessions` rows, and
  sign-in on the next visit.

## Gotchas

- `local`, `live` and `provider` have inert OAuth client values. A complete OAuth
  journey fails its configuration precondition there and must be reported
  unverified.
- The `oauth` doctor proves the hand-off to GitHub's authorize endpoint with the
  registered callback. It does not prove the callback; only the journey does.
- The OAuth profiles prove the local OAuth app against a disposable database. The
  hosted acceptance OAuth app and its Owner mapping are a separate proof.
- The default sign-in page requests an Auth.js-hosted GitHub icon. The driver
  records and blocks it; a blocked icon does not invalidate sign-in entry proof.
- Fixture cookies are only for this disposable database. Never install them in a
  production/preview browser or seed an existing Owner database.
- Closed recovery/backup gates differ from authentication failure. Read doctor
  output before calling a disabled composer an auth bug.
