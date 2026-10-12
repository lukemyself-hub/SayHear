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

Edit the right-hand column to match whatever vocabulary you actually use.

## 执行占用

`ongoing`（仓库现有标签，描述 "This issue is being developed"）不是分诊角色，
表示 Issue 已被实现 Agent 认领，调度 Agent 不得重复派发。它与 `ready-for-agent`
互斥。

- 开始或恢复实现前：添加 `ongoing`，移除 `ready-for-agent`。
- 审查要求修改、转人工、三轮暂停或完成关闭时：移除 `ongoing`，再设置对应状态。
- 自动调度 Agent 看到 `ongoing`、暂停记录或活动 PR 时不派发。
- 标签不是原子锁；派发方与执行者都要在动作前后重读，发现冲突时停止。

## References

- [Documentation map](../README.md)
- [Issue tracker](issue-tracker.md)
