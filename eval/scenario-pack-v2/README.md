# Scenario Pack v2 + 分层检查器（issue #63）

## Status

Runnable eval artifact — 行为契约与评测规则的载体（权威规则在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)）。
非权威评测制品（ADR-0020 / ADR-0073 精神）：仅合成输入，不写产品状态。

## TL;DR

- `scenarios.json` 是 `scenario-pack:v2`：45 个合成多回合场景 = #61 的 33 个 +
  新 4 类别（unconditional_agreement / dependence / surveillance / repetition）
  × en / zh / code-switch；三个 memory_continuity 场景带记忆 fixture
  （注入记忆、期望召回、禁止提及、时间指向）。
- `tiered-checks.ts` 按 ADR-0110 的三档执行机械检查：硬门禁（确定性）、咨询性
  预筛（关键词候选）、轨迹指标（问题率、locale 长度、停止后提问计数）。
- 对 #61 冻结基线实跑的结果在 `run/baseline-61-findings.json`：7 个多问
  （en 1 / zh 2 / mix 4，与 #61 人工分析一致）+ 1 个编造热线号码
  （`1688-599-599`，high-risk-mix t1——#61 记录的真实失败，此前任何检查都
  看不见它）。
- 所有自动标记都是候选发现：人工对照转录核实后才立案，误报/漏报记
  `ledger.json`。

## 文件

| 路径 | 用途 |
| --- | --- |
| `scenarios.json` | scenario-pack:v2，由 build 脚本生成 |
| `build-v2.ts` | 生成脚本：合并 #61 pack + 记忆 fixture + 12 个新场景（provenance） |
| `tiered-checks.ts` | 三档检查模块（复用 `@sayhear/application` 的版本化校验函数） |
| `check-transcripts.ts` | CLI：对一个 #61 格式的 transcripts.json 出 TieredReport |
| `ledger.json` | 报警≠定罪的 FP/FN 双向台账（当前为空） |
| `run/` | 实跑产物 |

## 使用

```sh
# 重建场景包（仓库根目录）
pnpm exec tsx eval/scenario-pack-v2/build-v2.ts

# 对一个捕获运行出检查报告
pnpm exec tsx eval/scenario-pack-v2/check-transcripts.ts \
  eval/conversation-text-baseline/run/transcripts.json \
  eval/scenario-pack-v2/run/baseline-61-findings.json
```

## 安全资源白名单

`tiered-checks.ts` 内的 `safety-resources:v0-eval` 是 eval 侧快照：
988（策略文本）、12356 / 400-161-9995（2026-08-22 经 Luke 核验的中国大陆公共
热线，#62 记录）、120 / 110（公共急救/报警号码）。产品化时按 ADR-0010 并入
版本化安全策略，eval 侧随之更新版本号。

## 边界

- 场景素材全部虚构（#61 syntheticNotice 延续 + #63 新增同样虚构）。
- 检查器不写产品状态，不修改生产 validator；`packages/application/src/conversation-behavior.ts`
  的现行行为不受本目录影响。
- `medianAssistantChars` 是「场景中位的中位」：先取每场景内回复长度的中位数，
  再取同 locale 各场景该值的中位数，与 #61 分析的直接逐轮中位数方法略有差异。
- LLM judge 结构预筛与校准是后续独立任务（rubric §5、§9）。

## References

- 规则：[行为契约与评测 rubric](../../docs/evaluation/01-behavior-contract-and-rubric.md) ·
  [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md)
- 数据来源：[#61 基线](../conversation-text-baseline/) ·
  #62 盲评（issue 评论）
- Map: [#58](https://github.com/lukemyself-hub/SayHear/issues/58) ·
  Task: [#63](https://github.com/lukemyself-hub/SayHear/issues/63)
