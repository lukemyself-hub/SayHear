---
status: accepted
date: 2026-07-27
---

# One Conversation Action Represents One Semantic Intent

一次模型提出的 `Conversation Action` 对应用户在一个 User Event 中表达的一个完整
语义意图，不对应一条数据库写入、一个领域对象或一条 Workflow step。模型每轮最多
从当前 `Conversation Action Catalog` 提出一个 typed Action；SayHear 自有应用代码
负责验证 target、scope、权限、Evidence 和幂等性，并返回真实结果。

一个已接受的 Correction Action 可以在主事务中立即停止错误 Claim、Qualifier 与
projection 的使用，并确定性地产生多个下游影响，例如创建多个 ClaimVersion、定向
触发多篇 Journal Correction、失效并重建 Profile。模型不能把这些影响拆成自主工具链，
也不能在异步修复完成前声称全部结果已经完成；最终 Assistant Response 只能依据已经
提交的 Action receipt 描述已生效与仍在处理的部分。
