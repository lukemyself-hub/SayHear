---
status: accepted
date: 2026-08-26
---

# Trust Action targets outside frozen context resolve deterministically at admission

用户提出 Memory Correction、Memory Forget Request、Memory Forget Reversal 或 Memory
Source Explanation 时，目标 Memory Claim 或 Relationship Qualifier 不一定出现在本轮
冻结 Context 中：Portrait 与检索命中只覆盖被注入的少数条目，被 Forget 的内容更是从不
进入召回。若坚持模型只能引用本轮 Handle（ADR-0096），多数真实纠错将无法受理；而把
纠正延迟到后台抽取收敛，又违反"被纠正的 Claim 必须立即停止召回"的产品法
（`product/14` §14.3）。

因此 Trust-Control Action 在 Admission 阶段增加一步确定性的 owner-scoped
structured-lexical 目标解析：

- 模型侧契约不变（ADR-0096）：模型只提交 Action Reference Handle、Current Event
  Locator 或引用用户原话的锚点 span；锚点只是解析线索，不是自由文本数据库 selector。
- 解析只做有界词面检索，不使用语义相似度自动改写或近似挑选目标；
- 只有唯一高置信命中才受理；多命中返回 `clarification_required` 且只说明存在几条
  疑似，不列内容也不代选；零命中诚实告知未找到对应记忆，本轮零领域变化。
- 各 Action 的搜索空间不同：Correction / Forget Request / Source Explanation 查活跃
  Claims，Reversal 只查处于 Forget fence 内的目标。
- 解析命中的真实对象以 typed reference 进入 Receipt / Execution 记录，可审计。
- 非信任类 Action（如 `regenerate_journal`）不受影响，仍要求本轮冻结 Context 提供
  的 Handle。

此机制换取即时纠错与显式控制权在常态对话中成立。代价是承认残余缺口：解析失败时
SayHear 只能继续普通对话并由异步冲突路径慢慢消解；这一缺口如实呈现给用户，不用
近似执行掩盖。
