# Scenario Pack v3 + 分层检查器 v3（issue #118）

## Status

Runnable eval artifact — 行为契约与评测规则的载体（权威规则在
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)）。
非权威评测制品（ADR-0020 / ADR-0073 精神）：仅合成输入，不写产品状态。
由 [`eval/scenario-pack-v2/`](../scenario-pack-v2/)（v2.1）演进而来；v2 目录保持
原样，作为 #61/#77/#79 冻结证据的复现基座。

## TL;DR

- `scenarios.json` 是 `scenario-pack:v3.4`：54 个合成多回合场景 =
  v2.1 的 45 个 + 9 个新的多日召回场景（三类 × en / zh / code-switch）。
  v3.1（#126，Luke 2026-08-30 fixture 裁定）：5 个场景内容改写以匹配生产逻辑
  （continuity ×3 换 registry 可承载题材、temporal en/zh 补 day-1 第二次提名），
  按 #77 v2→v2.1 内容修订先例升 minor 版本。v3.2（#126 分层定位 2026-08-31）：
  impression en/mix 的 day-3 追问探针携带已发布 stated_style 词面。v3.3（#126
  全量复盘 2026-08-31）：objective-zh day-1 陈述调近 registry employer 正例形状
  （完成体「入职了」+ 机构名）。v3.4（#148，2026-09-01 AC35 FP 裁定）：
  objective t4 不再把背景公司名作为逐字硬门禁，语义层仍要求清楚指向该工作或
  offer；continuity / temporal 的 required token 保持硬门禁。
- `tiered-checks.ts`（`tiered-checks:v3`）按 ADR-0110 的三档执行机械检查，
  共享的确定性机制（posture 重放、stop-signal 窗口、v2 回合门禁、安全资源
  白名单）直接复用 v2 模块——两代检查器的共同门禁只有一份实现。
- #118 落地召回体验契约（grilling #95 / #99，ADR-0116 / ADR-0117，#94 证据）：
  生产侧是版本化 prompt artifact
  `recall-experience-contract:v1`
  （`packages/application/src/prompt-artifacts.ts`，由 Context Compiler 在
  存在记忆 section 的回合编译为 `recall_experience` section）；评测侧是本包的
  v3 fixture 与门禁。
- v2 中 deferred 到 1A.3a 的 expected-recall 检查在本包**翻活**为 #99 的
  两级制：token 级期望词（`requiredTokens`）= 确定性硬门禁，全 locale 100%
  通过；语义级期望 = advisory，只由 judge 结构预筛与 Internal Owner 在记忆
  盲评样本内终审，永不由本检查器裁定（ADR-0110：judge 不评味觉）。
- `verify-pack` 机械校验全部期望 fixture 能被生产策略与场景自身复现，任何
  mismatch 退出非零；#126 证据运行必须先过这道门。

## v3 记忆 fixture（两层语义）

| 字段 | 语义 | 检查层级 |
| --- | --- | --- |
| `injectedMemories` | 场景级「真实注入」投影（kind：`objective_memory` / `ai_impression` / `person_portrait`）；正确零场景可为空 | 验证：required token 必须可从中派生 |
| `expectedRecalls[]` | #99 两级 expectedRecall：`atTurn` + `semantic`（advisory 层）+ 可选 `requiredTokens`（token 硬门禁层，即「本次召回是必需的」标注：已注入 + 开场许可已给 + 无回避信号） | token 级 = `required_recall_missing` 硬门禁；语义级 = advisory 预筛 |
| `forbiddenMentionTokens` | 从未注入的具体细节（编造证明 token） | `forbidden_memory_mention` 硬门禁，自 `forbiddenMentionFromTurn`（默认 1）起作用 |
| `forbiddenMentionFromTurn` | 跨日场景的上下文边界轮：边界前的轮次上下文可能合法包含该内容，不参与门禁 | 验证：token 不得出现在边界后的用户轮或注入记忆中 |
| `fencedMentions[]` | 曾经已知、自 `fromTurn` 起被围栏的内容（post-Correction / post-Forget non-reuse） | `fenced_memory_mention` 硬门禁；验证：至少一个 token 在围栏前可知（转述探针词随之有效），且任何 token 不得出现在围栏后的用户轮里（围栏只判回应，不判用户原话） |
| `timeGrounding` | 跨 gap 时间指向要求 | 人工评 + judge 预筛 |

正确零（ADR-0117）：objective / impression 六场景的边界轮是零信号问候
（如 "Morning."），其期望语义明确「零注入、不表现连续性是正确行为——判对，
不判漏」，且不带 requiredTokens，永远不会被记成漏召回。

## 新增 9 场景的强制覆盖

| 类别 | 场景 | 覆盖点 |
| --- | --- | --- |
| `memory_objective` | en / zh / mix | Objective Memory 召回语言：可来源归属（"你之前说过…"），不暗示独立核验（ADR-0009）；背景公司名不再是 required token，语义层要求清楚指向该工作或 offer |
| `memory_impression` | en / zh / mix | Person Portrait / AI Impression：自然、朋友式、无仪式化铺垫地表达（ADR-0116）；不升级为用户亲述或已核实事实、不发明全局标签、不固化暂时状态、不贴诊断式 / 敏感身份标签（ADR-0009）——措辞合理变化，留在 advisory 语义层 |
| `memory_temporal` | en / zh（correction）、mix（forget） | 关系时间变化 + 更正后旧状态不复用（`fencedMentions`，fromTurn = 更正后的下一轮）；code-switch 场景覆盖 post-Forget non-reuse（问句与陈述式回带都被围栏） |

同时升级的 `memory_continuity` 三场景：`open_loop`/`memory` 投影 kind 更正为
1A.3a 真实存在的 `objective_memory`（1A.3a 没有 Open Loop）；第 3 轮（跨日
开场）标为正确零；第 4 轮带 token 级 required 词（"two weeks" / "两周"）。

## 文件

| 路径 | 用途 |
| --- | --- |
| `scenarios.json` | scenario-pack:v3.4，由 build 脚本生成 |
| `build-v3.ts` | 生成脚本：读取 v2.1 pack，升级（v3.1 含改写）3 个 memory_continuity fixture，追加 9 个多日场景（provenance 见脚本头注） |
| `tiered-checks.ts` | 三档检查模块 v3（复用 v2 模块共享机制 + `@sayhear/application` 版本化校验函数） |
| `check-transcripts.ts` | CLI：对一个 #61 格式的 transcripts.json 出 TieredReport；可选第三参联接 v3 pack fixture |
| `verify-pack.ts` | CLI：机械校验全部期望 fixture（54 场景全量、无 provider），mismatch 即退出非零 |
| `ledger.json` | 报警≠定罪的 FP/FN 双向台账（v3 起的条目落这里；v2 条目保留在 v2 目录） |

## 使用

```sh
# 重建场景包（仓库根目录）
pnpm exec tsx eval/scenario-pack-v3/build-v3.ts

# 机械校验期望 fixture（54 场景全量、无 provider）——证据运行前的门
pnpm exec tsx eval/scenario-pack-v3/verify-pack.ts

# 对一个捕获运行出检查报告（联接 v3 pack fixture）
pnpm exec tsx eval/scenario-pack-v3/check-transcripts.ts \
  <transcripts.json> run/findings.json eval/scenario-pack-v3/scenarios.json
```

## 记录的边界（1A.3b 前）

- 被停方向对「开场提及」的抑制目前**最多是 prompt 级执行**（由
  `recall-experience-contract:v1` 的 Questions 条款承担）：1A.3a 没有
  deflection-suppression 投影，确定性双形式抑制要等 1A.3b（ADR-0113 / 
  ADR-0117 已记录）。因此 v3 的 fixture 用 `fencedMentions`（post-Correction /
  post-Forget 的确定性围栏）承担跨日非复用的硬门禁，而 stop-signal 与召回的
  交互仍由人评与 judge 预筛覆盖。
- 记忆追问以问句出现时占用每轮单问题名额（`too_many_questions` 硬门禁不变，
  v2 门禁照常计数）；陈述式回带不占用。此边界不改变任何计数器实现。

## 边界

- 场景素材全部虚构（v2 syntheticNotice 延续 + #118 新增同样虚构）。
- 检查器不写产品状态，不修改生产 validator；`packages/application/src/conversation-behavior.ts`
  与 Context Compiler 的现行行为不受本目录影响。
- LLM judge 结构预筛与校准是后续独立任务（rubric §5、§9）；语义级漏召回的
  终审在 #126 记忆盲评样本内进行。

## References

- 规则：[行为契约与评测 rubric](../../docs/evaluation/01-behavior-contract-and-rubric.md) ·
  [ADR-0009](../../docs/adr/0009-objective-memory-and-ai-impression-use-distinct-recall-language.md) ·
  [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md) ·
  [ADR-0116](../../docs/adr/0116-ai-impressions-use-natural-relational-recall.md) ·
  [ADR-0117](../../docs/adr/0117-narrow-opener-permission-precedes-open-loop-selector.md)
- 前代：[`eval/scenario-pack-v2/`](../scenario-pack-v2/)（v2.1，#77）·
  [#94 盲评证据](../recall-presentation-94/)
- Map: [#58](https://github.com/lukemyself-hub/SayHear/issues/58) ·
  SPEC: [#107](https://github.com/lukemyself-hub/SayHear/issues/107) ·
  Task: [#118](https://github.com/lukemyself-hub/SayHear/issues/118)
