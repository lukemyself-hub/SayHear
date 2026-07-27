---
status: accepted
date: 2026-07-26
---

# Product-Value Rejection Is a Proposal Version

人工认为一个通用 Predicate 概念没有产品价值时，Candidate Review Module 仍使用
现有 `reject` interface 写入 terminal Candidate disposition，同时委托 Predicate
Registry Governance Module 创建或关联 `status=rejected` 的 Predicate Change
ProposalVersion。Evidence 不足、Entity / scope 未解、敏感推断违规等
candidate-specific rejection 不创建 Proposal。

Rejected Proposal 只保存通用概念定义、schema 草案、合成正反例和治理理由，不得
保存 subject `user_id`、Evidence、具体 value、用户原话、Entity、时间地点或其他
可识别私人信息；reviewer principal 只作产品治理审计。Candidate 继续按七天规则
清除，Full Purge 删除 Proposal–Candidate link；通过无用户内容约束的 Proposal
identity 与版本历史可以作为产品治理记录保留。

后续跨语言或改写后的同一概念可以映射到 Proposal identity；current version 为
`rejected` 时不能进入 review queue、Registry mapping、Memory admission 或 Claim
promotion。只有授权人工显式重新考虑时才创建 superseding ProposalVersion，旧
rejection 保持不可变。
