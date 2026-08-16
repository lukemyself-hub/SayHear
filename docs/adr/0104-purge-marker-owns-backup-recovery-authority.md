---
status: accepted
date: 2026-08-16
---

# Purge marker owns backup-recovery authority

New commands resolve and freeze the Internal Owner's current `data_epoch` from the authoritative business-database transaction; deployment configuration is not their epoch source. `SAYHEAR_EXPECTED_DATA_EPOCH` is removed without a replacement, as are synchronous read/write epoch parameters and legacy compatibility paths. Command-admission repositories own resolution inside their existing write transaction and share an Owner Epoch Fence for locking, active-owner validation, epoch capture, and failure classification. Only durable Commands and their Workflow payload, commit, and Egress fences retain a frozen epoch, because they cross transaction and time boundaries.

The content-free Purge Marker outside the business-database backup domain is the authority that invalidates an old backup. It is one latest high-water record per owner: a higher epoch atomically replaces it, an equal epoch is an immutable idempotent no-op, and a lower epoch is a no-op. A single Recovery Gate module compares that latest marker before every private read, write, or Provider Egress. It returns only content-free `open`, `reapply_required`, `needs_attention`, or `unavailable` results, and fails closed unless it returns `open`; callers do not implement their own cross-store comparison. It performs no destructive work. A separate operator-only, explicitly confirmed marker-reapply path advances a restored business database directly to the marker epoch, clears the restored content, and records verification without creating a later epoch or changing the marker. A static deployment epoch floor cannot provide per-purge anti-resurrection correctness and would invite the manual Vercel update this decision eliminates.
