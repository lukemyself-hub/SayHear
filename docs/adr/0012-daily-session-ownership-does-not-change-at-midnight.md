---
status: accepted
date: 2026-07-25
---

# Daily Session ownership does not change at midnight

A continuous exchange belongs to the user's local date captured when that exchange starts. Its Daily Session `logical_date` and `timezone_at_start` remain immutable: crossing midnight does not split, migrate, finalize, or independently trigger Journal generation for the active exchange. Journal evaluation waits for the exchange to end naturally.

After that exchange ends, the next exchange started on the new local date creates a new Daily Session. This preserves conversational and Journal coherence while giving Core Flow 1A.1 a deterministic routing rule that does not depend on server UTC or a midnight timer.
