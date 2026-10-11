---
status: accepted
date: 2026-08-24
---

# Memory recall starts with structured-lexical retrieval

Core Flow 1A.3a must first prove that admitted Memory improves conversation for the single
Internal Owner without increasing incorrect or intrusive recall. It therefore ships a
`Structured-Lexical Retrieval Baseline` over PostgreSQL Claim, Entity, temporal and localized
projection data. The first release does not activate an Embedding Champion, install pgvector,
create vector columns or implement a production Embedding adapter. Retrieval manifest,
versioned budgets, per-item trust fences, Context Inspector and grounding checks still ship so
the baseline produces evidence about misses and false positives.

The initial release injects eligible selected Memory directly into CompiledContext; it does not
add a shadow-only retrieval mode or maintain a second "selected but not injected" rollout state.
The Context Inspector shows the exact Memory items actually injected, alongside candidates,
selection and rejection reasons, so the Internal Owner can experience and inspect the same path.
Quality comparison uses explicit non-authoritative Replay, not production shadowing: the same
frozen conversation input is generated once with the selected Memory and once with Memory
sections removed, then evaluated blind under ADR-0110 / ADR-0114.

This amends ADR-0113 only for the initial 1A.3a retrieval mechanism. ADR-0064 remains the
contract for a future vector index: pgvector is allowed only as a rebuildable projection and
never as the source of truth. Reconsider Embedding after retrieval evidence shows a stable
semantic-recall failure that structured and lexical paths cannot solve, an authorized-data
prototype improves that failure without increasing incorrect recall, and the selected Provider
passes SayHear's privacy checks. Until then, `embedding` has no active Champion and runtime does
not silently switch to a vector Provider.

## Amendment (2026-10, issue #316, ADR-0151): original-text lookup is a separate, in-place lexical path

This ADR covers recall of **admitted Claims** only. Finding an ordinary older experience that
never became a Claim is a different mechanism and does not change the Claim retrieval baseline:
the Decision may propose a bounded read-only search (a few equivalent keywords, optional people
clues, optional date range) over the owner's retained User text. It runs in PostgreSQL by
deterministic substring / word-boundary matching over normalized text, with no embedding, no
pgvector and no `pg_trgm`/fuzzy extension, and without a rebuildable lexical projection: the
bounded in-place scan avoids a second private copy of the text (so no new Purge surface, index or
rebuild path), and the search clues live only in the already registered private
`history_recall_results.plan`. Clues are not user facts and never create a Claim, Entity or
alias. A person clue widens only through the verified labels of exactly one Entity and never
selects a message on its own. Result coverage is reported honestly (scanned rows, whether the
requested range was reached, groups omitted): a lexical miss, a top-k cut or a finished bounded
scan never proves that something was not said or that a match is the earliest. A rebuildable
projection may be introduced only when measured scan latency requires it, together with its
Purge registration, invalidation and rebuild regressions.
