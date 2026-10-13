# Owner access

Only the configured Internal Owner can enter the Portal. An anonymous visitor
reaches GitHub sign-in without seeing conversation content.

## Sub-features

- `access-signin`: root and protected pages lead to GitHub sign-in.
- `access-anonymous`: protected API returns 401 without a session.
- `access-owner`: authenticated Owner reaches the real composer and access state.
- `access-oauth`: real GitHub callback maps only the configured Owner.

## How to get to it (user POV)

- Open `/` or `/internal` in the browser.
- Open `/internal/journals`, `/internal/context-inspector`, or `/internal/reflection-inspector` without a session.
- Choose `Sign in with GitHub` on the sign-in page.

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
- Real OAuth journey: in a separately configured isolated acceptance environment,
  choose the GitHub button, complete GitHub auth, and require the correct Owner
  composer after callback. Repeat with a non-Owner and require refusal. Capture
  content-free authentication outcome; keep credentials out of artifacts.

## Gotchas

- The local seed has inert OAuth client values. A complete OAuth journey fails
  its configuration precondition here and must be reported unverified.
- The default sign-in page requests an Auth.js-hosted GitHub icon. The driver
  records and blocks it; a blocked icon does not invalidate sign-in entry proof.
- Fixture cookies are only for this disposable database. Never install them in a
  production/preview browser or seed an existing Owner database.
- Closed recovery/backup gates differ from authentication failure. Read doctor
  output before calling a disabled composer an auth bug.
