# Issue 307 date-semantics verification

This is a non-authoritative, fully synthetic evaluation artifact. No private
conversation or credential appears in these files. Response time is outside
this verification's scope and no elapsed-time measurements were collected.

The frozen same-session history reproduces the earlier failed scenario:

- User expression: August 20, 2026 at 23:50 in America/Los_Angeles. Kyoto with
  Maya occurred on Sunday, August 16; the user described excitement and nerves
  about moving to Portland next month.
- The earlier assistant response is frozen from the failed synthetic capture,
  without another model call.
- Current question: August 21 at 00:10 in the same timezone and Daily Session,
  asking what the user said yesterday and when the Kyoto visit happened.

`provider-request.json` records the actual request body produced by
ContextCompiler -> renderPermittedPayload -> Provider Egress -> OpenCode Go
adapter. The admission repository is an in-memory synthetic fixture. Database
admission, persistence, authorization and HTTP behavior are covered separately
by system tests. Transport headers and credentials are omitted.

`result.json` records exactly one real DeepSeek V4.1 Flash request, no retries or
continuations. The reply correctly recalls the Kyoto/Maya message and the
Portland feelings as yesterday's expression, while retaining August 16 as the
visit date. It no longer denies the presence of yesterday's same-session
message. Usage is 2,131 input tokens and 564 output tokens, including 486
reasoning tokens. The Provider did not report a monetary cost.

The artifact retains the pre-commit HEAD and the exact compiler source SHA256;
the dirty compiler source hash is authoritative for this run. The candidate
uses `context-compiler:time:v3`. v1 and v2 remain independently replayable; the
v2 fixture was captured before the v3 change and compares the complete original
payload in regression tests.

Final local validation passed: 160 test files, 2,027 tests, type and boundary
checks, production build and server-credential bundle check. The report gate
confirmed 40/40 system suites, 463 system tests and zero skipped tests. Standards
review approved; Spec review approved with non-blocking comments.

The final validation also covers the deployment identity fallback: a blank
Vercel Git SHA uses the explicit deployment SHA. This fixes CLI deployment
startup without changing the date compiler, release manifest or model pins.

One sampled response establishes this fixed scenario's result, not statistical
reliability. This run does not establish a production-browser conversation
result, full-day topic coverage or recall beyond the selected source history.
No additional Provider request is authorized by this artifact. Production
deployment identity and any remaining readback limits are recorded in Issue
307 and the delivery report.
