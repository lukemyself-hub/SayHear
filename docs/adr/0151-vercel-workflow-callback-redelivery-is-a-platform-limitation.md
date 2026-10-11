---
status: accepted
date: 2026-10-10
---

# Vercel Workflow callback 重投是已接受的平台限制

Luke 在 [#238](https://github.com/lukemyself-hub/SayHear/issues/238) 确认：当前
Vercel Workflow 平台在 at-least-once 投递下会对同一 message 重复触发队列 callback，
其编译后的 runtime（`.next/server/chunks/...`）在自动 ack 时抛出
`MessageNotFoundError` / `MessageNotAvailableError` 并返回 HTTP 500。这是平台行为，
不是 SayHear 应用层可因果修复的缺口。应用层不拦截、不静默该错误，也不引入无界重试；
等待 Vercel 上游修复，并在此记为已接受的平台限制。

## 观察与证据

历史生产部署（`dpl_9ciJDXBXW5ppk5qWhEvfSZ2sun7c`，构建自 `ca34d18`）在
`POST /.well-known/workflow/v1/flow` 上对同一 message 重复记录：

```text
Queue callback error: Error [MessageNotFoundError]: Message 38-... not found
[workflow] ... MessageNotAvailableError ... Message is not currently in-flight
```

错误栈落在编译后的 Workflow runtime，仓库中没有对应的应用代码或可插拔的 callback
处理 seam。当前重新部署的生产在事后检查中未复现。上游有同类报告：
[`vercel/vercel#17184`](https://github.com/vercel/vercel/issues/17184)（handleCallback
自动 ack 遇到 at-least-once 重投时抛 `MessageNotFoundError`，消息其实已处理成功）；
[`vercel/workflow#4269`](https://github.com/vercel/workflow/issues/4269)
（重复投递使 `/.well-known/workflow/v1/flow` 返回 500）。

## 决定

- 应用层不拦截、不吞掉、不重写这个 callback 错误；不通过放宽错误分类把 500 伪装成
  成功。
- 不为规避它引入无界等待、request-path 重试或第二套消息 ack 机制。
- 不因该观察升级或重钉 `workflow` 依赖，也不因此回滚或改动 G1 active pins。
- 等 Vercel 修复后，按正常依赖升级流程重新验证该日志是否消失。

## 边界

重投只影响平台已处理 message 的 callback ack，不改变 SayHear 的业务可靠性契约：
outbox dispatch、`workflow_commands` 稳定 intent key、Receipt 幂等和 transactional
outbox 继续保证有效 Workflow 工作既不丢失也不重复
（[§13.2 业务幂等](../architecture/13-durable-workflows.md#132-业务幂等) 与
[§13.3 Transactional Outbox](../architecture/13-durable-workflows.md#133-transactional-outbox)）。
平台选择本身仍由 [ADR-0066](0066-vercel-workflows-v4-runs-durable-asynchronous-work.md)
承载。因此本决定接受“重复 callback 产生噪声 500 日志”的限制；截至本记录，没有证据
表明有效工作丢失或重复。若日后出现有效工作丢失、重复副作用或 outbox 与 Workflow
无法收敛的证据，则不再适用本平台限制，按正确性问题处理，并在
[ADR-0141](0141-g1-only-release-after-g2-retirement.md) 的 G1-only 发布范围内评估修复
或回滚。

## 检索 deadline 未变更

本条同时记录 [#238](https://github.com/lukemyself-hub/SayHear/issues/238) 的另一项
确认：版本化 200ms 共享 retrieval deadline 维持不变。检索继续按整轮 Memory fail
closed，并在 `retrieval_runs` 记录 `deadline_ms`、`duration_ms`、`status`、
`degraded_reason_codes`、`deadline_exceeded_stage` 与 `timings`；本决定不修改该数值、
字段或 fail-closed 语义。核对结果为已实现，无文档-代码冲突，也没有为此修改任何检索
代码。latency 与 timeout rate 仍作为 accounting signal
（[ADR-0134](0134-1a3b-rollout-is-staged-and-correctness-triggered.md) 的该表述继续
适用；其发布阶段范围已由 [ADR-0141](0141-g1-only-release-after-g2-retirement.md)
收窄为 G1）。

这是已确认的平台限制记录，不是上游修复、代码变更或部署证据。
