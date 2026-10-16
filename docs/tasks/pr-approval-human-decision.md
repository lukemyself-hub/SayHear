# PR 自动审批 SPEC 交接索引

状态：已发布。Luke 于 2026-10-15 确认完整讨论与测试入口，并授权执行 to-spec。

正式规格为 [SPEC #362：Internal Core 工程交付 — 自动审批、人工最终决定与有界 Agent 修复](https://github.com/lukemyself-hub/SayHear/issues/362)。
GitHub Issue 正文、评论和标签是唯一执行真源，本文不再保留 SPEC 正文。

- 所属范围：Internal Core 工程交付工具链，不新增产品 Core Flow。
- 发布时标签：`ready-for-agent`。当前状态以 GitHub 回读为准。
- 发现入口：[SPEC 索引](../specs/README.md)。
- 决策原因：[ADR-0154](../adr/0154-human-review-is-a-complete-pr-approval-path.md)。
- 本轮只发布 SPEC 并维护本地文档，未启动实施、安装控制器或修改实际小时级任务。

接续时读取 Issue 全文及评论，并核对最新 main、安装来源、保护规则、既有改动和当前 worker 配置。
