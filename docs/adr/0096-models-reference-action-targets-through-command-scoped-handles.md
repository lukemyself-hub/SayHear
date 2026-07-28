---
status: accepted
date: 2026-07-27
---

# Models Reference Action Targets Through Command-Scoped Handles

Conversation Function 需要引用已有 Entity、Claim、JournalStatement 或其他 Action
target 时，模型只能选择当前 Conversation Decision Command 的 CompiledContext 中提供的
`Action Reference Handle`。模型不能提交真实数据库 ID、user ID、自由文本数据库
selector、相似度查询或自己猜测的 UUID。

Context Compiler 为每个 eligible target 生成 opaque、Command-scoped Handle，并通过
typed link 保存其 owner、target kind、稳定对象 ID、具体 Version、source revision
与允许使用它的 Action kinds。Handle 不是长期产品身份或授权；它不能跨
CompiledContext、Command、Turn 或用户复用，也不能绕过 Action Gateway 的当前 Version、
scope、permission、Evidence、`data_epoch` 与 deletion fence 检查。

当前 User Event 中首次出现、尚无稳定对象身份的新信息，Function 通过 typed
`Current Event Locator` 引用 final / corrected Event revision 的 whole revision、
segment 或 text span。Action Gateway 可以据此执行正常 Entity / Evidence admission；
它不能把 locator 中的自由文本直接当作已有对象 ID。目标不在冻结 manifest、Handle
失效、Version 已变化、owner 不符或同名身份仍有实质歧义时，返回
`clarification_required` 或 fail closed，不能近似修改。

CompiledContext 保存 Handle manifest 与 typed target links，以便 Replay 重建当时模型
可见的选择；Provider payload 只包含 opaque Handle 和必要显示信息，不暴露内部 ID。
这样模型负责语义选择，SayHear 仍确定性控制真实对象解析，并防止跨用户 ID 注入、
陈旧 Context 写入和同名人物误改。
