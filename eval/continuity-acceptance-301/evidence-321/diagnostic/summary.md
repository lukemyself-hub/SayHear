| run | case | turn | kind | app | outcome | first text s | committed s | within 3/10 | live requests | output tokens (reasoning) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| effort-low | H01 | recap | ordinary | warm | response_failed | — | — | NO | 1 | 0 (0) |
| effort-low | H01 | detail | history | warm | response_interrupted | 26.4 | — | NO | 2 | 681 (572) |
| effort-low | H02 | said | history | warm | assistant_committed | 9.2 | 10.0 | NO | 2 | 969 (789) |
| effort-low | H02 | happened | history | warm | assistant_committed | 24.7 | 25.3 | NO | 2 | 3236 (3012) |
| effort-low | H02 | when | ordinary | warm | assistant_committed | 6.0 | 6.2 | NO | 1 | 634 (608) |
| effort-low | H02 | market-when | ordinary | warm | assistant_committed | 2.7 | 3.1 | yes | 1 | 234 (191) |
| effort-low | H04 | ask | ordinary | warm | response_failed | — | — | NO | 1 | 212 (132) |
| effort-low | H09 | light | history | warm | assistant_committed | 18.5 | 18.7 | NO | 2 | 1954 (1858) |
| effort-low | H09 | recall | history | warm | assistant_committed | 28.9 | 29.3 | NO | 2 | 3649 (3518) |
| effort-low | H09 | turn | ordinary | warm | assistant_committed | 8.1 | 8.5 | NO | 1 | 759 (706) |
| effort-low | H09 | probe | ordinary | warm | assistant_committed | 7.4 | 8.4 | NO | 1 | 776 (669) |
| effort-low | H12 | work | history | warm | response_failed | — | — | NO | 2 | 237 (168) |
| history-closed | H04 | ask | ordinary | warm | assistant_committed | 2.4 | 2.8 | yes | 1 | 276 (223) |
| history-closed | H11 | empty | ordinary | warm | assistant_committed | 10.9 | 11.4 | NO | 1 | 1401 (1321) |
| history-closed | H11 | older | ordinary | warm | assistant_committed | 2.3 | 2.9 | yes | 1 | 172 (114) |
| history-closed | H11 | earliest | ordinary | warm | assistant_committed | 1.9 | 2.6 | yes | 1 | 170 (98) |

Turns answered by the real Provider (cancelled ones excluded): 16. Within both limits: 4. Outside or never completed: 12.

| run | case | status | turns with no committed reply | criteria not passing |
| --- | --- | --- | --- | --- |
| effort-low | H01 | fail | recap, detail | O-commit (fail), O-detail-commit (fail), O-topic-coverage (fail), O-recap-deadline (fail), O-detail-deadline (fail), S-topics (fail), S-detail (fail) |
| effort-low | H02 | fail | — | O-said-deadline (fail), O-happened-deadline (fail), O-when-deadline (fail), S-said (needs-review), S-happened (needs-review), S-market-when (needs-review), S-when (needs-review) |
| effort-low | H04 | fail | ask | O-commit (fail), O-history (fail), O-old-source (fail), O-deadline (fail), S-detail (fail), S-no-invention (fail) |
| effort-low | H09 | fail | — | O-model-variant (not-run), O-light-deadline (fail), O-recall-deadline (fail), O-turn-deadline (fail), O-probe-deadline (fail), S-recall (needs-review), S-identity (needs-review), P-recall-voice (needs-review), P-serious-voice (needs-review) |
| effort-low | H12 | fail | work | O-commit (fail), O-purge-race (not-run), O-deadline (fail), S-controls (fail) |
| history-closed | H04 | fail | — | O-old-source (fail), S-detail (needs-review), S-no-invention (needs-review) |
| history-closed | H11 | fail | — | O-range-read (fail), O-older-source (fail), O-earliest-source (fail), O-read-failure (not-run), O-empty-deadline (fail), S-empty (needs-review), S-older (needs-review), S-earliest (needs-review) |

