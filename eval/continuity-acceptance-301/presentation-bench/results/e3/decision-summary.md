## Decision benchmark: e3

84 call(s); recorded cost $0.2450 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v6a@T5@@n2 | either | 18 | 0 | 11/18 | 1275 [248–8484] | 38529 | 11.0 | 4 | n/a |
| v6a@T5@@n2 | no-recall | 42 | 0 | 1/42 | 298 [100–2456] | 19255 | 3.7 | 0 | 41/42 |
| v6a@T5@@n2 | recall | 24 | 0 | 18/24 | 500 [94–1772] | 14379 | 5.2 | 0 | 18/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v6a@T5@@n2 | 6 | 0 | 4/6 | 1618 [813–6323] | 13708 | 12.7 | 1 |
| H02-market-when | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 165 [156–484] | 1321 | 2.8 | 0 |
| H03-order | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 315 [143–463] | 1811 | 3.3 | 0 |
| H04-ask | recall | v6a@T5@@n2 | 6 | 0 | 6/6 | 160 [94–310] | 1084 | 2.6 | 0 |
| H05-cued | recall | v6a@T5@@n2 | 6 | 0 | 5/6 | 894 [565–1772] | 5945 | 7.7 | 0 |
| H05-garden | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 1137 [725–2456] | 8264 | 9.5 | 0 |
| H08-praise | recall | v6a@T5@@n2 | 6 | 0 | 1/6 | 849 [189–1317] | 4503 | 8.8 | 0 |
| H09-light | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 248 [105–401] | 1443 | 4.0 | 0 |
| H09-turn | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 382 [165–1016] | 3020 | 5.1 | 0 |
| H10-after | no-recall | v6a@T5@@n2 | 6 | 0 | 0/6 | 125 [100–820] | 1443 | 2.9 | 0 |
| H10-supplement | no-recall | v6a@T5@@n2 | 6 | 0 | 1/6 | 305 [265–410] | 1953 | 3.4 | 0 |
| H12-work | recall | v6a@T5@@n2 | 6 | 0 | 6/6 | 377 [211–873] | 2847 | 3.8 | 0 |
| V4-H01-recap | either | v6a@T5@@n2 | 6 | 0 | 3/6 | 1637 [248–8484] | 17577 | 18.2 | 3 |
| V4-H06-ping | either | v6a@T5@@n2 | 6 | 0 | 4/6 | 965 [319–2831] | 7244 | 8.7 | 0 |
