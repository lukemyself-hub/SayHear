---
status: accepted
date: 2026-09-07
---

# Bio writing and validation have separate command budgets

`bio.write` and `narrative.validate` use separate GenerationCommands and
attempt ledgers. A Bio writer command permits an initial attempt, at most one
same-model technical retry, and at most one semantic repair. Every draft that
might publish, including a repaired draft, requires a new validator command;
each validator command permits at most one same-model technical retry. The
complete workflow therefore has a bounded worst case of seven Provider calls,
not three.

The larger explicit bound avoids treating validation as bookkeeping or
publishing a repaired Bio under an earlier verdict. Exhaustion keeps the prior
Bio only for an ordinary refresh. During Bio Trust Rebuild, the invalidated Bio
remains unavailable.
