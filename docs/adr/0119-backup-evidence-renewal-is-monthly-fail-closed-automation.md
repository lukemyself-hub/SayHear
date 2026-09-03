---
status: accepted
date: 2026-09-02
---

# Backup Evidence Renewal Is Monthly Fail-Closed Automation

During the single Internal Owner phase, the verified backup policy evidence row required by ADR-0080 is renewed by a GitHub Actions `schedule` workflow that runs monthly and re-verifies the Neon project's PITR history window through the Neon API before recording fresh evidence with a 30-day validity. Renewal happens if — and only if — the machine-read `history_retention_seconds` equals the value pinned to the current configuration fingerprint (`21600` for `neon-free-6h-pitr-1gb-limit`, i.e. the free plan's 6-hour history window).

The comparison is fail-closed in the same direction as the private-write gate: an API failure, an unexpected response shape, or any window mismatch stops the workflow without recording new evidence, and the gate then blocks when the current evidence expires instead of extending validity onto an unverified configuration. Renewal reuses the `db:record-backup` CLI — the same validation and longest-known-window computation as manual recording — so evidence writes have exactly one code path. Credentials live as repository secrets (`NEON_API_KEY`, `PROD_DATABASE_URL`) and logs stay content-free.

The workflow follows ADR-0106's scheduling posture: GitHub Actions `schedule`, `workflow_dispatch` for manual runs, monthly cadence within the free Actions-minutes budget, and no second scheduler service. The fingerprint's non-machine-readable claims — the 7-day Neon deleted-project recovery window and the free-plan 1 GB storage limit — remain operator console checks recorded in the evidence reference at renewal time; if Neon changes them materially, the operator updates the fingerprint and expectations deliberately rather than letting automation carry stale claims forward.
