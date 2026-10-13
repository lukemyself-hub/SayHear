# SayHear 功能验收地图

这份索引是 SayHear Internal Portal 功能验收的文档入口。功能地图的维护源位于
[verify/features/README.md](../../.agents/skills/verify/features/README.md)，
启动、profile、doctor、证据与清理规则位于
[verify/SKILL.md](../../.agents/skills/verify/SKILL.md)。

## 功能地图

| 功能文件 | 验收范围 | 当前脚本直接覆盖 |
| --- | --- | --- |
| [Owner 访问](../../.agents/skills/verify/features/access.md) | 登录入口、匿名拒绝、Owner 访问、真实 OAuth、非 Owner 拒绝、退出 | 根路径跳转、登录页、匿名 API 401、退出；真实 OAuth 登录与拒绝由 `oauth` 旅程驱动，需要人完成 GitHub 页面 |
| [文字对话与历史](../../.agents/skills/verify/features/conversation.md) | 发送、持久化、键盘与 IME、日期历史、分页、滚动、重试 | 按钮发送、回复、刷新持久化、日期 URL 只读历史、返回今天；`provider` profile 下同一旅程走真实 Provider |
| [Journal](../../.agents/skills/verify/features/journal.md) | 空状态、日期选择、自动交付、复制、文本导出、Conversation 回链 | 空状态；`delivery` 旅程覆盖自动交付、日期入口、复制、导出、回链 |
| [Context Inspector](../../.agents/skills/verify/features/context.md) | 工具入口、消息链接、命令查询、敏感内容权限与审计 | 工具入口；`context-trace` 覆盖消息链接、命令查询、未验证时的拒绝与审计 |
| [Reflection Inspector](../../.agents/skills/verify/features/reflection.md) | Daily 与 Weekly、正文与血缘、Evidence 验证与审计 | 页面入口与 Evidence 验证控件；`oauth` 旅程覆盖 Evidence 验证往返本身 |

每份功能文件包含四个固定部分：`Sub-features`、`How to get to it (user POV)`、
`Driving it with Playwright`、`Gotchas`。其中记录子功能 ID、所有列出的用户入口、
驱动句柄、所需前提和可观察的验收结果。

## 覆盖边界

“地图列出了验收路径”与“现有脚本已验证该路径”是两种状态。上表最后一列只表示
脚本能直接执行的范围；下面的台账记录每条路径实际跑过什么。

驱动用 profile 声明哪些环节是替身。`local` 是固定时钟、确定性 Provider、合成
session 的基线；`live`、`provider`、`oauth`、`oauth-stranger` 各把一个替身换成
真实环节。每份结果 JSON 都写明所用 profile。所有 profile 都是本地 Next dev 加
一次性 PostgreSQL，Workflow 运行在本地 runtime，不等于 hosted 验收。

缺少前提的验收路径必须报告未满足及原因，不能用空状态或页面入口通过代替完整
功能验收。Candidate Review、Release Operations 与 Voice 尚未纳入这套地图。功能
变化后维护原功能文件与驱动脚本，避免复制第二份验收定义。

## 覆盖台账

状态取值：**已实跑** 指驱动在所列环境执行并通过；**可执行待人** 指驱动与自检
已就绪，缺一步只有人能完成的操作；**待授权** 指缺预算或环境授权；**未覆盖**
指还没有可执行的方法。实跑记录见
[coverage-extension-proof.json](evidence/coverage-extension-proof.json)。

| 子功能 | 环境 | 状态 | 已有证据 | 缺口与下一步 | Issue |
| --- | --- | --- | --- | --- | --- |
| `access-signin`、`access-anonymous`、`access-owner` | `local` | 已实跑 | `access` 旅程与 doctor | 无 | — |
| `access-oauth` | `oauth`（本地 OAuth app，一次性库） | 已实跑 | 2026-10-13 `oauth-owner-1 / oauth-manual`：真实 Owner 登录、两次 GitHub 回调、Evidence 验证、读取与退出；对应干净的 `0b1b799` | 人在自己的浏览器操作，数据库与日志证明服务端结果；未采集浏览器画面。有头 `oauth` 登录后的代码仍未执行 | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `access-refusal` | `oauth-stranger` | 已实跑 | 2026-10-13 `oauth-stranger-1 / oauth-manual`：一次 GitHub 回调、实测 `OAuthCreateAccount`、session 数 0，Owner mapping 数仍为 1；实例已清理 | 服务端数据库与日志证明拒绝；未采集浏览器画面，有头旅程仍未实跑 | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `access-signout` | `local`、`live`、`oauth` | 已实跑 | fixture 的 `signout` 旅程：401、session 行删除、回到登录页；真实 Owner 的 `oauth-manual` 确认退出后 session 行删除 | 真实 OAuth 退出的浏览器画面未采集 | — |
| `access-oauth`（hosted） | `sayhear-g1-acceptance` | 未覆盖 | 历史记录称该环境 Owner 登录可用，本次未复核 | 别名受 Vercel Authentication 保护；需要人登录 Vercel 与 GitHub | #322 相关 |
| `text-send`、`text-persist`、`history-read` | `local` | 已实跑 | `text` 旅程与 `text-stored.json` | 无 | — |
| `text-send`、`text-persist`、`context-message-link`（真实 Provider） | `provider`（OpenCode Go） | 已实跑 | `text` 与 `context-trace` 各一次：`opencode-go / deepseek-v4.1-flash`，可见回复 2.6 秒，3118 输入与 102 输出 token，渲染与存储一致，Inspector 显示同一 Provider | 只证明一次回复的传输、呈现与持久化，不涉及质量与连续性 | #321 |
| `text-keyboard`、`history-navigation`（分页、滚动、重试） | — | 未覆盖 | 无 | 需要新增旅程；`delivery` 只覆盖了结束后当日的日期链接 | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `journal-empty` | `local` | 已实跑 | `journal` 旅程 | 无 | — |
| `journal-delivery`、`journal-copy-export`、`journal-conversation` | `live` | 已实跑，间歇失败 | `delivery` 旅程与 `delivery-stored.json`：静默结束、调度扫描、发布、复制、导出、回链 | 13 次里 3 次因 workflow 事务死锁未发布 Journal，属产品缺陷；替身：60 秒静默窗口、驱动调用扫描、本地 Workflow runtime | [#340](https://github.com/lukemyself-hub/SayHear/issues/340) |
| `journal-date`（单日期入口） | `live` | 已实跑 | 同一旅程的日期链接与日期 URL | 只有一个日期，无法区分“该日期自己的正文” | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `journal-date`（跨日期正文） | — | 未覆盖 | 无 | 需要产生第二个逻辑日期的 Journal，再核对各自正文 | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `journal-delivery`（真实 Provider） | `provider` | 待授权（且 #341 阻塞） | 第二次调度扫描等待 Owner 行锁 10 秒后返回 500，旅程当时把它判为失败并清理了实例 | 先等 #341 修复再重跑；重跑前确认既有 0.50 美元预算仍有效 | [#341](https://github.com/lukemyself-hub/SayHear/issues/341) |
| `journal-delivery`（hosted Workflow） | `sayhear-g1-acceptance` | 未覆盖 | `docs/plans/g1-activation.md` 记录过 629e951 的一次 hosted 发布，本次未复核 | 需要先读取该环境当前部署的 commit，再决定是否部署待验版本 | #322 相关 |
| `context-entry` | `local` | 已实跑 | `context` 旅程 | 无 | — |
| `context-message-link`、`context-lookup` | `local`、`live` | 已实跑 | `context-trace` 旅程 | 注入、排除与血缘分组未断言 | — |
| `context-source-gates`（拒绝与审计） | `local`、`live` | 已实跑 | 403 `elevated_capability_required` 与一条 `denied` 审计 | 无 | — |
| `context-source-gates`（验证后允许） | `oauth` | 已实跑 | `oauth-owner-1`：recent `conversation_content:read` grant，先 `denied:elevated_capability_required` 后 `allowed:authorized` 审计 | 数据库与日志证明服务端放行，未采集浏览器响应或画面 | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `reflection-entry` | `local` | 已实跑 | `reflection` 旅程 | 无 | — |
| `reflection-evidence`（验证往返） | `oauth` | 已实跑 | `oauth-owner-1`：第二次 GitHub 回调后出现 recent capability grant | 只证明验证往返的服务端结果；Reflection 摘录展开仍需已生成的 Reflection | [#342](https://github.com/lukemyself-hub/SayHear/issues/342) |
| `reflection-scope`、`reflection-trace`、Episode 与 Daily / Weekly 生成 | `sayhear-g1-acceptance` | 未覆盖 | 无 | 本地 profile 的 G1 开关关闭；active G1 manifest 是未入库的发布产物，本 checkout 没有 | #251、#322 相关 |

## Hosted 验收环境现状

2026-10-12 只读盘点的结果，开始 hosted 验收前需要重读：

- 隔离 Vercel project `sayhear-g1-acceptance` 存在，别名
  `sayhear-g1-canary-lukemyself.vercel.app` 指向 2026-10-07 经 CLI 上传的部署，
  状态 Ready，没有 Git 元数据，所以无法从平台读出它对应的 commit。
- 别名受 Vercel Authentication 保护，匿名请求被重定向到 Vercel SSO。部署身份
  接口 `/api/internal/inspection/release-identity` 需要 Owner session 或
  operator secret。
- 该 project 的 Preview 环境变量包含独立的 OAuth client、业务库、Purge Marker
  库、Provider key 与 G1 开关，值全部是不可读的 secret；变量列表中没有 G1
  release manifest。G1 当前是否开启未知。
- 本次没有向该环境发出任何带凭据的请求，也没有创建访问绕过链接或部署。

## 交付证据

- [creation-proof.json](evidence/creation-proof.json)：PR #338 创建驱动时的验证
  摘要，对应当时的五条旅程。
- [coverage-extension-proof.json](evidence/coverage-extension-proof.json)：扩展
  profile 与旅程后的实跑摘要，含驱动脚本的 SHA-256、每条旅程的结果与未执行项
  及原因。

两份都不是新提交或生产环境的验收结果。完整截图、trace、请求与数据库记录保留
在执行工作树的 `artifacts/verify/<run-id>/`，该目录被 Git 忽略；每次正式验收需
重新生成证据。

后续可用 `/maintain-verification-skill` 检查源代码、功能地图与实际行为是否一致。
