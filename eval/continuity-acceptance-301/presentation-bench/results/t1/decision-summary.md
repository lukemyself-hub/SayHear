## Decision benchmark: t1

192 call(s); recorded cost $0.5445 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v5 | either | 4 | 0 | 4/4 | 4463 [1285–5486] | 15697 | 35.3 | 3 | n/a |
| v5 | no-recall | 28 | 0 | 3/28 | 700 [118–3786] | 23194 | 6.3 | 1 | 25/28 |
| v5 | recall | 16 | 0 | 11/16 | 669 [91–6407] | 19876 | 6.1 | 2 | 11/16 |
| v5@T1 | either | 4 | 0 | 4/4 | 928 [704–991] | 3550 | 8.2 | 0 | n/a |
| v5@T1 | no-recall | 28 | 0 | 2/28 | 574 [99–2549] | 20539 | 5.1 | 0 | 26/28 |
| v5@T1 | recall | 16 | 0 | 13/16 | 532 [111–3053] | 13156 | 6.5 | 0 | 13/16 |
| v5@T2 | either | 4 | 0 | 4/4 | 2576 [2139–2784] | 10075 | 21.1 | 0 | n/a |
| v5@T2 | no-recall | 28 | 0 | 0/28 | 531 [116–1522] | 19050 | 5.5 | 0 | 28/28 |
| v5@T2 | recall | 16 | 0 | 13/16 | 494 [111–1700] | 9712 | 4.6 | 0 | 13/16 |
| v5@T3 | either | 4 | 0 | 3/4 | 2060 [1525–7586] | 13231 | 17.7 | 1 | n/a |
| v5@T3 | no-recall | 28 | 0 | 1/28 | 694 [133–1543] | 20074 | 7.2 | 0 | 27/28 |
| v5@T3 | recall | 16 | 0 | 12/16 | 425 [93–4241] | 11567 | 4.6 | 1 | 12/16 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v5 | 4 | 0 | 4/4 | 4463 [1285–5486] | 15697 | 35.3 | 3 |
| H01-detail | either | v5@T1 | 4 | 0 | 4/4 | 928 [704–991] | 3550 | 8.2 | 0 |
| H01-detail | either | v5@T2 | 4 | 0 | 4/4 | 2576 [2139–2784] | 10075 | 21.1 | 0 |
| H01-detail | either | v5@T3 | 4 | 0 | 3/4 | 2060 [1525–7586] | 13231 | 17.7 | 1 |
| H02-market-when | no-recall | v5 | 4 | 0 | 0/4 | 441 [177–723] | 1782 | 4.5 | 0 |
| H02-market-when | no-recall | v5@T1 | 4 | 0 | 0/4 | 295 [99–712] | 1401 | 3.1 | 0 |
| H02-market-when | no-recall | v5@T2 | 4 | 0 | 0/4 | 248 [211–312] | 1018 | 3.2 | 0 |
| H02-market-when | no-recall | v5@T3 | 4 | 0 | 0/4 | 245 [145–395] | 1030 | 3.1 | 0 |
| H03-order | no-recall | v5 | 4 | 0 | 0/4 | 334 [191–677] | 1536 | 4.1 | 0 |
| H03-order | no-recall | v5@T1 | 4 | 0 | 0/4 | 387 [279–649] | 1701 | 4.2 | 0 |
| H03-order | no-recall | v5@T2 | 4 | 0 | 0/4 | 678 [493–1208] | 3057 | 6.4 | 0 |
| H03-order | no-recall | v5@T3 | 4 | 0 | 0/4 | 1078 [685–1266] | 4107 | 9.3 | 0 |
| H04-ask | recall | v5 | 4 | 0 | 4/4 | 205 [91–242] | 742 | 2.9 | 0 |
| H04-ask | recall | v5@T1 | 4 | 0 | 4/4 | 201 [131–273] | 805 | 3.0 | 0 |
| H04-ask | recall | v5@T2 | 4 | 0 | 4/4 | 170 [115–245] | 700 | 2.9 | 0 |
| H04-ask | recall | v5@T3 | 4 | 0 | 4/4 | 157 [93–265] | 672 | 2.2 | 0 |
| H05-cued | recall | v5 | 4 | 0 | 3/4 | 1338 [574–6407] | 9657 | 9.3 | 1 |
| H05-cued | recall | v5@T1 | 4 | 0 | 4/4 | 1048 [821–3053] | 5970 | 9.9 | 0 |
| H05-cued | recall | v5@T2 | 4 | 0 | 3/4 | 945 [786–1546] | 4222 | 8.7 | 0 |
| H05-cued | recall | v5@T3 | 4 | 0 | 3/4 | 886 [451–4241] | 6464 | 8.0 | 1 |
| H05-garden | no-recall | v5 | 4 | 0 | 0/4 | 820 [753–1167] | 3560 | 7.8 | 0 |
| H05-garden | no-recall | v5@T1 | 4 | 0 | 0/4 | 854 [750–1104] | 3562 | 9.0 | 0 |
| H05-garden | no-recall | v5@T2 | 4 | 0 | 0/4 | 1302 [1084–1522] | 5210 | 12.5 | 0 |
| H05-garden | no-recall | v5@T3 | 4 | 0 | 0/4 | 1376 [1011–1416] | 5178 | 14.2 | 0 |
| H08-praise | recall | v5 | 4 | 0 | 1/4 | 799 [574–1211] | 3382 | 7.7 | 0 |
| H08-praise | recall | v5@T1 | 4 | 0 | 1/4 | 716 [443–1313] | 3188 | 8.1 | 0 |
| H08-praise | recall | v5@T2 | 4 | 0 | 2/4 | 814 [399–1700] | 3727 | 9.0 | 0 |
| H08-praise | recall | v5@T3 | 4 | 0 | 1/4 | 813 [512–1242] | 3379 | 8.5 | 0 |
| H09-light | no-recall | v5 | 4 | 0 | 3/4 | 872 [424–1494] | 3661 | 7.5 | 0 |
| H09-light | no-recall | v5@T1 | 4 | 0 | 2/4 | 494 [192–1212] | 2391 | 4.8 | 0 |
| H09-light | no-recall | v5@T2 | 4 | 0 | 0/4 | 395 [370–680] | 1840 | 5.5 | 0 |
| H09-light | no-recall | v5@T3 | 4 | 0 | 0/4 | 289 [133–382] | 1092 | 3.6 | 0 |
| H09-turn | no-recall | v5 | 4 | 0 | 0/4 | 799 [575–1209] | 3382 | 8.5 | 0 |
| H09-turn | no-recall | v5@T1 | 4 | 0 | 0/4 | 1443 [1192–2549] | 6626 | 15.3 | 0 |
| H09-turn | no-recall | v5@T2 | 4 | 0 | 0/4 | 1015 [616–1438] | 4083 | 11.3 | 0 |
| H09-turn | no-recall | v5@T3 | 4 | 0 | 1/4 | 1084 [934–1357] | 4459 | 11.1 | 0 |
| H10-after | no-recall | v5 | 4 | 0 | 0/4 | 1062 [118–3786] | 6027 | 11.4 | 1 |
| H10-after | no-recall | v5@T1 | 4 | 0 | 0/4 | 530 [333–1744] | 3136 | 5.9 | 0 |
| H10-after | no-recall | v5@T2 | 4 | 0 | 0/4 | 730 [355–1050] | 2864 | 8.0 | 0 |
| H10-after | no-recall | v5@T3 | 4 | 0 | 0/4 | 528 [237–1543] | 2835 | 6.2 | 0 |
| H10-supplement | no-recall | v5 | 4 | 0 | 0/4 | 838 [344–1226] | 3246 | 7.3 | 0 |
| H10-supplement | no-recall | v5@T1 | 4 | 0 | 0/4 | 449 [206–619] | 1722 | 4.2 | 0 |
| H10-supplement | no-recall | v5@T2 | 4 | 0 | 0/4 | 257 [116–348] | 978 | 3.5 | 0 |
| H10-supplement | no-recall | v5@T3 | 4 | 0 | 0/4 | 262 [146–703] | 1373 | 3.4 | 0 |
| H12-work | recall | v5 | 4 | 0 | 3/4 | 874 [225–4122] | 6095 | 7.3 | 1 |
| H12-work | recall | v5@T1 | 4 | 0 | 4/4 | 202 [111–2679] | 3193 | 3.3 | 0 |
| H12-work | recall | v5@T2 | 4 | 0 | 4/4 | 182 [111–588] | 1063 | 2.6 | 0 |
| H12-work | recall | v5@T3 | 4 | 0 | 4/4 | 248 [158–398] | 1052 | 3.0 | 0 |
