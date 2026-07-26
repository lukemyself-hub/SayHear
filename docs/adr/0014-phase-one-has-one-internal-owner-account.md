---
status: accepted
date: 2026-07-25
---

# Phase 1 has one Internal Owner Account

Phase 1 Internal Core defaults to one Internal Owner Account as the only human identity allowed to write real private content. Other evaluation data must be synthetic, anonymized, or separately and explicitly authorized. Phase 1 does not build consumer registration, invitations, account recovery, multi-user lifecycle, role administration, or a user-management interface.

Every private domain record still carries a stable server-derived `user_id`, and APIs never trust a client-supplied owner identifier. This preserves the isolation invariant without prematurely building a multi-user product. Formal consumer identity, account lifecycle, multi-user isolation, and cross-account authorization testing are required in Phase 2 External MVP.
