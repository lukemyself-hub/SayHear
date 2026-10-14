## Decision benchmark: d2

72 call(s); recorded cost $0.2426 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v5s | either | 6 | 1 | 5/5 | 3317 [1825–4587] | 17328 | 27.9 | 3 | n/a |
| v5s | no-recall | 42 | 0 | 5/42 | 591 [63–12016] | 47024 | 5.8 | 2 | 37/42 |
| v5s | recall | 24 | 0 | 15/24 | 530 [57–2938] | 18396 | 4.9 | 0 | 15/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v5s | 6 | 1 | 5/5 | 3317 [1825–4587] | 17328 | 27.9 | 3 |
| H02-market-when | no-recall | v5s | 6 | 0 | 0/6 | 547 [234–12016] | 14615 | 5.8 | 1 |
| H03-order | no-recall | v5s | 6 | 0 | 0/6 | 351 [63–1793] | 3402 | 4.3 | 0 |
| H04-ask | recall | v5s | 6 | 0 | 6/6 | 114 [57–201] | 750 | 1.9 | 0 |
| H05-cued | recall | v5s | 6 | 0 | 3/6 | 1929 [733–2938] | 11129 | 16.6 | 0 |
| H05-garden | no-recall | v5s | 6 | 0 | 1/6 | 951 [626–2639] | 7501 | 9.7 | 0 |
| H08-praise | recall | v5s | 6 | 0 | 0/6 | 589 [458–873] | 3700 | 5.9 | 0 |
| H09-light | no-recall | v5s | 6 | 0 | 3/6 | 374 [251–596] | 2340 | 4.0 | 0 |
| H09-turn | no-recall | v5s | 6 | 0 | 0/6 | 888 [607–1764] | 6357 | 9.8 | 0 |
| H10-after | no-recall | v5s | 6 | 0 | 0/6 | 238 [151–513] | 1599 | 4.0 | 0 |
| H10-supplement | no-recall | v5s | 6 | 0 | 1/6 | 850 [220–7568] | 11210 | 5.5 | 1 |
| H12-work | recall | v5s | 6 | 0 | 6/6 | 400 [189–1124] | 2817 | 3.7 | 0 |
