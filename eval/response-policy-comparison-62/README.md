# Response policy comparison prototype（issue #62）

## Status

Disposable prototype — 盲评产物，非权威证据（对齐 ADR-0073 的精神：对比运行永不写
产品状态）。本目录整体是一次性制品，问题解答后随分支归档，不合入 main。

## 回答的问题

哪一种具体回应策略最能产生「被理解、被在乎、值得被倾听」的目标感受，而不变得
戏剧化、侵入、重复或访谈化？（[#62](https://github.com/lukemyself-hub/SayHear/issues/62)）

方法：同一批代表性对话 × 5 种回应策略 × 同一 champion 模型（deepseek /
deepseek-v4-flash，与 #61 基线同模型），直接模型调用（无数据库、无产品状态）。
Luke 在 `run/index.html` 中盲评（策略身份默认隐藏）并逐条标记反应。

## 策略阶梯

| Key | 策略 | 相对现状的单一变量 |
| --- | --- | --- |
| A | 当前 thin Persona | 无（`sayhear-persona:v1` + `conversation-text:v1` 七段指令复刻，即 #61 基线行为） |
| B | Emotion-first 单遍回应 | 只改任务框架：先识别并回应话语底下的情绪；零问题也是完整回应；禁止复述模板开场 |
| C | Rich Persona（#67 契约 prompt 化） | 把 ADR-0108/0109 + CONTEXT.md Canonical Persona 写成多段 persona 指令（selective curiosity、停止信号、节奏、幽默边界、安全让位、能力诚实、不编造热线号码） |
| D | Memory-aware | C + 「你记得什么」记忆块（仅有证据的场景）+ Continuity 使用规则；无证据时显式声明暂无记忆 |
| E | Transient response-intent | C + 每轮瞬态意图规划（回应动作 + 是否提问，默认不问；高风险后强制安全锚点），意图不进入对话历史 |

## 场景选择

7 段场景取自 `../conversation-text-baseline/scenarios.json` 原文，选自 #61
analysis.md 观察到失败模式的位置：ordinary-sharing-en（模板节奏基线）、
good-news-zh（建议泄漏 + 幽默空间）、hidden-emotion-mix（发明感受 / 文学化重构）、
short-answers-mix（停止信号）、direct-task-mix（能力诚实）、high-risk-mix（编造
热线 + 安全姿态持续性）、memory-continuity-mix（跨日连续性）。

其中 good-news-zh 与 memory-continuity-mix 为策略 D 附加记忆证据（前者为假设性
上周记忆，后者为第一天对话投影），产物中已标注。

## 运行

```sh
tsx eval/response-policy-comparison-62/generate.ts
```

需要 `.env` 中的 `SAYHEAR_PROVIDER_ADAPTER` / `DEEPSEEK_API_KEY`（或 openai 配置）。
输出 `run/comparison.json`（数据）与 `run/index.html`（双击即开的盲评产物）。

## 已知边界

- 直接模型调用近似新鲜对话的指令栈：无 daily_session id、无投影（与 #61 基线的
  fresh-schema 条件一致）；每个策略的对话历史只含本策略自己的回应。
- 抽样非确定性（provider 默认采样，每轮单样本）。
- 「问 xN」为机械计数（?/？ 出现次数），只是客观事实展示，不构成评判。

## References

- [Run data](run/comparison.json) · [盲评产物](run/index.html)
- Baseline: [`../conversation-text-baseline/`](../conversation-text-baseline/)（#61）
- Persona 契约：ADR-0108、ADR-0109、`CONTEXT.md`、`docs/product/15-conversation-behavior.md`
