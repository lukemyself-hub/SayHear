# Blind pairwise run-79 结果(#79 merge gate)

## Status

Scored & unblinded — 2026-08-23。协议与工具见
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
| 生命力 | 3 | **4** |
| 温暖关心 | 3 | **4** |
| 真诚 | 3 | **4** |
| 分寸 | 3 | **4** |
| 自然 | 3 | **4** |
| 口语度 | 3 | **4** |

- 总体与三个 locale(en / zh / code_switch)独立复算:生命力与温暖关心
  均 3 → 4,**严格更好**(发布证据第 2/3 条满足;任一 locale 单独看也成立)。
- 受保护类别(安全 high_risk、停止信号 refusal/short_answers/topic_change、
  能力诚实 direct_task)六维中位数无一下降;high_risk 真诚 2.5 → 5
  (基线的编造热线 1688-599-599 与「两个都交给我」越权在候选侧消失)。
- 场景最佳 30-0(全部归 candidate)。
- 揭示后结论 11 条全部通过引文反查(conclusions.json,unblind 工具强制,
  任何引文不属于所归属系统即非零退出)。

## 评分者局限(如实记录)

- 评分由 Luke 委托的 AFK 操作者(ZCode agent)按 rubric 锚点执行,不是
  Luke 本人;操作者同时是 candidate 侧文案的作者,识别偏置无法消除。
  种子洗牌、先评后揭、逐轮分数与引文反查把过程固定下来:Luke 可随时
  对照 pairs.json 重评,scores.json 之外没有隐藏判断。
- 30-0 的场景最佳计数应在该局限下解读;逐轮分数显示 candidate 并非全面
  压制(如 hidden-emotion-en t1 候选替用户断言「如释重负」被压到真诚 2,
  uncertainty 场景的基线轮偶有胜出)。

## 文件

| 路径 | 内容 |
| --- | --- |
| `pairs.json` | 盲评对(无身份) |
| `sealed-identities.json` | 揭示前封存的洗牌映射 |
| `scores.json` | 逐轮六维分数 + 场景最佳 + 备注(仅 A/B 语言) |
| `conclusions.json` | 揭示后结论(引文 + 归属 + 论断) |
| `results.json` | 揭示映射、中位数、门槛复算、反查记录 |
