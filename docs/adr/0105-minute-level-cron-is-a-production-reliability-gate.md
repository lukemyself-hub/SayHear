---
status: accepted
date: 2026-08-16
---

# Minute-Level Cron Is a Production Reliability Gate

The 1A.2 recovery scanner, outbox dispatcher, PostgreSQL leases, and Workflow application entrypoints are implemented and tested before deployment, but SayHear does not configure an active Vercel Cron while Internal Core is in development or preview. A minute-level Cron on a Vercel plan that supports it, a server-only `CRON_SECRET`, and an observed hosted canary are required together before the first production deployment that accepts real private data; a daily Cron is not an interim substitute. Until that gate is passed, engineers invoke the existing recovery surface explicitly in local and CI validation, and the absence of a Cron must not be read as a claim of production async reliability.

## Consequences

- `vercel.json` deliberately contains no recovery Cron in the current pre-production state, so Hobby development deployments do not require a Pro upgrade or silently advertise a daily recovery guarantee.
- The production release checklist must add and verify the minute-level `/api/internal/recovery/scan` schedule only when the Vercel plan, secret, deployment, and hosted artifact canary are ready together.
- This defers deployment activation only. It does not change ADR-0017 or ADR-0066: PostgreSQL remains authoritative, Workflow remains at-least-once orchestration, and production recovery still requires minute-level dispatch rather than a second scheduler or daily sweep.
