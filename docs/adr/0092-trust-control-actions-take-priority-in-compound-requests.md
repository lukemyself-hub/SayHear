---
status: accepted
date: 2026-07-27
---

# Trust-Control Actions Take Priority in Compound Requests

同一个 User Event 包含多个可以独立接受、拒绝或执行的请求时，SayHear 默认不静默
部分执行。若其中恰好有一个明确、目标唯一的 Trust-Control Action，并且该 Action
自身的 scope、授权与安全门槛已经满足，Conversation Model 将它作为本轮唯一的 typed
Action proposal；应用代码立即执行或 fail closed，再由最终回复分别说明已生效的
信任控制和其余未执行、需澄清或不支持的请求。

Memory Correction、Memory Forget Request 与 Memory Forget Reversal 属于当前
Trust-Control Action。需要二次确认、step-up authentication 或不可逆高风险授权的
Account Deletion 等能力不进入当前 Conversation Action Catalog，而是使用独立产品
入口；Trust-Control 优先级不能把这些能力变成模型可执行 Action，也不授权模型执行
第二个 Action。

没有上述唯一 Trust-Control Action 时，SayHear 不对复合请求自行挑选或静默执行：
一个受支持、一个不支持时先不改变产品状态，明确能力边界并询问用户是否只执行受支持
部分；多个彼此独立且受支持的 Action 则询问先处理哪一个。用户的选择形成新的 User
Event。一个 Action 为维护 Memory、Journal 与 Profile 一致性而确定性产生的多对象
变化不属于复合请求，也不受这条单 Action 排队规则限制。
