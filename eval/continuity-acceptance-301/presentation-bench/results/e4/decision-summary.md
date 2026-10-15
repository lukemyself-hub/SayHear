## Decision benchmark: e4

146 call(s); recorded cost $0.7573 (conservative list price).
Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.

### By variant and what the turn calls for

| variant | turn calls for | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s | correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v6a@T5@high | either | 3 | 0 | 3/3 | 2297 [929–2696] | 5922 | 18.4 | 0 | n/a |
| v6a@T5@high | no-recall | 20 | 0 | 0/20 | 344 [86–1045] | 9725 | 4.5 | 0 | 20/20 |
| v6a@T5@high | recall | 9 | 0 | 7/9 | 714 [248–4972] | 12805 | 7.3 | 2 | 7/9 |
| v6a@T5@max | either | 3 | 3 | 0/0 | n/a [n/a] | 0 | 0.0 | 3 | n/a |
| v6a@T5@max | no-recall | 18 | 8 | 0/10 | 1850 [285–11844] | 33674 | 15.1 | 10 | 10/10 |
| v6a@T5@max | recall | 9 | 2 | 4/7 | 5445 [421–13661] | 44950 | 51.0 | 6 | 4/7 |
| v6a@T5@medium | either | 18 | 0 | 15/18 | 1011 [212–5911] | 33144 | 8.5 | 3 | n/a |
| v6a@T5@medium | no-recall | 42 | 0 | 2/42 | 399 [54–5046] | 24853 | 4.6 | 1 | 40/42 |
| v6a@T5@medium | recall | 24 | 0 | 20/24 | 618 [102–2086] | 16530 | 5.4 | 0 | 20/24 |

### By fixture

| fixture | turn calls for | variant | calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H01-detail | either | v6a@T5@high | 3 | 0 | 3/3 | 2297 [929–2696] | 5922 | 18.4 | 0 |
| H01-detail | either | v6a@T5@max | 3 | 3 | 0/0 | n/a [n/a] | 0 | 0.0 | 3 |
| H01-detail | either | v6a@T5@medium | 6 | 0 | 6/6 | 1887 [995–5794] | 14246 | 13.6 | 1 |
| H02-market-when | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 225 [116–290] | 631 | 3.1 | 0 |
| H02-market-when | no-recall | v6a@T5@max | 3 | 0 | 0/3 | 577 [285–2253] | 3115 | 5.0 | 0 |
| H02-market-when | no-recall | v6a@T5@medium | 6 | 0 | 0/6 | 142 [93–208] | 871 | 2.5 | 0 |
| H03-order | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 525 [326–939] | 1790 | 4.7 | 0 |
| H03-order | no-recall | v6a@T5@max | 3 | 1 | 0/2 | 2443 [884–4001] | 4885 | 14.2 | 1 |
| H03-order | no-recall | v6a@T5@medium | 6 | 0 | 0/6 | 504 [176–650] | 2819 | 3.8 | 0 |
| H04-ask | recall | v6a@T5@high | 3 | 0 | 3/3 | 276 [248–289] | 813 | 3.0 | 0 |
| H04-ask | recall | v6a@T5@max | 3 | 0 | 3/3 | 583 [421–819] | 1823 | 4.9 | 0 |
| H04-ask | recall | v6a@T5@medium | 6 | 0 | 6/6 | 175 [106–308] | 1111 | 2.8 | 0 |
| H05-cued | recall | v6a@T5@high | 3 | 0 | 3/3 | 3939 [924–4972] | 9835 | 31.7 | 2 |
| H05-cued | recall | v6a@T5@max | 3 | 1 | 1/2 | 12074 [10486–13661] | 24147 | 86.4 | 3 |
| H05-cued | recall | v6a@T5@medium | 6 | 0 | 6/6 | 1360 [808–2086] | 8323 | 10.4 | 0 |
| H05-garden | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 765 [614–768] | 2147 | 6.8 | 0 |
| H05-garden | no-recall | v6a@T5@max | 3 | 3 | 0/0 | n/a [n/a] | 0 | 0.0 | 3 |
| H05-garden | no-recall | v6a@T5@medium | 6 | 0 | 0/6 | 869 [531–1350] | 5351 | 8.7 | 0 |
| H08-praise | recall | v6a@T5@high | 3 | 0 | 1/3 | 714 [589–854] | 2157 | 7.3 | 0 |
| H08-praise | recall | v6a@T5@max | 3 | 1 | 0/2 | 9490 [5445–13535] | 18980 | 81.9 | 3 |
| H08-praise | recall | v6a@T5@medium | 6 | 0 | 2/6 | 693 [460–1302] | 4578 | 7.7 | 0 |
| H09-light | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 152 [111–340] | 603 | 2.7 | 0 |
| H09-light | no-recall | v6a@T5@max | 3 | 0 | 0/3 | 1682 [1195–8936] | 11813 | 15.0 | 1 |
| H09-light | no-recall | v6a@T5@medium | 6 | 0 | 1/6 | 259 [166–719] | 1868 | 3.4 | 0 |
| H09-turn | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 817 [799–1028] | 2644 | 8.4 | 0 |
| H09-turn | no-recall | v6a@T5@max | 3 | 3 | 0/0 | n/a [n/a] | 0 | 0.0 | 3 |
| H09-turn | no-recall | v6a@T5@medium | 6 | 0 | 0/6 | 754 [318–1339] | 4893 | 8.2 | 0 |
| H10-after | no-recall | v6a@T5@high | 3 | 0 | 0/3 | 347 [86–1045] | 1478 | 4.2 | 0 |
| H10-after | no-recall | v6a@T5@max | 3 | 1 | 0/2 | 6931 [2017–11844] | 13861 | 57.2 | 2 |
| H10-after | no-recall | v6a@T5@medium | 6 | 0 | 0/6 | 330 [54–585] | 2098 | 3.9 | 0 |
| H10-supplement | no-recall | v6a@T5@high | 2 | 0 | 0/2 | 216 [182–250] | 432 | 3.6 | 0 |
| H10-supplement | no-recall | v6a@T5@medium | 6 | 0 | 1/6 | 399 [171–5046] | 6953 | 4.3 | 1 |
| H12-work | recall | v6a@T5@medium | 6 | 0 | 6/6 | 453 [102–660] | 2518 | 3.9 | 0 |
| V4-H01-recap | either | v6a@T5@medium | 6 | 0 | 4/6 | 527 [212–4130] | 9163 | 4.5 | 1 |
| V4-H06-ping | either | v6a@T5@medium | 6 | 0 | 5/6 | 812 [479–5911] | 9735 | 7.4 | 1 |
