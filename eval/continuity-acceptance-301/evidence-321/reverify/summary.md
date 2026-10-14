| run | case | turn | kind | app | outcome | first text s | committed s | within 3/10 | live requests | output tokens (reasoning) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| after-short-clue-fix | H07 | where | history | warm | assistant_committed | 23.9 | 24.4 | NO | 2 | 3783 (3609) |
| after-short-clue-fix | H07 | party | history | warm | assistant_committed | 12.3 | 12.9 | NO | 2 | 1678 (1487) |
| after-short-clue-fix | H07 | september | history | warm | assistant_committed | 18.0 | 19.3 | NO | 2 | 2536 (2297) |
| after-short-clue-fix | H11 | empty | history | warm | assistant_committed | 4.4 | 4.7 | NO | 2 | 423 (307) |
| after-short-clue-fix | H11 | older | history | warm | assistant_committed | 14.1 | 14.5 | NO | 2 | 1897 (1746) |
| after-short-clue-fix | H11 | earliest | history | warm | assistant_committed | 8.8 | 9.4 | NO | 2 | 1144 (965) |

Turns answered by the real Provider (cancelled ones excluded): 6. Within both limits: 0. Outside or never completed: 6.

| run | case | status | turns with no committed reply | criteria not passing |
| --- | --- | --- | --- | --- |
| after-short-clue-fix | H07 | fail | — | O-correction-source (fail), O-cancel-source (fail), O-timeline-source (fail), O-where-deadline (fail), O-party-deadline (fail), O-september-deadline (fail), S-current (needs-review), S-plan (needs-review), S-timeline (needs-review), P-stance (needs-review) |
| after-short-clue-fix | H11 | fail | — | O-earliest-source (fail), O-read-failure (not-run), O-empty-deadline (fail), O-older-deadline (fail), O-earliest-deadline (fail), S-empty (needs-review), S-older (needs-review), S-earliest (needs-review) |

