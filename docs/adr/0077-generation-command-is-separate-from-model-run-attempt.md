---
status: accepted
date: 2026-07-26
---

# Generation Command Is Separate from Model Run Attempt

`GenerationCommand` 表达一次逻辑生成意图并冻结 subject、source revision、Prompt、
Schema、policy、routing 与 freshness；`ModelRunAttempt` 表达该 command 的一次具体
Provider 调用及其运行结果。一次 command 可以因安全技术重试或已批准 fallback 拥有
多个串行 attempt，但只有一个 authoritative result。

分离两者可以在不重复用户意图或产品写入的前提下记录 Provider 故障、成本、模型版本
与重试。attempt 不能投票、合并结果或改变 command 已冻结的业务语义；提交结果仍需
通过相同 validator、freshness、deletion fence 与幂等约束。

## 修订（2026-10，issue #319，ADR-0152）：结算与用量

- 一个 attempt 的用量按 Provider 实际报告入账：完成时随完成记录；未完成（超时、中断、被围栏拒绝、被取消）
  时由 Provider Egress 在调用结束时补记已报告的部分，因为 Provider 已计费。未报告的计数保持 NULL。
- Provider 成功而 Assistant Event 提交失败时，attempt 记为 `result_unknown`、command 为 `interrupted`，
  用量保留，且不补写正文；同一 `client_event_id` 的重发解析到原 Turn，不产生第二个成功 Assistant Event。
- 带 `request_deadline_at` 的 command 不再依赖 300 秒恢复窗口才能离开 running：截止后下一次扫描即终止。
