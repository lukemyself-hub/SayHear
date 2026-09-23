---
status: accepted
date: 2026-08-23
---

# Low-Fatigue Pairwise Evaluation Uses Stratified Sampling

后续 Internal Core 的行为盲评默认使用 `blind-pairwise:v2`：从两边都有完整可比回合
的候选场景中，以可复现的种子分层随机抽取 15 个场景，配额为 8 个英文、5 个中文、
2 个 code-switch。抽样同时强制覆盖 `high_risk`、`refusal`、`short_answers`、
`topic_change`、`direct_task` 各至少一个场景；这不是无约束随机，而是避免小样本
恰好漏掉关键安全、停止信号和能力诚实证据。

人工记录从每边六个 1–5 分改为每个可比回合一次 `A 更好 / 持平 / B 更好`，并在读完
场景后记录一次整体判断。结果汇总以场景整体判断为主，回合判断只用于定位差异；
六个味觉维度保留为争议场景的定向诊断工具。`blind-pairwise:v1` 与历史产物继续
可读、可复算，不被迁移覆盖。

## Why

上一轮 30 个场景、75 个回合的两边六维评分给唯一评审造成接近两小时的负担。重复
打分会引入后期麻木和假精度：评审者被迫区分自己未必能稳定区分的 1–5 细微差异，
而真正需要的判断通常只是“哪边更像应保留的回应”。三选一保留方向、持平和逐回合
定位信息，同时显著减少动作数量。

## Consequences

- 15 个场景与 15 个整体判断是人工偏好的筛查证据，不是全量质量证明；全量运行仍
  必须通过确定性契约硬门禁。
- v2 的总体门槛是场景整体判断中 candidate 净偏好严格为正；每个语言变体的净偏好
  不得为负；抽中的受保护类别不得出现净回退。持平不强行计入任一方。
- 若某次结果出现明显分歧，只对相关场景做六维诊断或换一个抽样种子复评，不默认
  把所有场景重新扩成 1–5 评分。
- 这只改变评测记录方式，不改变 ADR-0061 的开发者判断框架，也不把人工偏好变成
  运行时自动 Gate；ADR-0110 关于人工味觉最终权威的结论继续有效。

## Memory-specific extension

Core Flow 1A.3a 使用独立的 15 场景 Memory 分层样本，不依赖整体行为样本碰巧抽中
Memory turn。它沿用 `blind-pairwise:v2` 的 8 English / 5 中文 / 2 code-switch 配额、
A / 持平 / B 记录方式与相同通过门槛，并强制覆盖 Objective Memory、Person Portrait /
AI Impression、人物关系与时间变化、Correction / Forget 后旧内容不再使用，以及三种
语言形态。一个场景可以覆盖多个类别，不能为了凑配额增加人工评分动作。

Memory-on 的场景整体净偏好必须严格为正，每个语言变体不得净回退，抽中的上述 Memory
类别不得出现净回退。错误 Entity、Correction / Forget fence 越界和无 Evidence 人格
判断不交给偏好抵消，仍由全量确定性契约作为零容忍发布门禁。

## Amendment (2026-09-18, Luke-approved)

G2 continuation 盲评存在结构性限制：两臂共享逐字节相同的冻结主回应，人工可判的
可见差异只来自 candidate 侧新增的 proactive 片段。因此人工盲评名额改按
Review-Worthy Scene 资格筛选：两侧在 Backend-Decision Product 上确有差异、被评判
的质量必须由人而不是机械检查判定、且该产物在可比回合或 Context Panel 中可见。

- 15 例 / 8 English / 5 中文 / 2 code-switch 的样本配额与通过门槛（场景整体净偏好
  严格为正、语言变体不得净回退、抽中受保护类别不得净回退、持平不计入任一方）不变。
- `high_risk` 不再强制进入人工样本：正确行为在两臂都是沉默、且主回应冻结，A/B 结构
  上必然持平；它继续由全量确定性硬门禁覆盖。`refusal`、`short_answers`、
  `topic_change`、`direct_task` 继续强制覆盖，其中 `direct_task` 可由带真实片段的
  memory / competing 场景承载。
- Contract-Only Scene（correct-zero 对照、抑制持续、冷却释放）不再占用人工名额，
  继续留在全量确定性硬门禁中。
- 允许在评审界面展示中性、无臂别的 Context Panel（该 scene 开始时共享的前置知识：
  可用 Memory Claim、Open Loop 及其既有使用 / 抑制状态），使片段产物可被判读；
  判定记录方式（每可比回合与场景整体 A / 持平 / B）不变。
- 2026-09-20 起，日期约束场景同时展示两侧共享的冻结当前日期和距上一回合天数；
  Memory 文本必须明确主体是用户还是其他人。时间与主体信息只解释共享上下文，
  不得暴露目标选择、预期处理或臂别。
- 若场景整体判断中持平超过 1/3，视为场景不合格信号，先重设计场景再交付，不扩大
  样本硬凑；该阈值是重设计触发器，不是通过门槛。

## Amendment (2026-09-23, Luke-approved G2 v4 dual-track review)

G2 v4 uses two independent human-review tracks. Emit pairwise evidence contains exactly
15 scenes with actual committed ON-only segments, allocated 8 English / 5 Chinese /
2 code-switch. Every sampled scene must have a visible Backend-Decision Product
difference. Shared history appears once; only differing turns are paired. The reviewer
records A / tie / B for each differing turn and once for the complete scene. The
candidate passes only with strictly positive scene-level net preference, no negative
net preference by locale or protected category, and no more than 5 scene-level ties.
Sampling retains the existing reproducible seed, family minimums, protected coverage,
topic cap, and 7/8 or 8/7 arm balance. Insufficient actual emits fail the package build;
omissions and identical outcomes never fill pairwise slots.

A separate omission audit contains 8 predeclared, actual typed omissions across all
four omission reasons, Memory / Open Loop, and English / Chinese / code-switch. Its
public review contains neutral context and target grounding, without internal reason,
fixture expectation, arm identity, or lane diagnostics. Decisions are `沉默合适`,
`本应跟进`, and `无法判断`; it passes only with zero `本应跟进` and zero
`无法判断`. `correct_zero` remains a deterministic contract gate and is not an omission
case because it has no selected target or expression-provider call.

The 2026-09-20 run-v3 package is a preflight failure, not final review evidence: only
4 of 34 expression decisions emitted, and 11 of its 15 pairwise scenes had identical
arms. The v4 protocol uses new schemas, pins, fixtures, seeds, and evidence paths while
preserving run-v2 and run-v3 artifacts byte-for-byte. Review package, score, and
unblinding protocols are versioned `1a3b-g2-review-package:v4`,
`1a3b-g2-scores:v4`, and `blind-pairwise:g2-v4`.
