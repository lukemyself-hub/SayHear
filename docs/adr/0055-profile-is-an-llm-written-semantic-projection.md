---
status: accepted
date: 2026-07-26
---

# Bio Is an LLM-Written Semantic Projection

Bio 是 SayHear 对用户及其相关经历、关系与记忆的自然语言讲述，不是全部
Memory Claim 的数据条目列表。全部当前有效、active、未被 Forget 且 EntityVersion
仍有效的 User Profile ClaimVersion 都进入 LLM 的 eligible input，包括敏感 Claim；
已经获得 Memory 准入的内容不再要求独立的 Bio inclusion 授权。

“忠实映射全部 Memory”是语义完整，不是逐条复述。LLM 使用版本化 Bio Prompt
压缩、连接并组织用户的经历、关系、情感、价值观和世界观，但不能与 active Memory
实质矛盾或遗漏到形成失真人物画像。每个事实判断必须由 active Objective Memory
支撑，每个可独立成立的心理、情感或价值观判断必须由 active AI Impression 支撑，
并用不同措辞保留 confirmed 与 inferred 的认识状态。

每个 BioVersion 记录完整 eligible input、实际 narrative support、
Prompt、model attempt 与 selection policy。Candidate、`contested`、`review_due`、
`dormant`、被 Forget 的内容、Open Loop 和 Reflection 原文不能进入 Bio；
Bio LLM 不能创造只存在于 Bio 的新推断、改变 Claim 认识状态，或让 Bio
成为新的 Memory Evidence。这样既允许敏感 Claim 支撑“被看见”和“被关心”的深层
叙事，也不让 Bio 绕过长期 Memory 的准入、Correction、Forget 与 dormancy。
