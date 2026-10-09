---
status: accepted
date: 2026-10-07
---

# 近期对话背景使用有界来源历史，不依赖长期记忆准入

Luke 在 [#287](https://github.com/lukemyself-hub/SayHear/issues/287) 确认：第一阶段需要
接上最近 7 个本地日的普通经历，即使这些经历没有形成长期 Claim。只依赖关键词
检索与 Person Portrait 会漏掉普通经历；把它们强行写为 Claim 又会绕过长期准入与
Predicate Registry 治理。因此由现有 Context Compiler 每轮编译有界的近期原文背景，
不要求日期信号，不依赖 Claim、Episode 或 Reflection 成功，不新增模型摘要前置步骤。
PostgreSQL 领域真源、Daily Session / Journal 归属和 G1-only 边界继续成立。

窗口包含今天和此前 6 天，空日不向前补足。当前输入与今天的对话优先，历史预算
尽量覆盖多个日期，再向更近日期分配剩余额度。相较于全部按新旧顺序填满预算，
这个选择牺牲部分近期细节，换取多日覆盖；不承诺完整覆盖，具体数值待实现方案确定。
有效用户原文是事实来源，必要的相邻 Assistant 对话只解释问答关系。

第一阶段不扩展 Memory Forget 的目标范围，也不新增普通经历的来源级排除入口。
既有 Correction / Forget 通过明确关联定位到旧消息时，整条排除，复用控制记录与
Evidence 来源关系；不做片段切割、语义匹配或新抑制体系。这个选择接受漏带无关
内容及无法关联的旧表达仍可能出现的限制，以控制边界场景的工程成本。源 Conversation
和已有 Journal 保留，普通重提不解除 Forget，也不授权旧 Evidence 复活。

背景不足时使用“我不记得了”“没什么印象”等日常表达，不暴露读取或预算机制。
这只表达当前记忆不足，不能被解释为历史不存在，也不允许编造事实或来源。
表达时间与经历时间分开，实质歧义才澄清，不让旧说法压过当前表达。

本决定补充 ADR-0111 的跨日输入合同，修订 ADR-0117 中“无信号可以没有近期背景”
的边界；长期 Claim 的词面检索仍可返回零条，自动带入背景不等于必须主动提旧事。
不恢复 ADR-0141 已退役的 G2 路径，也不修改 ADR-0118 的 Trust Action 目标范围。
产品规则见 [§15.3.1](../product/15-conversation-behavior.md#1531-近期对话背景)，
技术边界见 [§9.1.1](../architecture/08-10-conversation-runtime.md#911-近期对话背景)。

这是已确认的设计合同，不是实现、测试、发布或框架迁移证据。具体读取上限、预算、
日期解析、冻结与出站检查、验证和发布方案继续在 [#286](https://github.com/lukemyself-hub/SayHear/issues/286)
的后续决策中形成，不在本次文档交付中实施。
