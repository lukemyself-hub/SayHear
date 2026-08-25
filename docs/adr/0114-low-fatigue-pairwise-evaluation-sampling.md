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
