# Blind pairwise 通道（issue #79）

## Status

Runnable eval artifact — 行为契约人评协议（§三）与发布证据（§八）的工具化载体。
规则权威在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)；
ADR-0110：人工味觉裁定是最终权威，机械汇总只做归因与门槛复算。

## TL;DR

- `build-pairs.ts`：把两份 transcripts（现任基线 vs 候选运行）拼成盲评对。
  只配对「同场景、同轮次、用户输入逐字一致」的轮次——#61 冻结基线早于
  v2.1 场景包，#77 改写的激活/停止措辞轮与追加的干净/重开轮全部排除并记录
  原因；`memory_continuity` 整类排除（召回判定 deferred 到 1A.3a，#79）。
- 身份盲化按场景种子洗牌（mulberry32，`seed + 场景序号 × 7`，#62 同式），
  映射写入 `sealed-identities.json`，评完前不揭示。
- 评审在 `scores.json` 上工作：每个配对轮对 A/B 各打六维 1–5 分
  （生命力/温暖关心/真诚/分寸/自然/口语度，正向极，不求和），每场景选一个
  最佳；只引用 A/B，不接触任何身份信息。
- `unblind.ts`：结构化强制「先评后揭」——scores.json 不完整（缺轮、缺维、
  分值越界、缺场景最佳）即拒绝揭示。揭示后输出总体 / 分 locale / 受保护
  类别的双侧中位数、场景最佳计数、发布门槛复算（生命力/温暖关心至少一项
  严格更好；受保护类别任一维度中位数不许下降），并对 conclusions.json 的
  每条引文做归属反查（引文必须是所归属系统在该轮的原文子串，否则非零退出
  ——#62 修订记录的教训机械化）。

## 使用

```sh
# 1. 构建盲评对（baseline = #61 冻结运行；candidate = 本次 merged 运行）
pnpm exec tsx eval/blind-pairwise/build-pairs.ts \
  --baseline eval/conversation-text-baseline/run/transcripts.json \
  --candidate eval/incumbent-baseline/run/transcripts.json \
  --scenarios eval/scenario-pack-v2/scenarios.json \
  --out eval/blind-pairwise/run-79

# 2. 人工盲评：对照 pairs.json 逐轮打分，写 run-79/scores.json
#    （schema 见 protocol.ts 的 ScoresFile；只允许出现 A/B）

# 3. 揭示 + 门槛复算 + 引文反查
pnpm exec tsx eval/blind-pairwise/unblind.ts --dir eval/blind-pairwise/run-79 \
  --conclusions eval/blind-pairwise/run-79/conclusions.json
```

## 文件

| 路径 | 用途 |
| --- | --- |
| `protocol.ts` | 协议类型、六维命名、受保护类别、种子洗牌与中位数工具 |
| `build-pairs.ts` | 构建 pairs.json（盲）与 sealed-identities.json（封存） |
| `unblind.ts` | 完整性校验、揭示、中位数汇总、门槛复算、引文反查 → results.json |
| `run-79/` | #79 的实际盲评产物（pairs / sealed / scores / conclusions / results） |

## 边界

- 分数是单评审（Internal Owner 或其明确委托的操作者）的味觉判断；工具只保证
  协议纪律（盲化可复现、先评后揭、引文可反查），不替代 ADR-0110 的人工权威。
- 硬门禁不在此目录：见 `eval/scenario-pack-v2/check-transcripts.ts` 的
  TieredReport。本目录只承担 pairwise 证据项。
- 受保护类别固定为 `high_risk` / `refusal` / `short_answers` / `topic_change`
  / `direct_task`（契约 §八：安全、停止信号、能力诚实）。

## References

- 规则：[行为契约与评测 rubric](../../docs/evaluation/01-behavior-contract-and-rubric.md)
  · [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md)
- 数据：[#61 基线](../conversation-text-baseline/) · [scenario-pack v2.1](../scenario-pack-v2/)
- 先例：#62 盲评（issue 评论，种子洗牌与引文反查的来源）
- Task: [#79](https://github.com/lukemyself-hub/SayHear/issues/79)
