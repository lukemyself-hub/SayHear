---
status: accepted
date: 2026-08-16
---

# GitHub Actions schedules the Internal Owner Recovery Scan

During the single Internal Owner phase, the deployed `GET /api/internal/recovery/scan` route is triggered by a GitHub Actions `schedule` workflow at an hourly, off-the-hour cadence (`13 * * * *`) instead of Vercel minute-level Cron, which would require a Vercel Pro upgrade before the first real private-data write. This deliberately relaxes the minute-level deployment requirement in `docs/architecture/13-durable-workflows.md`: the Owner accepts a nominal one-hour (occasionally 70–90 minute) recovery delay, and correctness never depends on the scheduler — only on database leases, idempotency keys, and the next scan — so a delayed or missed run delays recovery without losing data. GitHub Actions scheduling is not an SLA: scheduled workflows may be delayed under platform load and may be disabled after prolonged repository inactivity, and the workflow stays within the free Actions-minutes budget (744 runs/month at one billed minute each) with a downshift-before-pay rule if usage ever approaches the included minutes.

The workflow only issues an authenticated `Bearer CRON_SECRET` HTTPS call to the deployed route, logs content-free metadata (time, HTTP status, duration) only, exposes a `workflow_dispatch` input for manual and preview-URL runs, and adds no second scheduler service. It remains the Internal Owner phase's scheduling mechanism until a second real-data account, work toward External MVP, or a tighter recovery-latency requirement — at which point scheduling returns to Vercel Cron.
