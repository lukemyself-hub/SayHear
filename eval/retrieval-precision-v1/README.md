# Retrieval-Precision Accounting Corpus（issue #125）

## Status

Runnable eval artifact — SPEC [#107](https://github.com/lukemyself-hub/SayHear/issues/107)
AC 38 的载体（"one new eval-side harness … follows the pack-runner pattern —
build, run, metrics, ledger — and exists to produce the accounting baseline,
not to gate"）。非权威评测制品（ADR-0020 / ADR-0073 精神、ADR-0110）：仅合成输入，
不写产品状态，不设召回质量阈值。

## TL;DR

- `corpus.ts`（`retrieval-precision-corpus:v1`，seed 20260828）：全合成多日语料——
  10 自然日 × 2 session × 12 turn；36 个 planted Claims（Objective Memory、人物、
  关系 + temporal change、impressions）+ 37 个 distractors；en / zh / mix 三语；
  40 条 probe 查询全部跨日（语料校验器强制），外加 post-forget 与 post-dormancy
  围栏探针（合计 41 条运行）。
  重建字节级确定，纯数据、无 IO。
- `harness.ts`：把语料经**生产写路径**种入（conversation submit、claim admission
  + registry write-through、whole-claim forget、impression dormancy；Evidence 行
  与 fast-path 形状一致），随后每条 probe 走**同一个生产检索函数**
  （`createMemoryRetrievalService` + `PostgresMemoryRetrievalRepository`），
  钉生产 200ms 策略；不存在平行实现。每轮注入再经生产 fence loader +
  `evaluateTrustFences` 复检。
- `metrics.ts`：纯函数会计——hit rate（retrieved / injected 两级）、
  query-retrieval precision（以查询时快照的 ground truth 为真值；只统计
  query-retrieved 注入，Portrait 注入单独记账）、三类绝对零：fence leakage、
  budget violations（budgets v1 天花板逐项复核）、deadline violations。
  **无任何召回质量阈值**（budgets v2 待生产 manifest 后另立）。
- `run-corpus.ts`：CLI——隔离 schema、迁移、种植、运行、产出
  `run/<stamp>/{metrics.json, ledger.json, planted.json}`；绝对零被打破时退出
  非零。hit rate / precision 永不 gate。

## 地面真值与口径（机械、可复算）

- 查询时快照：probe 的 expected/fenced 版本 id 在**查询当时**记录（supersede
  会改写 claim 的 current version，事后重算会错判早期探针）。
- `hitRetrieved`：expected ∩ cutoff 通过的候选 ≠ ∅；`hitInjected`：
  expected 出现在任一 section 注入。
- precision 分母/分子只算 `query_retrieval` 注入；注入但非 expected 的条目在
  ledger 中逐条分类（`planted_other` / `distractor` / `unplanted`）。
- fence leakage：注入项在生产 fence 复检中任一围栏失败，或被 forget 探针
  围住的 claim 版本出现在任何 section 注入。
- 围栏探针：proj-nebula / travel-neg 在语料中被用户显式 forget，d10 有
  post-forget 探针；imp-consider 在语料结束后由时钟跳过 30 天复核期
  （ADR-0041）强制 dormant，另有 post-dormancy 探针。注入即违规。
- 布局规则：同 session 内查询回合先于陈述回合（探针的 prior-exchange
  来源只含探针自身）；filler 文本无 registry 词面、无实体名、无时间词
  （单测对真 `buildRetrievalQuery` 逐一证明）。

## 使用

```sh
# 会计基线运行（写入 run/<stamp>/，绝对零违规时退出非零）
TEST_DATABASE_URL=postgresql://localhost/sayhear_test \
  pnpm tsx eval/retrieval-precision-v1/run-corpus.ts

# 纯侧证明（确定性、计数、真值完整性、真 buildRetrievalQuery 预验证、指标数学）
pnpm exec vitest run tests/retrieval-precision-corpus.test.ts

# 端到端（真 PostgreSQL，隔离 schema）
pnpm exec vitest run tests/system/retrieval-precision-corpus.system.test.ts
```

## 基线（v1 语料，2026-08-28，本地 Neon Postgres）

`run/2026-*/` 为提交的证据运行：41 探针、73 claims 全部经生产准入；hit rate
(retrieved) 0.9268 / (injected) 0.9024，query-retrieval precision 0.6129；
fence leakage / budget violations / deadline violations / degraded rounds
全部为 0，p95 时长 ≤ 200ms。**这些数字是会计基线，不是门槛**——precision 的
分母含「同实体相关但非本探针目标」的诚实注入，逐条记录在 ledger 供人复核。

## 记录的边界

- `currentTopic` 恒为 null（DialogueState 投影不进本 harness 的输入）；这会让
  依赖 topic 词面的命中路径缺席，是本基线的已知口径，不改变生产代码。
- 语料中的 forget / dormancy 探针直接调用生产 trust-action 与 dormancy 服务，
  不经对话 Agent 回合——本 harness 只测检索会计，不测行为表达。
- 附带生产修复（本 harness 挖出的潜伏缺陷，见 PR 描述）：`#116` 的 forget
  路径物理 DELETE `claim_retrieval_projections` 会撞上
  `retrieval_run_candidates` 的 FK（candidate 行被不可变触发器保护）——任何
  「先被检索命中过、后被忘掉」的真实序列都会让 Forget 不可执行。修复为冻结
  触发器明确放行的 `active → deleted` 生命周期转换；三条 lane 与 Portrait/
  hydration 均只读 `status='active'`，结构性停召回的保证不变。

## 文件

| 路径 | 用途 |
| --- | --- |
| `corpus.ts` | 语料定义 + 校验（纯函数，固定 seed） |
| `harness.ts` | 种植 + 生产检索运行 + fence 复检 |
| `metrics.ts` | 会计指标 + 绝对零判定（纯函数） |
| `run-corpus.ts` | CLI（隔离 schema，写 run 产物） |
| `run/` | 提交的基线证据运行 |
| `README.md` | 本文件 |

## References

- SPEC: [#107](https://github.com/lukemyself-hub/SayHear/issues/107)（AC 38、
  Testing Decisions "Seams"）· Task: [#125](https://github.com/lukemyself-hub/SayHear/issues/125)
- ADR: [0115](../../docs/adr/0115-memory-recall-starts-with-structured-lexical-retrieval.md) ·
  [0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md) ·
  [0038](../../docs/adr/0038-explicit-user-statements-create-confirmed-objective-memory.md) ·
  [0039](../../docs/adr/0039-ai-impressions-require-cross-session-evidence.md) ·
  [0041](../../docs/adr/0041-only-ai-impressions-use-time-based-dormancy.md)
- 先例: [`eval/predicate-registry-v1/`](../predicate-registry-v1/) ·
  [`eval/scenario-pack-v3/`](../scenario-pack-v3/)
- Map: [#58](https://github.com/lukemyself-hub/SayHear/issues/58)
