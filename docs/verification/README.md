# SayHear 功能验收地图

这份索引是 SayHear Internal Portal 功能验收的文档入口。功能地图的维护源位于
[verify/features/README.md](../../.agents/skills/verify/features/README.md)，
启动、doctor、证据与清理规则位于
[verify/SKILL.md](../../.agents/skills/verify/SKILL.md)。

## 功能地图

| 功能文件 | 验收范围 | 当前脚本直接覆盖 |
| --- | --- | --- |
| [Owner 访问](../../.agents/skills/verify/features/access.md) | 登录入口、匿名拒绝、Owner 访问、真实 OAuth | 根路径跳转、登录页、匿名 API 401；doctor 检查合成 Owner session |
| [文字对话与历史](../../.agents/skills/verify/features/conversation.md) | 发送、持久化、键盘与 IME、日期历史、分页、滚动、重试 | 按钮发送、回复、刷新持久化、日期 URL 只读历史、返回今天 |
| [Journal](../../.agents/skills/verify/features/journal.md) | 空状态、日期选择、自动交付、复制、PNG 导出、Conversation 回链 | Journal 空状态 |
| [Context Inspector](../../.agents/skills/verify/features/context.md) | 工具入口、消息链接、命令查询、敏感内容权限与审计 | 工具导航入口 |
| [Reflection Inspector](../../.agents/skills/verify/features/reflection.md) | Daily 与 Weekly、正文与血缘、Evidence 验证与审计 | 页面入口与 Evidence 验证控件 |

每份功能文件包含四个固定部分：`Sub-features`、`How to get to it (user POV)`、
`Driving it with Playwright`、`Gotchas`。其中记录子功能 ID、所有列出的用户入口、
驱动句柄、所需前提和可观察的验收结果。

## 覆盖边界

“地图列出了验收路径”与“现有脚本已验证该路径”是两种状态。表格最后一列只表示
脚本当前直接执行的范围；其他路径仍需按对应功能文件准备前提并执行。

本地空 seed 没有历史日期、已发布 Journal 或 Reflection。缺少前提的验收路径必须
报告未满足及原因，不能用空状态或页面入口通过代替完整功能验收。真实 OAuth、
Provider、hosted Workflow 与 G1 验收使用各自的隔离环境和证据。

这是一份覆盖五项功能的初始地图。Candidate Review、Release Operations 与 Voice
尚未纳入这套地图。功能变化后维护原功能文件与驱动脚本，避免复制第二份验收定义。

## 本地交付证据

创建时的验证摘要位于
[creation-proof.json](evidence/creation-proof.json)。它记录已执行路径、覆盖限制、
创建时的基线和清理结果。它不是 PR 新提交或生产环境的验收结果。完整截图、trace、
请求与数据库记录保留在本工作树的 `artifacts/verify/skill-proof-closed/`，该目录被 Git
忽略；每次正式验收需重新生成证据。

后续可用 `/maintain-verification-skill` 检查源代码、功能地图与实际行为是否一致。
