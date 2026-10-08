# narrative.validate human review (ADR-0143, AC-X03)

Manifest fingerprint: `sha256:f722744b27144139081de2698a1b08a77565baa17e5228908a03d88f35eec3b7`

For each case: read the draft against the cited sources, then check the
machine verdict (filled by the real-provider capture run) against the
expected finding. Record accepted/rejected per case in
`validator-ledger.template.json`. Bio blocks on every class; Reflection
v1 records the same classes as advisory until calibrated blocking policy
promotes them.

## 1. holdout-validator-reflection-manifest_mismatch-en

- language: en (en-US) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: advisory
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: Synthetic holdout Reflection output points at the wrong frozen input manifest.

Draft under review:

> The supplied reflection was generated from manifest syn-holdout-other.

Cited sources (planned coverage):

- `syn-claim-holdout-en`: The fictional user restores old clocks.

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","material_absence"]

## 2. holdout-validator-reflection-ambiguity-en

- language: en (en-US) | artifact: reflection
- planted error: ambiguity | expected outcome: advisory
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: Synthetic holdout Reflection output leaves its proposition support ambiguous.

Draft under review:

> There is something about the clock that may matter to them.

Cited sources (planned coverage):

- `syn-claim-holdout-en`: The fictional user restores old clocks.

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","ambiguous","material_absence"]

## 3. holdout-validator-reflection-manifest_mismatch-zh

- language: zh (zh-CN) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: advisory
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: Synthetic holdout Reflection output points at the wrong frozen input manifest.

Draft under review:

> 该草稿声称由 manifest syn-holdout-other 生成。

Cited sources (planned coverage):

- `syn-claim-holdout-zh`: 虚构用户修理古董钟表。

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","material_absence"]

## 4. holdout-validator-reflection-ambiguity-zh

- language: zh (zh-CN) | artifact: reflection
- planted error: ambiguity | expected outcome: advisory
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: Synthetic holdout Reflection output leaves its proposition support ambiguous.

Draft under review:

> 关于那只钟表，有些事情可能对他们很重要。

Cited sources (planned coverage):

- `syn-claim-holdout-zh`: 虚构用户修理古董钟表。

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","ambiguous","material_absence"]

## 5. holdout-validator-reflection-manifest_mismatch-mix

- language: code_switch (zh-CN) | artifact: reflection
- planted error: manifest_mismatch | expected outcome: advisory
- expected verdict: accepted | expected finding: `manifest_mismatch`
- what was planted: Synthetic holdout Reflection output points at the wrong frozen input manifest.

Draft under review:

> 该草稿声称来自 manifest syn-holdout-other。

Cited sources (planned coverage):

- `syn-claim-holdout-mix`: 虚构用户 restores old clocks.

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","material_absence"]

## 6. holdout-validator-reflection-ambiguity-mix

- language: code_switch (zh-CN) | artifact: reflection
- planted error: ambiguity | expected outcome: advisory
- expected verdict: accepted | expected finding: `ambiguous`
- what was planted: Synthetic holdout Reflection output leaves its proposition support ambiguous.

Draft under review:

> 那件 关于 clocks 的事 可能 对他们 很重要。

Cited sources (planned coverage):

- `syn-claim-holdout-mix`: 虚构用户 restores old clocks.

Machine verdict (real-provider capture):

- deepseek/deepseek-v4-flash: outcome=completed verdict=accepted
- blocking: []
- advisory: ["manifest_mismatch","unsupported","ambiguous","material_absence"]

