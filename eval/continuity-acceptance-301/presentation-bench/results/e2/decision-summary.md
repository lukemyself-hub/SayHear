## Decision benchmark: e2

168 call(s); recorded cost $0.4403 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v6a@T5@@n1 | either | 18 | 0 | 15/18 | 1043 [218–4607] | 28526 | 8.9 | 3 | n/a |
| v6a@T5@@n1 | no-recall | 42 | 0 | 0/42 | 309 [19–1829] | 22228 | 4.4 | 0 | 42/42 |
| v6a@T5@@n1 | recall | 24 | 0 | 20/24 | 424 [100–2457] | 16147 | 5.3 | 0 | 20/24 |
| v6a@T5@low@n1 | either | 18 | 0 | 16/18 | 901 [79–7953] | 23427 | 8.1 | 1 | n/a |
| v6a@T5@low@n1 | no-recall | 42 | 0 | 0/42 | 225 [28–978] | 11490 | 3.2 | 0 | 42/42 |
| v6a@T5@low@n1 | recall | 24 | 0 | 16/24 | 352 [73–1770] | 11806 | 4.9 | 0 | 16/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v6a@T5@@n1 | 6 | 0 | 6/6 | 1483 [1050–4607] | 13716 | 13.4 | 2 |
| H01-detail | either | v6a@T5@low@n1 | 6 | 0 | 6/6 | 976 [724–7953] | 12847 | 8.6 | 1 |
| H02-market-when | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 198 [121–459] | 1388 | 2.8 | 0 |
| H02-market-when | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 132 [78–218] | 795 | 2.4 | 0 |
| H03-order | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 368 [138–1829] | 3504 | 4.3 | 0 |
| H03-order | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 236 [108–350] | 1418 | 3.0 | 0 |
| H04-ask | recall | v6a@T5@@n1 | 6 | 0 | 6/6 | 174 [100–226] | 991 | 2.6 | 0 |
| H04-ask | recall | v6a@T5@low@n1 | 6 | 0 | 6/6 | 101 [73–128] | 599 | 2.0 | 0 |
| H05-cued | recall | v6a@T5@@n1 | 6 | 0 | 6/6 | 882 [327–2457] | 6685 | 8.3 | 0 |
| H05-cued | recall | v6a@T5@low@n1 | 6 | 0 | 4/6 | 753 [566–1770] | 6151 | 6.7 | 0 |
| H05-garden | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 1138 [530–1716] | 6619 | 10.9 | 0 |
| H05-garden | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 661 [398–978] | 3995 | 7.1 | 0 |
| H08-praise | recall | v6a@T5@@n1 | 6 | 0 | 2/6 | 755 [360–1069] | 4472 | 8.4 | 0 |
| H08-praise | recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 301 [250–432] | 1928 | 4.9 | 0 |
| H09-light | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 275 [129–620] | 1928 | 4.1 | 0 |
| H09-light | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 169 [88–307] | 1149 | 3.0 | 0 |
| H09-turn | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 1038 [522–1260] | 5511 | 10.3 | 0 |
| H09-turn | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 310 [124–523] | 1782 | 4.8 | 0 |
| H10-after | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 156 [19–203] | 791 | 2.7 | 0 |
| H10-after | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 151 [28–345] | 1016 | 2.6 | 0 |
| H10-supplement | no-recall | v6a@T5@@n1 | 6 | 0 | 0/6 | 261 [180–1106] | 2487 | 3.1 | 0 |
| H10-supplement | no-recall | v6a@T5@low@n1 | 6 | 0 | 0/6 | 219 [82–340] | 1335 | 3.3 | 0 |
| H12-work | recall | v6a@T5@@n1 | 6 | 0 | 6/6 | 193 [102–1766] | 3999 | 2.5 | 0 |
| H12-work | recall | v6a@T5@low@n1 | 6 | 0 | 6/6 | 559 [155–838] | 3128 | 4.8 | 0 |
| V4-H01-recap | either | v6a@T5@@n1 | 6 | 0 | 5/6 | 706 [218–2096] | 5207 | 6.4 | 0 |
| V4-H01-recap | either | v6a@T5@low@n1 | 6 | 0 | 6/6 | 647 [79–1283] | 3826 | 5.7 | 0 |
| V4-H06-ping | either | v6a@T5@@n1 | 6 | 0 | 4/6 | 923 [635–4122] | 9603 | 8.1 | 1 |
| V4-H06-ping | either | v6a@T5@low@n1 | 6 | 0 | 4/6 | 1028 [426–2390] | 6754 | 8.6 | 0 |
