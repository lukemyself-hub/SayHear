# Triage Labels

## TL;DR

- 本文件映射 Issue 分诊角色、执行占用与仓库实际标签。
- 仅在 Issue 分诊或标签操作时读取。
- 五个分诊标签是 `needs-triage`、`needs-info`、`ready-for-agent`、
  `ready-for-human` 和 `wontfix`；执行占用另用 `ongoing`。

## Status

Accepted

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                   |
| -------------------------- | -------------------- | ----------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue   |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent   |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation             |
| `wontfix`                  | `wontfix`            | Will not be actioned                      |

When a skill mentions a role, use the corresponding label string from this table.

PR 审查要求修改后，对应 Issue 使用 `ready-for-agent` 接续已有 PR。该标签不解除
依赖、执行占用或自动修改暂停；接续前读取
[`实现与 PR 审核交接`](issue-tracker.md#实现与-pr-审核交接)。

Gate 因 PR Validate 仍在 queued、in-progress、missing 或 unknown 而返回
`awaiting_verification`，或审核上下文可重试、另一个 PR 仍在审批/合入时，Issue 保持
`ongoing`。终态未通过结果先回写并确认评论，再移除 `ongoing`，设置 `ready-for-agent`，
让调度器接续唯一的开放 PR。GitHub 标签更新不是原子操作，控制器可先设置
`ready-for-agent` 再移除 `ongoing`；调度器必须重读并跳过仍带 `ongoing` 的 Issue。
评论若要求维护者决定，Agent 必须等待。
`ready-for-human` 仍保留给 Agent 主动转人工实现的情形；PR gate 的 `human_decision`
回写 `ready-for-agent`，由接续 Agent 按评论准备维护者决定，不得自行替代该决定。
审核通过且 GitHub 已确认 auto-merge 或合入后，关闭 Issue 并清除 `ongoing` 与互斥分诊标签。

自动调度遇到带 `ready-for-agent` 且恰好有一个开放关联 PR 的 Issue 时，应接续原 PR
和分支，不因 PR 已存在而阻断，也不另开重复 PR。存在多个开放关联 PR、依赖或暂停记录时
仍不得派发。

本仓库没有实现 Issue 扫描或派发调度器；这些说明定义外部调度器应遵循的行为，不表示该
外部行为已在本仓库中验证。

Edit the right-hand column to match whatever vocabulary you actually use.

## 执行占用

`ongoing`（仓库现有标签，描述 "This issue is being developed"）不是分诊角色，
表示 Issue 已被实现 Agent 认领，调度 Agent 不得重复派发。它与 `ready-for-agent`
互斥。

- 开始或恢复实现前：添加 `ongoing`，移除 `ready-for-agent`。
- 审查要求修改、终态待验证、人工决策或三轮暂停时：先回写并确认评论，再移除
  `ongoing`，设置 `ready-for-agent`。审核通过后关闭 Issue 并清理执行占用。
- 自动调度 Agent 看到 `ongoing` 或暂停记录时不派发。带 `ready-for-agent` 且恰好有一个
  开放关联 PR 时接续原 PR；多个开放关联 PR 时停止并报告。
- 标签不是原子锁；派发方与执行者都要在动作前后重读，发现冲突时停止。

## References

- [Documentation map](../README.md)
- [Issue tracker](issue-tracker.md)
