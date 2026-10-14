## Decision benchmark: e1

252 call(s); recorded cost $0.6021 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v6a@T5 | either | 18 | 0 | 15/18 | 1183 [149–9115] | 32378 | 10.4 | 2 | n/a |
| v6a@T5 | no-recall | 42 | 0 | 1/42 | 531 [66–2513] | 28093 | 5.1 | 0 | 41/42 |
| v6a@T5 | recall | 24 | 0 | 18/24 | 556 [51–2591] | 16682 | 5.8 | 0 | 18/24 |
| v6a@T5@low | either | 18 | 0 | 15/18 | 1061 [97–4763] | 22255 | 8.8 | 2 | n/a |
| v6a@T5@low | no-recall | 42 | 0 | 0/42 | 189 [39–1275] | 12603 | 2.8 | 0 | 42/42 |
| v6a@T5@low | recall | 24 | 0 | 13/24 | 453 [40–1365] | 11695 | 5.5 | 0 | 13/24 |
| v6a@T5@off | either | 18 | 0 | 12/18 | 0 [0–0] | 0 | 1.5 | 0 | n/a |
| v6a@T5@off | no-recall | 42 | 0 | 5/42 | 0 [0–0] | 0 | 1.7 | 0 | 37/42 |
| v6a@T5@off | recall | 24 | 0 | 12/24 | 0 [0–0] | 0 | 1.7 | 0 | 12/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v6a@T5 | 6 | 0 | 6/6 | 1555 [1152–9115] | 17528 | 13.7 | 1 |
| H01-detail | either | v6a@T5@low | 6 | 0 | 6/6 | 1155 [1010–1681] | 7505 | 10.3 | 0 |
| H01-detail | either | v6a@T5@off | 6 | 0 | 6/6 | 0 [0–0] | 0 | 1.5 | 0 |
| H02-market-when | no-recall | v6a@T5 | 6 | 0 | 0/6 | 319 [66–495] | 1738 | 3.7 | 0 |
| H02-market-when | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 128 [51–269] | 831 | 2.2 | 0 |
| H02-market-when | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.5 | 0 |
| H03-order | no-recall | v6a@T5 | 6 | 0 | 0/6 | 521 [228–860] | 3103 | 5.2 | 0 |
| H03-order | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 259 [39–499] | 1638 | 2.9 | 0 |
| H03-order | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.7 | 0 |
| H04-ask | recall | v6a@T5 | 6 | 0 | 6/6 | 110 [51–337] | 879 | 1.9 | 0 |
| H04-ask | recall | v6a@T5@low | 6 | 0 | 6/6 | 71 [40–123] | 438 | 1.6 | 0 |
| H04-ask | recall | v6a@T5@off | 6 | 0 | 6/6 | 0 [0–0] | 0 | 1.5 | 0 |
| H05-cued | recall | v6a@T5 | 6 | 0 | 6/6 | 1307 [367–2591] | 8186 | 11.7 | 0 |
| H05-cued | recall | v6a@T5@low | 6 | 0 | 2/6 | 944 [480–1365] | 5642 | 8.8 | 0 |
| H05-cued | recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 2.0 | 0 |
| H05-garden | no-recall | v6a@T5 | 6 | 0 | 1/6 | 1555 [972–2513] | 9650 | 14.2 | 0 |
| H05-garden | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 573 [401–1171] | 4227 | 6.6 | 0 |
| H05-garden | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.7 | 0 |
| H08-praise | recall | v6a@T5 | 6 | 0 | 0/6 | 607 [552–1241] | 4665 | 7.3 | 0 |
| H08-praise | recall | v6a@T5@low | 6 | 0 | 0/6 | 557 [426–807] | 3517 | 6.8 | 0 |
| H08-praise | recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 2.4 | 0 |
| H09-light | no-recall | v6a@T5 | 6 | 0 | 0/6 | 392 [289–746] | 2679 | 4.8 | 0 |
| H09-light | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 136 [74–365] | 1013 | 2.7 | 0 |
| H09-light | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 2.0 | 0 |
| H09-turn | no-recall | v6a@T5 | 6 | 0 | 0/6 | 991 [720–1390] | 5959 | 11.0 | 0 |
| H09-turn | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 390 [275–1275] | 3158 | 6.1 | 0 |
| H09-turn | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.8 | 0 |
| H10-after | no-recall | v6a@T5 | 6 | 0 | 0/6 | 260 [85–704] | 2135 | 4.0 | 0 |
| H10-after | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 106 [41–279] | 792 | 2.3 | 0 |
| H10-after | no-recall | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.5 | 0 |
| H10-supplement | no-recall | v6a@T5 | 6 | 0 | 0/6 | 366 [203–1061] | 2829 | 3.9 | 0 |
| H10-supplement | no-recall | v6a@T5@low | 6 | 0 | 0/6 | 159 [124–191] | 944 | 2.6 | 0 |
| H10-supplement | no-recall | v6a@T5@off | 6 | 0 | 5/6 | 0 [0–0] | 0 | 1.3 | 0 |
| H12-work | recall | v6a@T5 | 6 | 0 | 6/6 | 274 [97–1387] | 2952 | 3.3 | 0 |
| H12-work | recall | v6a@T5@low | 6 | 0 | 5/6 | 315 [86–806] | 2098 | 3.1 | 0 |
| H12-work | recall | v6a@T5@off | 6 | 0 | 6/6 | 0 [0–0] | 0 | 1.4 | 0 |
| V4-H01-recap | either | v6a@T5 | 6 | 0 | 5/6 | 340 [149–5836] | 7202 | 3.7 | 1 |
| V4-H01-recap | either | v6a@T5@low | 6 | 0 | 4/6 | 1050 [97–4763] | 9811 | 9.0 | 2 |
| V4-H01-recap | either | v6a@T5@off | 6 | 0 | 6/6 | 0 [0–0] | 0 | 1.5 | 0 |
| V4-H06-ping | either | v6a@T5 | 6 | 0 | 4/6 | 1255 [601–2322] | 7648 | 11.2 | 0 |
| V4-H06-ping | either | v6a@T5@low | 6 | 0 | 5/6 | 630 [289–2091] | 4939 | 6.0 | 0 |
| V4-H06-ping | either | v6a@T5@off | 6 | 0 | 0/6 | 0 [0–0] | 0 | 1.5 | 0 |
