# narrative.validate 18-case human review (ADR-0137, AC-X03)

Manifest fingerprint: `sha256:b7ab2f7a69dfcf7a348a61c25d63e0ff454f8c61206fefd2a4e3f1f1e8f8c205`

For each case: read the draft against the cited sources, then check the
machine verdict (filled by the real-provider capture run) against the
expected finding. Record accepted/rejected per case in
`validator-ledger.template.json`. Bio blocks on every class; Reflection
v1 records the same classes as advisory until calibrated blocking policy
promotes them.

## 1. validator-bio-unsupported-en

- language: en (en-US) | artifact: bio
- planted error: unsupported | expected outcome: blocking
- expected verdict: blocked | expected finding: `unsupported`
- what was planted: Synthetic Bio draft adds a fact absent from the source.

Draft under review:

> The user repairs radios and owns a private observatory.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 2. validator-bio-contradiction-en

- language: en (en-US) | artifact: bio
- planted error: contradiction | expected outcome: blocking
- expected verdict: blocked | expected finding: `contradiction`
- what was planted: Synthetic Bio draft contradicts the source claim.

Draft under review:

> The user has never repaired a radio.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 3. validator-bio-upgrade-en

- language: en (en-US) | artifact: bio
- planted error: epistemic_upgrade | expected outcome: blocking
- expected verdict: blocked | expected finding: `kind_upgrade`
- what was planted: Synthetic Bio draft upgrades an observation into a certainty.

Draft under review:

> The user is objectively the most patient person in every room.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 4. validator-bio-absence-en

- language: en (en-US) | artifact: bio
- planted error: material_absence | expected outcome: blocking
- expected verdict: blocked | expected finding: `material_absence`
- what was planted: Synthetic Bio draft omits the material supported identity detail.

Draft under review:

> The user is a person with many interests.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 5. validator-reflection-manifest-en

- language: en (en-US) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: blocking
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: Synthetic Reflection output points at the wrong frozen input manifest.

Draft under review:

> The supplied draft claims it was generated from manifest syn-other.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 6. validator-reflection-ambiguity-en

- language: en (en-US) | artifact: reflection
- planted error: ambiguity | expected outcome: blocking
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: Synthetic Reflection output leaves its proposition support ambiguous.

Draft under review:

> Something about the user may be important.

Cited sources (planned coverage):

- `syn-claim-validator-en`: The fictional user repairs radios.

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 7. validator-bio-unsupported-zh

- language: zh (zh-CN) | artifact: bio
- planted error: unsupported | expected outcome: blocking
- expected verdict: blocked | expected finding: `unsupported`
- what was planted: 中文合成 Bio 加入来源没有的事实。

Draft under review:

> 用户会修理收音机，也经营一家书店。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 8. validator-bio-contradiction-zh

- language: zh (zh-CN) | artifact: bio
- planted error: contradiction | expected outcome: blocking
- expected verdict: blocked | expected finding: `contradiction`
- what was planted: 中文合成 Bio 与来源矛盾。

Draft under review:

> 用户从来不修理收音机。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 9. validator-bio-upgrade-zh

- language: zh (zh-CN) | artifact: bio
- planted error: epistemic_upgrade | expected outcome: blocking
- expected verdict: blocked | expected finding: `kind_upgrade`
- what was planted: 中文合成 Bio 把弱证据写成确定身份。

Draft under review:

> 用户在所有场合都是最有耐心的人。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 10. validator-bio-absence-zh

- language: zh (zh-CN) | artifact: bio
- planted error: material_absence | expected outcome: blocking
- expected verdict: blocked | expected finding: `material_absence`
- what was planted: 中文合成 Bio 漏掉有来源支持的重要兴趣。

Draft under review:

> 用户是一个有很多兴趣的人。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 11. validator-reflection-manifest-zh

- language: zh (zh-CN) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: blocking
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: 中文合成 Reflection 指向错误 manifest。

Draft under review:

> 这条观察声称使用了另一个 manifest。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 12. validator-reflection-ambiguity-zh

- language: zh (zh-CN) | artifact: reflection
- planted error: ambiguity | expected outcome: blocking
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: 中文合成 Reflection 没有清楚标出命题支持。

Draft under review:

> 用户可能是一个挺重要的人。

Cited sources (planned coverage):

- `syn-claim-validator-zh`: 虚构用户会修理收音机。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 13. validator-bio-unsupported-mix

- language: code_switch (zh-CN) | artifact: bio
- planted error: unsupported | expected outcome: blocking
- expected verdict: blocked | expected finding: `unsupported`
- what was planted: Mixed-language synthetic Bio adds an unsupported fact.

Draft under review:

> 用户会 repair radios，而且 runs a private studio。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 14. validator-bio-contradiction-mix

- language: code_switch (zh-CN) | artifact: bio
- planted error: contradiction | expected outcome: blocking
- expected verdict: blocked | expected finding: `contradiction`
- what was planted: Mixed-language synthetic Bio contradicts the source.

Draft under review:

> 用户 never repairs radios。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 15. validator-bio-upgrade-mix

- language: code_switch (zh-CN) | artifact: bio
- planted error: epistemic_upgrade | expected outcome: blocking
- expected verdict: blocked | expected finding: `kind_upgrade`
- what was planted: Mixed-language synthetic Bio upgrades an impression.

Draft under review:

> 用户 is definitely the most patient person everywhere。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 16. validator-bio-absence-mix

- language: code_switch (zh-CN) | artifact: bio
- planted error: material_absence | expected outcome: blocking
- expected verdict: blocked | expected finding: `material_absence`
- what was planted: Mixed-language synthetic Bio drops the supported material detail.

Draft under review:

> 用户 is a person with many interests。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 17. validator-reflection-manifest-mix

- language: code_switch (zh-CN) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: blocking
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: Mixed-language synthetic Reflection uses the wrong manifest.

Draft under review:

> This observation uses manifest syn-other，不是冻结输入。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

## 18. validator-reflection-ambiguity-mix

- language: code_switch (zh-CN) | artifact: reflection
- planted error: ambiguity | expected outcome: blocking
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: Mixed-language synthetic Reflection leaves support ambiguous.

Draft under review:

> Maybe user is important somehow。

Cited sources (planned coverage):

- `syn-claim-validator-mix`: 虚构用户会 repair radios。

Machine verdict (real-provider capture):

- _pending: run the capture before adjudicating_

