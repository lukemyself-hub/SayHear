# Memory 盲评孪生 + Cutover 收口（issue #126）

## Status

Runnable eval artifact — SPEC
[#107](https://github.com/lukemyself-hub/SayHear/issues/107) AC 35–40 的收口
载体。非权威评测制品（ADR-0020 / ADR-0071 / ADR-0073）：仅合成输入，
Memory-off 对照臂由**显式非权威 Replay** 在同一冻结输入上生成，绝不走
production shadowing。规则权威在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)
与 ADR-0110 / ADR-0114。

> 证据版本边界：`run-twins-on/` 下的 findings、pins 和 transcript 产物是
> `scenario-pack:v3.3` 在 `ce9b0bd` 的历史运行快照。#148 只把 objective 背景公司名
> 的 required token 降为 advisory 语义期望，当前 fixture 已升为 v3.4；本票没有重新
> 调用 provider，因此这些旧产物不能当作 v3.4 的运行证据。

## TL;DR

- `capture-twins.ts --arm on|off`：把冻结的场景包（默认
  `scenario-pack:v3`，54 场景）经**真实认证 Text seam + 真实 champion** 各跑
  一臂。Memory-on = cutover 配置（fast-path extraction 经真实 outbox 机制派
  发、跨日边界做 due consolidation 扫描、Structured-Lexical 检索接入 Context
  Compiler）；Memory-off = 同一 seam 关掉三个生产写开关（无 Claim 写入、无
  memory section）。逐轮记录注入证据（compiled context 的 memory sections +
  retrieval manifest 指针）。隔离 schema，跑完即弃。
- `verify-cutover-pins.ts`：SPEC pin list 机械校验——manifest 记录的每个 pin
  必须与生产代码解析出的常量逐项相等（manifest 不能漂移），且每轮
  CompiledContext 的 retrieval manifest 记录的选择策略版本
  （portrait-selection / memory-budgets / recall-framing）一致；query-construction
  另由 cutover pin 与 retrieval run manifest 版本互证；eval 侧 scenario-pack:v3
  + tiered-checks:v3 一并核对。
- `build-memory-pairs.ts`：ADR-0114 memory 扩展的 15 场景分层抽样
  （8 en / 5 zh / 2 code-switch，固定种子），强制覆盖 Objective Memory、
  Portrait / AI Impression、跨日连续性、post-Correction 与 post-Forget
  非复用。Memory-off 臂 = "baseline"，Memory-on 臂 = "candidate"——沿用
  `blind-pairwise:v2` 协议，评审页 / 揭示 / 门槛复算复用
  [`eval/blind-pairwise/`](../blind-pairwise/) 的既有工具（净偏好严格为正、
  每语言不得净回退、受覆盖类别不得净回退、持平不计分）。
- `rollback-demo.ts`：回滚演示——Phase A（cutover 后）写入 Claim 并跨日注入；
  Phase B（code revert + re-pin）用 pre-1A.3a incumbent 组装在同一数据库上
  回答追问；机械证明 memory 数据面原地冻结（Claim 计数不变）、data epoch
  未动、回退后无任何 memory section。
- `scope-protection.ts`：AC 40 合并范围保护——迁移史无
  embedding/vector/Episode/Open Loop/Proactive/Reflection/Profile Projection
  DDL；生产源码无 embedding/backfill 代码路径；champion 簇与 1A.2P 冻结
  incumbent 逐字节一致（无模型路由 / Provider / Champion 变更）。

## 使用

> **2026-08-29 状态**：Memory-off 臂与 rollback demo 已完成入库；Memory-on 臂在
> DeepSeek 余额耗尽（HTTP 402 Insufficient Balance）后 38/54 场景处中断，产物已
> 删除。充值后重跑第 1 步 ON 臂（`SAYHEAR_PROVIDER_TIMEOUT_MS=180000`，memory.extract
> 单次调用 40–70 s 是瓶颈），再依次执行第 2 步起的所有检查。OpenAI 备用 key 已失效
> （401），不可切换。

```sh
# 0. 前置门槛：v3 包 fixture 机械校验（#126 证据运行必须先过这道门）
pnpm exec tsx eval/scenario-pack-v3/verify-pack.ts

# 1. 双臂捕获（真实 champion；两臂同一冻结输入；ON 臂需要 180s provider timeout）
SAYHEAR_PROVIDER_TIMEOUT_MS=180000 \
  pnpm exec tsx eval/memory-pairwise-126/capture-twins.ts --arm on
pnpm exec tsx eval/memory-pairwise-126/capture-twins.ts --arm off

# 2. 确定性硬门禁（AC 35）：tiered-checks:v3 过 Memory-on 转录
pnpm exec tsx eval/scenario-pack-v3/check-transcripts.ts \
  eval/memory-pairwise-126/run-twins-on/transcripts.json \
  eval/memory-pairwise-126/run-twins-on/findings.json \
  eval/scenario-pack-v3/scenarios.json

# 3. 45 场景机械复跑（AC 37）：v2.1 fixture 联接同一转录的 45 场景子集
pnpm exec tsx eval/scenario-pack-v2/check-transcripts.ts \
  eval/memory-pairwise-126/run-twins-on/transcripts.json \
  eval/memory-pairwise-126/run-twins-on/findings-v2.json \
  eval/scenario-pack-v2/scenarios.json

# 4. pin list 校验 + 范围保护
pnpm exec tsx eval/memory-pairwise-126/verify-cutover-pins.ts \
  --manifest eval/memory-pairwise-126/run-twins-on/manifest.json \
  --transcripts eval/memory-pairwise-126/run-twins-on/transcripts.json \
  --pack eval/scenario-pack-v3/scenarios.json
pnpm exec tsx eval/memory-pairwise-126/scope-protection.ts \
  --twin eval/memory-pairwise-126/run-twins-on/manifest.json

# 5. 15 场景 memory 盲评对 + 评审页（AC 36 的人工部分 = Internal Owner）
pnpm exec tsx eval/memory-pairwise-126/build-memory-pairs.ts \
  --memory-on  eval/memory-pairwise-126/run-twins-on/transcripts.json \
  --memory-off eval/memory-pairwise-126/run-twins-off/transcripts.json \
  --scenarios  eval/scenario-pack-v3/scenarios.json \
  --out eval/memory-pairwise-126/pairs-run --seed 126 --sample-seed 1260
pnpm exec tsx eval/blind-pairwise/build-review-page.ts \
  --dir eval/memory-pairwise-126/pairs-run
open eval/memory-pairwise-126/pairs-run/index.html   # Luke 盲评 → scores.json
pnpm exec tsx eval/blind-pairwise/unblind.ts --dir eval/memory-pairwise-126/pairs-run

# 6. 回滚演示（真实 champion）
pnpm exec tsx eval/memory-pairwise-126/rollback-demo.ts
```

## 证据台账（AC 35–40 对照）

| SPEC AC | 证据 | 位置 |
| --- | --- | --- |
| 35 确定性硬门禁 100% | tiered-checks:v3 全量报告（hard gate 零命中） | `run-twins-on/findings.json` |
| 36 memory 盲评孪生 | 15 场景分层样本 + Internal Owner 盲评 + unblind 门槛 | `pairs-run/` |
| 37 45 场景机械复跑 | v2.1 fixture 联接的 v2 检查报告 | `run-twins-on/findings-v2.json` |
| 38 检索精度会计基线 | #125 交付的 corpus 运行（fence/budget/deadline 绝对零） | [`eval/retrieval-precision-v1/run/`](../retrieval-precision-v1/) |
| 39 trust-action 数据集门禁 | #124 交付的 selection dataset gates | [`eval/action-selection/`](../action-selection/) |
| 40 范围保护 | scope-protection 报告（零 1A.3b 产物、champion 簇不变） | `run-twins-on/scope-protection.json` |
| pin list / rollback | pins-report + rollback-demo（数据面原地冻结） | `run-twins-on/pins-report.json` · `rollback-demo/` |

配额不因凑数增加评分动作（ADR-0114）；盲评 misses 由 Internal Owner（Luke）
裁定，不得自我豁免（ADR-0110）。若出口条件未满足，切片不合入、继续迭代。

## 边界

- 采样与盲化种子记录在产物内；同种子可复现抽样与身份洗牌。
- Memory-on 臂的行为质量取决于真实 extraction / retrieval 管线；token 级
  required-recall 是零容忍硬门禁（不满足即迭代，不以偏好抵消）。
- 确定性系统测试（deterministic provider + scripted memory roles）覆盖
  harness 本身：`tests/system/memory-pairwise-twins.system.test.ts`。
- 本目录不写产品状态；所有运行落在一次性隔离 schema，跑完即弃。

## References

- 规则：[行为契约与评测 rubric](../../docs/evaluation/01-behavior-contract-and-rubric.md) ·
  [ADR-0071](../../docs/adr/0071-model-comparison-uses-explicit-replay-not-shadowing.md) ·
  [ADR-0073](../../docs/adr/0073-replay-is-non-authoritative-and-cannot-write-product-state.md) ·
  [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md) ·
  [ADR-0114](../../docs/adr/0114-low-fatigue-pairwise-evaluation-sampling.md)
- 复用：[`eval/blind-pairwise/`](../blind-pairwise/)（评审页 / unblind）·
  [`eval/scenario-pack-v3/`](../scenario-pack-v3/)（fixture 与检查器）·
  [`eval/incumbent-baseline/`](../incumbent-baseline/)（champion 簇对照与
  1A.2P 回滚演示先例）
- SPEC: [#107](https://github.com/lukemyself-hub/SayHear/issues/107) ·
  Task: [#126](https://github.com/lukemyself-hub/SayHear/issues/126)
