---
status: accepted
date: 2026-08-13
---

# Journal Regeneration Accepts Bounded User Guidance

`Journal Regeneration` 需要回应用户对表达质量的具体反馈，但不能因此变成用户直接
编辑 Journal、修改 Evidence 或重新定义 SayHear 对当天事实的理解。本决定补充
ADR-0097：用户可以随 regeneration request 提供自然语言 guidance，前提是它只影响
派生产物的表达，不改变其 source、事实 / 推断边界或第三人称观察规则。

## Decisions

- `regenerate_journal` 的 target 是同一 logical Journal 的 current Version。Action
  Reference Handle 按 `exact_head` 校验；如果 current Version 已前进，Gateway 不自动
  改绑，返回 `clarification_required` 并不产生领域变化。删除、source invalidation、
  `data_epoch` 或权限 / deletion fence 失败返回 `rejected`。
- Action 的幂等边界绑定原始 User Event / Decision Command、Action kind 和 target
  Handle。网络重试、Provider 重复投递和恢复复用同一 `ActionExecution` 与 Receipt；
  用户在新的 User Event 中再次请求才创建新的 Action，并重新接受 rate policy 检查。
- 同一个 logical Journal 同时最多一个 `pending` 或 `running` regeneration。已有执行
  未进入 terminal state 时，新的请求以 `rejected` 搭配 rate-limit disposition 结束，
  不排队、不创建第二个 Journal command，也不允许两个 Version 竞争 current。
- Action 可以携带自然语言 `Regeneration Guidance`。它可以要求改善重点、清晰度、
  组织方式或在既定观察规则内的表达，但不能增加、删除或改写事实，改变 Evidence、
  要求用户第一人称、指定最终正文、生成多个候选，或绕过第三人称与不确定性验证。
  Guidance 不是 Evidence，也不能成为 JournalStatement 的事实来源。
- Admission 后，供异步 Journal GenerationCommand 使用的 guidance 作为短期加密输入
  保存；Action 的长期 envelope、Receipt、日志、Trace 和 Workflow history 不复制用户
  原话。GenerationCommand 完成、失败或超出 retention 后，guidance 必须清除。
- 明确的事实纠正不作为 regeneration guidance 执行。请求无法区分表达反馈与事实纠正
  时只自然澄清一次；当前没有可用 Journal Correction Action 时，不声称已完成纠正并
  返回 `unsupported`。
- Accepted 只表示 Admission 已提交且 execution 可以处于 `pending`；最终用户回复
  可以说明已接受或正在处理，但只有成功的 Journal completion receipt 才能声称新的
  Journal Version 已生成并成为 current。

## Consequences

- `Conversation Action Proposal` 的 input Schema 需要同时表达 command-scoped current
  Journal Handle 与受限 guidance，但 Provider / Framework 类型不能越过 application seam。
- Journal GenerationCommand 必须冻结 guidance、source、generation / validation
  contract、rate policy 与 freshness，而不能在 Workflow 中重新读取已清除的 Action
  payload。
- Guidance 提高 regeneration 对用户反馈的响应能力，但扩大了需要测试的 selection、
  validation 和 bilingual / code-switched fixture 范围；所有新 Version 仍服从既有
  Journal validator 和 atomic publication fence。
- 该决定不开放自由 Journal 编辑，也不改变 Journal Correction、Evidence lineage、
  versioned artifact 或 automatic publication 的既有边界。

## Relationship to ADR-0097

ADR-0097 继续定义 regeneration 与 Understanding Correction 的语义区别、同一 logical
artifact identity、当前 source、policy、validation 和 publication 规则。本 ADR 只将
“用户只能表达不满意”细化为：用户可以提供受限 guidance，但 guidance 不能改变那些
既有不变量。
