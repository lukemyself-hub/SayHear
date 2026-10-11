# Issue tracker: GitHub

## TL;DR

- Issues and complete SPECs for this repository live in GitHub Issues.
- A SPEC Issue body, comments, and labels are its sole execution source;
  `docs/specs/README.md` is discovery-only and must not duplicate the body.
- Read the target Issue, comments, labels, and acceptance criteria before issue-driven development.
- Before designing or implementing an Issue, search the decision index by every affected
  domain and read all matching ADRs; Issue links are a starting point, not a complete list.
- 实现、提交 PR 审核及接续修改时，遵守下方交接规则。
- Use this file only for Issue or SPEC operations; ordinary local development does not need it.

## Status

Accepted

Issues and complete SPECs for this repo live as GitHub issues. Use the `gh` CLI for all
operations. GitHub is the sole execution source for a published SPEC; the local
[`../specs/README.md`](../specs/README.md) contains only a lightweight index and
publishing rules.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, keeping only external contributors.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so resolve an ambiguous `#42` with `gh pr view 42` and fall back to `gh issue view 42`.

## 实现与 PR 审核交接

以下规则由 Luke 确认，适用于已获授权的 Issue / PR 交付。不扩大具体任务的提交、
推送或合入权限；用户明确要求保留 Draft、暂停合入或只做研究时，以该要求为准。
规则写入文档不代表自动审批 Agent 已启用。PR 仍是实现和审查载体，不取代 Issue
作为需求来源，也不改变上方“PRs as a request surface: no”。

### 执行占用与派发互斥

`ongoing` 表示该 Issue 已被一个实现 Agent 认领，交付链路尚未结束（包括等待审核、
等待修改和三轮暂停前的处理）。它与 `ready-for-agent` 互斥。

- 开始或恢复执行：先添加 `ongoing`、移除 `ready-for-agent`，再修改文件或派发子任务。
- 审查要求修改、转人工、三轮暂停或任务完成：按对应规则移除 `ongoing`，再设置
  `ready-for-agent`、`ready-for-human` 或关闭 Issue。GitHub 因 PR 合入自动关闭
  Issue 时，恢复扫描负责清理遗留的 `ongoing`。
- 自动调度 Agent 只派发 `ready-for-agent` 且无 `ongoing`、无暂停记录、无活动 PR 的
  Issue；看到 `ongoing` 不得重复实施。
- 标签是协调信号，不是原子锁。调度方派发前重读，执行者认领后再次确认；发现另一个
  执行者已认领时立即停止，保留现场并报告，不并行修改同一 Issue。

### 实现 Agent 提交审核

1. 开始或恢复前读取 Issue 正文、评论、依赖及关联 PR，检查现有执行者和暂停记录。
   `ready-for-agent` 表示任务已描述充分，不等于依赖已解除或无人正在执行。确认可执行
   后按“执行占用与派发互斥”先完成认领，再开始修改。
2. 实现未完成时保留 Draft。完成实现及自检后，在 PR 中列出对应 Issue、行为变化、
   实际验证结果、证据链接和未完成的验收项。未运行、跳过和环境失败不得写成通过。
3. 已授权交付的实现和自检完成、没有明确的 Draft / 暂停要求时，由实现 Agent 将
   PR 转为 Ready for review，表示提交审核；若 CI 仍在运行，如实记录。Ready 不代表
   已批准、已验收或已合入。审批 Agent 不自行将存量 Draft 转为 Ready。
4. 实现 Agent 不以自己的自检替代独立审批，不绕过保护规则合入。仅提交 PR 或 CI
   通过不代表 Issue 已完成，不能据此提前关闭 Issue。

### 审查要求修改后的交接

1. 审批 Agent 对确定的阻断问题提交 `request changes`，保留 PR，并将审核结果同步
   到对应 Issue。回写包含 PR/review 链接、被审 head SHA、问题位置及触发条件、
   修改要求和复验要求。
2. 确认 Issue 评论已写入后，移除 `ongoing`，将该 Issue 分诊状态改为
   `ready-for-agent`，移除其他互斥分诊状态，保留 bug、enhancement 等标签。用
   review ID 避免重复回写；评论或标签更新失败时记录未完成步骤，不能声称已交接。
3. Issue tracker Agent 接续现有 PR 和分支，先检查执行占用、依赖及暂停记录，避免
   创建重复实现。修改后记录对各项发现的处理和验证结果，交给审批 Agent 审查新 SHA。
   单纯重跑扫描、重复事件或同一 SHA 的重复 review 不算新一轮修改。
4. 同一 PR 连续三轮“修改后复审仍有阻断问题”后，停止自动修改并通知 Luke。
   CI 等待和环境重试不计入轮次。第三轮结果仍回写 Issue，移除 `ongoing` 并更新
   `ready-for-agent`，同时明确记录“自动修改已暂停，等待 Luke 决定”；暂停优先于
   标签，Issue tracker 不得继续领用。重启任务或重新标记 Ready 不重置轮次，也不
   解除暂停。

需求/ADR 冲突、缺少授权等需要人决定的情况，不伪装成可直接执行的修改要求。
关联 Issue 不明确或已关闭时，报告交接阻塞，不猜测目标或自动重开。审批身份、
调度、暂停记录的机器格式及具体自动合入门禁由后续获批的自动审批方案定义。

### 缺少验收证据时

CI 仍在运行时等待，不派发重复修改。必要专项证据缺失时，审批 Agent 保持
“待验证”，在对应 Issue 记录目标 SHA、所缺检查和通过条件，由实现 Agent 补齐。
交回补证时按“执行占用与派发互斥”移除 `ongoing` 并设置 `ready-for-agent`，让调度
Agent 能重新派发。补证不能只提供“已测试”的自述，应附可核验的报告、运行记录或
交互证据。缺证据不等于已确认代码缺陷，不为此发送虚假的 `request changes`，也不
增加上述三轮修改失败计数。无法在已有授权内补齐时报告阻塞，不擅自调用额外付费
模型 API 或读取生产私人数据。

## When a skill says "publish to the issue tracker"

Create a GitHub issue containing the complete SPEC or ticket body. For `/to-spec`:

1. create the complete SPEC as a GitHub Issue;
2. apply the `ready-for-agent` label without routing it through `/triage`;
3. add a lightweight Issue link, Core Flow, and status entry to
   [`../specs/README.md`](../specs/README.md);
4. keep subsequent scope, acceptance-criteria, discussion, and status changes in the
   GitHub Issue rather than copying them into a local SPEC file.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues aren't enabled, add the child to a task list and put `Part of #<map>` at the top of the child body.
- **Blocking**: use GitHub’s native issue dependencies. Where unavailable, use a `Blocked by: #<n>, #<n>` line.
- **Frontier query**: find the first open, unblocked, and unassigned child in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment with the answer, close the child issue, then append a context pointer to the map’s Decisions-so-far.

## References

- [Documentation map](../README.md)
- [Triage labels](triage-labels.md)
