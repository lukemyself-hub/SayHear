# Blind pairwise run-79-v2（低负担人工复评样例）

## Status

待 Luke 评测。这个目录不是历史 `run-79` 结果的替换，而是用同一批 #79 baseline /
candidate transcripts 生成的 `blind-pairwise:v2` 样例，供后续评测流程使用。

## 抽样

- 可比候选：30 个（en 10 / zh 10 / code-switch 10）。
- 本页样本：15 个（en 8 / zh 5 / code-switch 2），固定抽样种子 `79`。
- 受保护类别至少覆盖一个：`high_risk`、`refusal`、`short_answers`、
  `topic_change`、`direct_task`。
- 15 个场景共有 38 个可比回合；顺序已按种子打散，避免按语言或类别连续评分。

## 评测方式

每个回合只选择一次 `A 更好 / 持平 / B 更好`；读完整个场景后再选择一次整体判断。
不要为两边分别打六个 1–5 分。完成 5 个场景后建议休息几分钟，避免后期麻木和假
精度。页面备注均为可选。

```sh
open eval/blind-pairwise/run-79-v2/index.html
```

完成后把页面导出的 `scores.json` 放入本目录，再运行：

```sh
CI=true pnpm exec tsx eval/blind-pairwise/unblind.ts \
  --dir eval/blind-pairwise/run-79-v2
```

如果本次另有只引用本样本场景的 `conclusions.json`，再追加
`--conclusions eval/blind-pairwise/run-79-v2/conclusions.json` 做引文归属反查。

## 文件

| 路径 | 用途 |
| --- | --- |
| `pairs.json` | 15 个盲化场景与 38 个可比回合，含抽样元数据 |
| `sealed-identities.json` | A/B 身份映射，评测完成前不要打开 |
| `index.html` | v2 单文件人工评测页 |
| `scores.json` | 待 Luke 导出的三选一评分文件 |
| `results.json` | 待 `unblind.ts` 生成的结果与门槛复算 |
