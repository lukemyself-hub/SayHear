# SayHear Agent 入口

本文件只提供必要的全局规则和启动入口。

## 全局规则

- 修改前检查 `git status`，保留用户已有改动；优先小而可逆的变更，避免无关重构、新依赖和范围扩张。
- 修复问题前先确认根因，完成后运行与风险相称的验证。
- 未经明确要求，不提交、推送、重写历史、删除分支或工作树。
- 不因实现便利改变产品定义。若任务会改变产品定位、Internal Core / External MVP
  边界、用户信任或关键体验，先读取相关当前产品文档并向 Luke 确认。

## 文档启动规则

- 每个任务先读取 [`docs/README.md`](docs/README.md)，再按其路由读取任务相关的
  产品、SPEC、架构或术语文档。
- 不默认读取 `docs/archive/`、完整历史决策、整套产品文档或整套架构。
- 有 GitHub Issue 或 `docs/tasks/` working spec 时先读取任务本身，再读取它明确链接的
  当前文档；这些链接是最低起点，不是相关决策的完整清单。
- 设计或开发具体功能，以及修改架构、数据模型、工作流、接口、用户行为或隐私安全
  边界前，必须先通过 [`docs/decisions.md`](docs/decisions.md) 按主题和关键词检索，
  并读取所有命中的相关 ADR，在既有结论共识上完善和实施。
- 不无目标地通读全部 ADR，但不能以节省上下文为由跳过对任务相关 ADR 的检索和读取。
- 需要本地环境变量（如 `DATABASE_URL`、`TEST_DATABASE_URL`）、运行测试、连接数据库
  或探针前，先读取 [`docs/agents/local-environment.md`](docs/agents/local-environment.md)，
  按任务目标选择 `.env` 或 `.env.neon` profile，并按其规则安全加载。
- 发现文档与代码、SPEC 与 ADR 冲突时，明确指出冲突，不要自行猜测。
- 一次任务中不要重复读取没有变化的长文档。

纯机械且需求明确的日常任务，读取本文件和文档地图后即可开始。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `lukemyself-hub/SayHear`. See `docs/agents/issue-tracker.md`.

实现 Issue、提交 PR 审核或接续审查修改前，读取该文档的“实现与 PR 审核交接”规则。

### Triage labels

Use the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
