| run | case | turn | kind | app | outcome | first text s | committed s | within 3/10 | live requests | output tokens (reasoning) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| connectivity | S01 | t1 | ordinary | warm | assistant_committed | 10.3 | 10.8 | NO | 1 | 1083 (1025) |
| dev | C13 | ask | history | warm | assistant_committed | 16.0 | 16.7 | NO | 2 | 2194 (2008) |
| dev | C16 | ask | history | warm | response_failed | — | — | NO | 2 | 229 (122) |
| dev | S01 | t1 | ordinary | warm | assistant_committed | 6.7 | 6.9 | NO | 1 | 725 (688) |
| dev | S02 | forget | trust-action | warm | assistant_committed | 9.5 | 9.7 | NO | 2 | 1196 (1109) |
| dev | S02 | plain | ordinary | warm | response_failed | — | — | NO | 1 | 0 (0) |
| dev | S03 | recap | history | warm | assistant_committed | 24.1 | 24.3 | NO | 2 | 4434 (4306) |

Turns answered by the real Provider (cancelled ones excluded): 7. Within both limits: 0. Outside or never completed: 7.

| run | case | status | turns with no committed reply | criteria not passing |
| --- | --- | --- | --- | --- |
| connectivity | S01 | fail | — | O-deadline (fail), S-reply (needs-review) |
| dev | C13 | needs-review | — | S-grounded (needs-review) |
| dev | C16 | fail | ask | O-commit (fail), O-history (fail), O-both-occasions (fail), S-two-occasions (fail), S-bounded-claims (fail) |
| dev | S01 | fail | — | O-deadline (fail), S-reply (needs-review) |
| dev | S02 | fail | plain | O-plain-commit (fail), O-deadline (fail), S-acknowledge (needs-review), S-plain (fail) |
| dev | S03 | fail | — | O-deadline (fail), S-recap (needs-review) |

