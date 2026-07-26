# SayHear Agent 入口

本文件只提供全局规则和文档导航。开始任务时只读本文件，不要预加载下列文档；
根据任务实际涉及的范围按需读取。

## 全局规则

- 修改前检查 `git status`，保留用户已有改动；优先小而可逆的变更，避免无关重构、新依赖和范围扩张。
- 修复问题前先确认根因，完成后运行与风险相称的验证。
- 未经明确要求，不提交、推送、重写历史、删除分支或工作树。
- 不因实现便利改变产品定义。若任务会改变产品定位、Internal Core / External MVP
  边界、用户信任或关键体验，先阅读产品文档并向 Luke 确认。

## 按需读取

- **产品、设计、功能行为或范围决策**：阅读
  [`docs/product/AI_Life_Journal_Product_Document_v0.1.md`](docs/product/AI_Life_Journal_Product_Document_v0.1.md)。
  这是产品需求与背景的事实来源；不要在其他文件中重复 PRD。
- **领域术语、领域模型或架构决策**：阅读 [`CONTEXT.md`](CONTEXT.md)、
  相关 `docs/adr/`，以及 [`docs/agents/domain.md`](docs/agents/domain.md)。
- **GitHub Issue 或 PRD 操作**：阅读
  [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- **Issue 分诊或标签操作**：同时阅读
  [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

对于已有 Issue 驱动的开发，先读取 Issue、评论和验收条件，再只补充与改动直接相关的
上述文档。纯机械且需求明确的日常开发任务不需要读取完整产品文档。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `lukemyself-hub/SayHear`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
