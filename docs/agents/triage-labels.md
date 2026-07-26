# Triage Labels

## TL;DR

- 本文件只映射 Issue 分诊角色与仓库实际标签。
- 仅在 Issue 分诊或标签操作时读取。
- 五个当前标签是 `needs-triage`、`needs-info`、`ready-for-agent`、
  `ready-for-human` 和 `wontfix`。

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

Edit the right-hand column to match whatever vocabulary you actually use.

## References

- [Documentation map](../README.md)
- [Issue tracker](issue-tracker.md)
