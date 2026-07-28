# SayHear 专门 SPEC

## TL;DR

- 通过 matt skills 生成的完整 SPEC 发布到 GitHub Issue；Issue 正文、评论和标签是
  SPEC 的唯一执行真源。
- 本目录只维护轻量索引和使用规则，不复制 GitHub Issue 的完整 SPEC 正文。
- 当前拆分后的 `docs/architecture/` 文件不是 SPEC，不应移动或复制到本目录。
- 当前产品行为读取 `docs/product/`，技术契约读取 `docs/architecture/`。
- 创建 SPEC 前先按功能涉及的领域检索并读取相关 ADR；SPEC 必须链接全部命中且适用的
  ADR，而不是只依赖已有任务链接。
- SPEC 只链接相关产品规则、架构主题和 ADR，不重复整份产品或架构背景。

## Status

Accepted

## Current specs

- [#1 — Internal Core / Core Flow 1A.1 — Text Foundation](https://github.com/lukemyself-hub/SayHear/issues/1)
  — Core Flow 1A.1（Internal Core）— `ready-for-agent`

创建 SPEC 后，在这里增加一条简短索引，包含：

- GitHub Issue 编号、标题和链接；
- 所属阶段或 Core Flow；
- 当前 Issue 状态。

索引只帮助发现 SPEC。范围、acceptance criteria、讨论结论和执行状态只在对应
GitHub Issue 中维护；不要在本目录创建第二份正文。

## Publishing workflow

1. `/to-spec` 基于当前对话、代码库、相关产品规则、架构契约和 ADR 生成 SPEC；
2. 测试 seam 经确认后，把完整 SPEC 创建为 GitHub Issue；
3. 为 Issue 添加 `ready-for-agent` 标签，不再经过 `/triage`；
4. 在本文件的 Current specs 中增加一条链接索引；
5. `/to-tickets` 从该 Issue 拆分实现 ticket，并让每张 ticket 链接回源 SPEC。

SPEC 内容变化时直接更新 GitHub Issue。若变化同时改变产品规则、领域词汇、架构不变量
或重要决定，必须分别更新对应的 `product/`、`CONTEXT.md`、`architecture/` 或 ADR；
不能只修改 Issue 来静默覆盖这些权威来源。

## SPEC requirements

GitHub Issue 中的完整 SPEC 应至少包含：

- `TL;DR` 与状态；
- 用户问题、范围与明确的 out of scope；
- 可验证的 acceptance criteria；
- 记录 ADR 检索所用的领域关键词，并链接全部命中且适用的 ADR；
- 尚未决定的 open questions；
- 不把架构建议误写成已确认产品需求。

## Open questions

无。具体 SPEC 在对应功能进入 pre-SPEC / implementation 流程时创建。

## References

- [文档地图](../README.md)
- [GitHub Issue 操作规则](../agents/issue-tracker.md)
- [Issue 标签映射](../agents/triage-labels.md)
- [产品文档](../product/01-04-overview.md)
- [架构概览](../architecture/01-06-overview.md)
- [ADR 索引](../decisions.md)
