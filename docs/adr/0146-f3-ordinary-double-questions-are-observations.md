---
status: accepted
date: 2026-10-01
amends: [0143]
---

# F3 普通回复双问句只记录观察

产品文档 15.2 与 #228 允许普通回复偶尔出现第二个问题。F3 的独立 fixture
问句预算仍按一个问题拦截，ADR-0143 也保留了这项发布门禁。冻结代码 5fe79e3
的真实 Continuation 捕获中，一条普通回复因此失败；原文和失败报告保留。

Luke 确认：“同意，普通双问句只记录观察”。本决定据此修改 F3 的发布规则：

- 普通回复的 fixture 预算为 1，且实际恰有 2 个问句时，记录
  `ordinary_double_question` 观察项，不阻断 AC-X04。
- fixture 明确禁止问题时，任何问句仍阻断。高风险或持续中的安全姿态
  不适用双问句例外。三个及以上问题仍按原问句预算阻断。
- 停止信号、隐私、号码来源、标点、高风险转介及其他发布门禁保持原要求。

观察项随完整池报告保存；不删原始回复、不修改历史失败记录。新发布证据由
检查器实际生成。频繁堆叠问题仍需通过真实使用观察处理，本次不新增频率阈值。

相关来源：[产品对话规则](../product/15-conversation-behavior.md)、
[#228](https://github.com/lukemyself-hub/SayHear/issues/228)、
[ADR-0143](0143-g1-ships-without-semantic-reflection-validation.md)。
