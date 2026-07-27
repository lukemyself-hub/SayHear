# 示例 Working Spec：Journal Eligibility Evaluator

## TL;DR

- 这是 working spec 格式示例，不代表已批准或已排期的开发任务。
- 示例目标是把 Journal Eligibility 的确定性输入、输出和验收边界落实到一个小任务。
- 执行者先读取本文件链接的当前文档和 ADR，再按 Journal Eligibility、Session、
  Evidence 与 Workflow 等受影响概念检索决策索引并读取所有命中的 ADR；无需无目标地
  加载完整产品或架构背景。

## Status

Draft

## Goal

实现一个无副作用的 Journal Eligibility evaluator：根据指定 Daily Session revision 的
有效 User Evidence，返回 `eligible`、`insufficient_evidence` 或 `no_activity`，供后续
Journal Workflow 使用。

## In scope

- 区分当天完全无交流与发生过交流但 Evidence 不足。
- 只判断是否能支撑至少一条真实记录，不判断内容是否重要、深刻或有情绪价值。
- 输出可测试的 reason code，不生成 Journal 文本。
- 固定读取指定 revision，避免并发新 turn 改变本次结果。

## Out of scope

- Journal 文案生成、验证或发布。
- UI 与 No Journal Notice 文案。
- 模型选择、Prompt 调优或 Replay。
- 修改 Journal Eligibility 的产品定义。

## Acceptance criteria

1. 无有效 User Event 时返回 `no_activity`。
2. 有 User Event 但无法支撑真实记录时返回 `insufficient_evidence`。
3. 日常琐事只要证据充分即可返回 `eligible`。
4. Assistant Event、推断出的重要性或情绪强度不能单独使结果变为 `eligible`。
5. 相同 source revision 重复评估得到相同结果。
6. 单元测试覆盖三种结果和新 turn 并发边界。

## Required context

- [Session 与 Journal 产品规则](../product/12-13-session-and-journal.md)
- [Journal、Reflection 与 Memory 工作流](../architecture/11-12-journal-memory-workflows.md)
- [ADR 0011](../adr/0011-journal-eligibility-does-not-judge-importance.md)

以上链接是最低起点。实施前仍须检索[决策索引](../decisions.md)，确认没有遗漏与任务
涉及领域相关的 ADR。

不要读取 `archive/` 或完整产品、架构快照，除非上述当前文档出现无法解释的冲突。

## Open questions

- evaluator 是否完全由确定性规则完成，还是允许模型提出候选后由确定性门槛验证。
- 初始 `insufficient_evidence` 的最小 Evidence 结构。

## References

- [文档地图](../README.md)
- [测试、交付顺序与升级门槛](../architecture/24-29-testing-and-delivery.md)
