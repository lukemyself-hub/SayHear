## Decision benchmark: d1

144 call(s); recorded cost $0.4380 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v4 | either | 6 | 0 | 6/6 | 1491 [1026–4700] | 12772 | 12.6 | 1 | n/a |
| v4 | no-recall | 42 | 0 | 7/42 | 623 [109–2583] | 32186 | 6.5 | 0 | 35/42 |
| v4 | recall | 24 | 0 | 14/24 | 621 [37–13585] | 39109 | 5.8 | 2 | 14/24 |
| v5 | either | 6 | 0 | 6/6 | 2834 [801–5974] | 18816 | 21.7 | 2 | n/a |
| v5 | no-recall | 42 | 0 | 2/42 | 749 [74–5614] | 40442 | 6.7 | 2 | 40/42 |
| v5 | recall | 24 | 0 | 17/24 | 562 [88–4432] | 17659 | 5.7 | 1 | 17/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v4 | 6 | 0 | 6/6 | 1491 [1026–4700] | 12772 | 12.6 | 1 |
| H01-detail | either | v5 | 6 | 0 | 6/6 | 2834 [801–5974] | 18816 | 21.7 | 2 |
| H02-market-when | no-recall | v4 | 6 | 0 | 0/6 | 439 [206–560] | 2472 | 4.2 | 0 |
| H02-market-when | no-recall | v5 | 6 | 0 | 0/6 | 1206 [155–5614] | 12038 | 8.5 | 1 |
| H03-order | no-recall | v4 | 6 | 0 | 0/6 | 209 [109–537] | 1467 | 3.0 | 0 |
| H03-order | no-recall | v5 | 6 | 0 | 0/6 | 201 [74–1740] | 3073 | 2.8 | 0 |
| H04-ask | recall | v4 | 6 | 0 | 6/6 | 101 [37–238] | 673 | 2.2 | 0 |
| H04-ask | recall | v5 | 6 | 0 | 6/6 | 142 [93–243] | 897 | 2.5 | 0 |
| H05-cued | recall | v4 | 6 | 0 | 0/6 | 1284 [409–13585] | 30358 | 10.8 | 2 |
| H05-cued | recall | v5 | 6 | 0 | 5/6 | 1204 [627–4432] | 9903 | 10.1 | 1 |
| H05-garden | no-recall | v4 | 6 | 0 | 0/6 | 891 [609–1126] | 5282 | 9.1 | 0 |
| H05-garden | no-recall | v5 | 6 | 0 | 0/6 | 830 [246–1524] | 4981 | 7.7 | 0 |
| H08-praise | recall | v4 | 6 | 0 | 3/6 | 701 [368–1009] | 4164 | 7.1 | 0 |
| H08-praise | recall | v5 | 6 | 0 | 0/6 | 774 [120–1616] | 4999 | 8.6 | 0 |
| H09-light | no-recall | v4 | 6 | 0 | 6/6 | 895 [325–1247] | 4863 | 8.2 | 0 |
| H09-light | no-recall | v5 | 6 | 0 | 2/6 | 928 [519–2843] | 6852 | 8.0 | 0 |
| H09-turn | no-recall | v4 | 6 | 0 | 0/6 | 1004 [581–1407] | 5790 | 12.0 | 0 |
| H09-turn | no-recall | v5 | 6 | 0 | 0/6 | 877 [474–1110] | 4920 | 10.9 | 1 |
| H10-after | no-recall | v4 | 6 | 0 | 0/6 | 459 [116–742] | 2637 | 4.3 | 0 |
| H10-after | no-recall | v5 | 6 | 0 | 0/6 | 417 [106–1392] | 3401 | 4.8 | 0 |
| H10-supplement | no-recall | v4 | 6 | 0 | 1/6 | 1516 [617–2583] | 9675 | 12.5 | 0 |
| H10-supplement | no-recall | v5 | 6 | 0 | 0/6 | 348 [216–3140] | 5177 | 4.1 | 0 |
| H12-work | recall | v4 | 6 | 0 | 5/6 | 559 [163–1385] | 3914 | 5.1 | 0 |
| H12-work | recall | v5 | 6 | 0 | 6/6 | 248 [88–564] | 1860 | 3.5 | 0 |
