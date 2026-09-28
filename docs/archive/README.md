# 历史文档与原始快照

## TL;DR

- 本目录保存重组前的完整原文和已被当前文档取代的研究材料。
- 这些文件是不可变追溯材料，不是当前产品、SPEC 或架构真源。
- 日常任务不要读取本目录；只有核对迁移完整性或理解历史背景时才按需打开单个文件。
- 为保证原始记录可验证，快照文件本身不添加新 TL;DR 或状态头，本索引统一标记其状态。

## Status

Archived

## 1A.3b 历史

- [#193 原三阶段 SPEC 正文](specs/issue-193-original-2026-09-27.md)保留缩小范围前的完整合同；当前执行以 Issue 最新正文为准。
- [G2 归档分支](https://github.com/lukemyself-hub/SayHear/tree/codex/archive-g2-v6)保存 #243 两套冻结校准的原始输出、报告、哈希和失败结论，以及未合并 G2 提交；校验与归档 commit 见 [#243 评论](https://github.com/lukemyself-hub/SayHear/issues/243#issuecomment-5861000654)。
- 当前交付范围由 [ADR-0141](../adr/0141-g1-only-release-after-g2-retirement.md) 和 [SPEC #193](https://github.com/lukemyself-hub/SayHear/issues/193) 定义。旧 G2 研究只作追溯。

## 快照

| 文件 | 原用途 | 当前替代 |
| --- | --- | --- |
| [`product/AI_Life_Journal_Product_Document_v0.1.md`](product/AI_Life_Journal_Product_Document_v0.1.md) | 1,541 行产品总稿 | `product/` 的按主题当前文档 |
| [`architecture/sayhear-core-agent-architecture-v0.1.md`](architecture/sayhear-core-agent-architecture-v0.1.md) | 5,003 行核心架构总稿 | `architecture/` 的按主题当前文档 |
| [`research/openclaw-tolan-architecture-research.md`](research/openclaw-tolan-architecture-research.md) | OpenClaw / Tolan 研究、建议与早期确认记录 | 当前产品与架构文档 |
| [`terminology/CONTEXT.md`](terminology/CONTEXT.md) | 重组前的根目录领域术语表快照 | [`../../CONTEXT.md`](../../CONTEXT.md) |

原产品文档第 27–28 节只保留在快照中，并重复当前产品结论。原架构第 30 节仍以旧
`ADR-001`–`ADR-058` 编号保留作历史证据；其每条结论到当前正式 ADR 的迁移结果见
[`docs/decisions.md`](../decisions.md#归档架构-v01-迁移映射)，当前实现不得引用旧编号。

## Open questions

无。历史材料不接受当前规范性修改。

## References

- [当前文档地图](../README.md)
