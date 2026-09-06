---
status: accepted
date: 2026-07-27
---

# Derived Artifact Regeneration Is a Policy-Governed Action

用户可以请求 SayHear 使用当前有效 source 与现行生成 policy，重新生成支持该能力的
Derived Artifact。`Derived Artifact Regeneration Action` 与 Understanding Correction
是不同语义：Correction 表示 SayHear 的底层理解或归属错误，并触发跨对象一致性修复；
Regeneration 接受当前权威 source，只要求重新形成派生产物的表达或组织。

每个支持 regeneration 的 Catalog entry 必须声明 target artifact kind、source snapshot
policy、generation / validation contract、rate policy、publish semantics、幂等 scope
与 executor。执行保留 logical artifact identity，创建新的不可变 Version；只有通过
既有 validator 与 fenced commit 的结果可以替换 current Version。用户请求进入同一
Conversation Action / receipt 协议，模型不能直接获得底层 generation、publish 或
Version mutation 工具。

首个对话内用例是 `regenerate_journal`：用户对某一天 current Journal 的表达质量不满
时，可以通过 Journal Action Reference Handle 请求重生成。它读取该 Journal 当前仍
有效的 Conversation / Evidence source，继续服从第三人称观察、事实与推断边界，不
接受任意文风、第一人称、指定正文或删除有 Evidence 支撑的事件。意图只表达“不满意”
且无法区分事实理解错误与表达质量时，先自然澄清一次。

Bio manual refresh 服从相同架构语义，但有自己的 source、schedule 与 rate policy。
Profile 页面按钮与对话中的 `regenerate_bio` Action 进入同一个 owner-scoped handler，
使用同一 source snapshot、24 小时 rate policy、幂等边界、validator 与 publish
语义；Conversation Context 只暴露高层 Action，不注入 Bio 或 Bio Basis。未来其他
Derived Artifact 只有显式加入版本化 Catalog 并实现对应 handler 后
才获得 regeneration 能力；不能因为属于派生产物就自动开放。

本 ADR 只取代 ADR-0003 对所有用户请求 regeneration 的绝对禁止。Journal 不可自由
编辑、不可连续候选抽取、Correction 创建 superseding Version，以及 Journal 仍是
SayHear 第三人称观察的结论继续成立。
