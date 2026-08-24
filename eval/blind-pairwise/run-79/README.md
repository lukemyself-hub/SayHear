# Blind pairwise run-79 结果(#79 merge gate; Luke 人工复评)

## Status

Scored & unblinded — Luke 人工复评，`scoredAt: 2026-08-24T06:23:36.237Z`。
协议与工具见
[`../README.md`](../README.md);权威规则在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../../docs/evaluation/01-behavior-contract-and-rubric.md)。

## 对比双方

- **baseline** = #61 thin-persona 冻结运行(`eval/conversation-text-baseline/run/`,
  永久归档的改革前基线)。
- **candidate** = 1A.2P merged run(`eval/incumbent-baseline/run/`,
  canonical-persona:v2 / anchors:v2 / locale packs v2 / task-instruction:v2 /
  safety-resources:v2,champion 不变:deepseek / deepseek-v4-flash)。
- 种子 79(mulberry32,`79 + 场景序号 × 7`);配对 30 场景 / 75 个
  用户输入逐字一致的轮次(memory_continuity 3 场景按 #79 排除、12 个
  #77 新增场景无基线对照、12 个改写/追加轮不可比,均记录在 pairs.json)。

## 结果(unblind 复算,results.json)

| 维度 | baseline 中位数 | candidate 中位数 |
| --- | --- | --- |
| 生命力 | 2 | **4** |
| 温暖关心 | 3 | **4** |
| 真诚 | 3 | **4** |
| 分寸 | 3 | **4** |
| 自然 | 2 | **4** |
| 口语度 | 2 | **4** |

- 总体与三个 locale(en / zh / code_switch)独立复算:生命力均 2 → 4、温暖关心均
  3 → 4,**严格更好**(发布证据第 2/3 条满足;任一 locale 单独看也成立)。
- 受保护类别(安全 high_risk、停止信号 refusal/short_answers/topic_change、
  能力诚实 direct_task)六维中位数无一下降。
- 场景最佳 27-3(candidate 27 / baseline 3);基线胜出的场景为
  `good-news-en`、`refusal-zh`、`good-news-mix`。
- 揭示后结论 11 条全部通过引文反查(conclusions.json,unblind 工具强制,
  任何引文不属于所归属系统即非零退出)。

## 评分者记录(如实记录)

- 本次评分由 Luke 本人按当前 rubric 完成;`scores.json` 与 `results.json`
  已替换此前委托 Agent 的评分与揭示结果。
- 评分仍是单评审判断;种子洗牌、先评后揭、逐轮六维分数、场景最佳与引文反查
  固定了过程，但不消除单评审的主观性。
- 评测范围仍是 30 个场景 / 75 个可比回合;`memory_continuity` 与没有冻结基线
  对照的新增场景按 #79 约定排除。

## 文件

| 路径 | 内容 |
| --- | --- |
| `pairs.json` | 盲评对(无身份) |
| `index.html` | Luke 的六维人工复评页面，不含本次已有评分或身份映射 |
| `sealed-identities.json` | 揭示前封存的洗牌映射 |
| `scores.json` | 逐轮六维分数 + 场景最佳 + 备注(仅 A/B 语言) |
| `conclusions.json` | 揭示后结论(引文 + 归属 + 论断) |
| `results.json` | 揭示映射、中位数、门槛复算、反查记录 |
