# Blind pairwise 通道（issue #79）

## Status

Runnable eval artifact — 行为契约人评协议（§三）与发布证据（§八）的工具化载体。
规则权威在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)；
ADR-0110 / ADR-0114：人工味觉裁定是最终权威；后续默认使用低负担的 v2 分层抽样
与三选一 pairwise，机械汇总只做归因与门槛复算。

## TL;DR

- `build-pairs.ts`：把两份 transcripts（现任基线 vs 候选运行）拼成盲评对。
  只配对「同场景、同轮次、用户输入逐字一致」的轮次——#61 冻结基线早于
  v2.1 场景包，#77 改写的激活/停止措辞轮与追加的干净/重开轮全部排除并记录
  原因；`memory_continuity` 整类排除（召回判定 deferred 到 1A.3a，#79）。
- 身份盲化按场景种子洗牌（mulberry32，`seed + 场景序号 × 7`，#62 同式），
  映射写入 `sealed-identities.json`，评完前不揭示。
- v2 评审在 `scores.json` 上工作：每个配对轮只选 A 更好 / 持平 / B 更好，
  每场景再选一次整体判断；六个味觉维度只保留为争议场景的定向诊断工具。
- `unblind.ts`：结构化强制「先评后揭」——v2 scores.json 不完整（缺回合选择、
  缺场景整体选择或协议不匹配）即拒绝揭示。揭示后输出总体 / 分 locale / 受保护
  类别的三选一计数与净偏好、分层抽样信息、发布门槛复算，并对 conclusions.json
  的每条引文做归属反查（引文必须是所归属系统在该轮的原文子串，否则非零退出——
  #62 修订记录的教训机械化）。

## 使用

```sh
# 1. 构建 v2 盲评对：8 en + 5 zh + 2 code-switch；受保护类别至少各覆盖 1 个
pnpm exec tsx eval/blind-pairwise/build-pairs.ts \
  --baseline eval/conversation-text-baseline/run/transcripts.json \
  --candidate eval/incumbent-baseline/run/transcripts.json \
  --scenarios eval/scenario-pack-v2/scenarios.json \
  --out eval/blind-pairwise/run-next \
  --seed 79 --sample --sample-seed 79

# 2. 生成并打开单文件人工评测页
pnpm exec tsx eval/blind-pairwise/build-review-page.ts \
  --dir eval/blind-pairwise/run-next
open eval/blind-pairwise/run-next/index.html

# 3. 人工盲评：每个回合选择 A / tie / B，并为每个场景选择整体 A / tie / B；
#    页面导出 run-next/scores.json（schema 见 protocol.ts 的 PairwiseScoresFile）

# 4. 揭示 + 门槛复算
pnpm exec tsx eval/blind-pairwise/unblind.ts --dir eval/blind-pairwise/run-next

#    如本次有只引用样本场景的 conclusions.json，再追加：
# pnpm exec tsx eval/blind-pairwise/unblind.ts --dir eval/blind-pairwise/run-next \
#   --conclusions eval/blind-pairwise/run-next/conclusions.json
```

`--sample-seed` 改变抽样，`--seed` 改变 A/B 身份洗牌；两者都应记录在评测产物中。
如果需要复算历史 1–5 评测，省略 `--sample` 并使用旧的 `run-79/` 目录；工具仍兼容
`blind-pairwise:v1`。

## Luke 人工复评页面

`run-79/index.html` 是历史 v1 评测页；新的 v2 页面沿用
`prototype/issue-62-response-policies` 的可直接打开、浏览器本地保存和导出思路，
改为每回合 A / 持平 / B 与场景整体判断。页面只嵌入盲化的 `pairs.json`，不会读取
或暴露 `scores.json`、`sealed-identities.json`。

```sh
pnpm exec tsx eval/blind-pairwise/build-review-page.ts --dir eval/blind-pairwise/run-next
open eval/blind-pairwise/run-next/index.html
```

页面完成全部 15 个场景（本次样例是 38 个可比回合）后，下载 `scores.json`。把它放回
对应 run 目录后，再运行上面的 `unblind.ts`。本地草稿存于浏览器的 localStorage，
不会写入 SayHear 数据库或发送网络请求；完成 5 个场景时页面会提醒休息。

## 文件

| 路径 | 用途 |
| --- | --- |
| `protocol.ts` | v1/v2 协议类型、三选一选择、六维诊断命名、抽样配额、种子工具 |
| `build-pairs.ts` | 构建盲化 pairs；`--sample` 启用 v2 分层随机抽样与受保护覆盖 |
| `unblind.ts` | v1 中位数或 v2 三选一汇总、门槛复算、引文反查 → results.json |
| `run-79/` | #79 的实际盲评产物（pairs / sealed / scores / conclusions / results） |
| `run-79-v2/` | 基于同一批 #79 transcripts 生成的 v2 15 场景待评样例 |

## 边界

- v2 选择是单评审（Internal Owner 或其明确委托的操作者）的相对判断；工具只保证
  协议纪律（抽样与盲化可复现、先评后揭、引文可反查），不替代 ADR-0110 的人工权威。
- 硬门禁不在此目录：见 `eval/scenario-pack-v2/check-transcripts.ts` 的
  TieredReport。本目录只承担 pairwise 证据项。
- 受保护类别固定为 `high_risk` / `refusal` / `short_answers` / `topic_change`
  / `direct_task`（契约 §八：安全、停止信号、能力诚实）。

## References

- 规则：[行为契约与评测 rubric](../../docs/evaluation/01-behavior-contract-and-rubric.md)
  · [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md)
  · [ADR-0114](../../docs/adr/0114-low-fatigue-pairwise-evaluation-sampling.md)
- 数据：[#61 基线](../conversation-text-baseline/) · [scenario-pack v2.1](../scenario-pack-v2/)
- 先例：#62 盲评（issue 评论，种子洗牌与引文反查的来源）
- Task: [#79](https://github.com/lukemyself-hub/SayHear/issues/79)
