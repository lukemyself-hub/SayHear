# PR 自动审批 gate

## 状态

### controller 修复与 UI 证据标准

已安装的 controller 曾把 `ui:browser-smoke:desktop` / `:mobile` 当作 UI 必要证据，
但这两个 id 不在 `RELEASE_CHECKS` 中（真实 id 是 `ui:portal-smoke`），任何改动
`apps/web/app/**` 的 PR 都会永久停在 `awaiting_verification`。修复后的 bundle
`bf959f27e5a0a4b31136ed65feeb45ccce36259abbf48165b2845735dcf6d3f1` 已由 Luke
在本机安装，证据来源改为与 `scripts/daily-release-validation.ts` 共用的同一份路径
规则，gate 不再产生目录中不存在的 check id。

Luke 已确认接受以 `ui:portal-smoke` 取代设计稿所述的桌面与移动端浏览器交互证据。
该标准只在 Portal UI 路径（`apps/web/app/**` 中非 `api/` 的 `.tsx/.css/.scss`）上
追加检查；`apps/web/src/**` 是 handler 与组合根，不触发 UI 证据。这是产品决定，
降低了 UI 证据强度，仓库目前没有浏览器 E2E runner 支撑更强的结论。

### 已确认差异的人工授权

#### PR 作者也是审核决策者时

GitHub 不接受作者批准自己的 PR，最近一次推送也必须由其他身份批准。
Luke 的人工审核决定因此通过本机管理员写入的 `humanReviewAuthorizations`
记录表达，由独立 GitHub App 提交正式审批。普通 PR 评论、标签或在聊天中表示
“已审核”不会自行把 `pr-review-gate` 变绿。

1. Agent 用固定 `prepare` 入口刷新审核包，展示 PR、head、完整 diff 摘要、需求摘要、
   受保护路径及最新 Validate 结果，并完成独立代码审查。
2. Luke 对该具体版本确认接受受保护路径的差异。Agent 准备配置安装助手，将决定
   绑定审核包中的 PR 号、`approvedHeadSha`、`diff.digest`、
   `reviewContext.requirementDigest` 和精确路径；经 Luke 在自己的终端授权后安装。
   若 PR 改了 Validate 工作流，另绑定人工审核过的 workflow blob，不能自动信任它。
3. 若仅剩 Issue 的人工交接标签，按这次决定恢复 `ongoing` 并移除 `ready-for-human`
   和 `ready-for-agent`，随后再次 `prepare`，独立审核报告必须匹配最新需求摘要。
4. 用固定 `submit` 提交报告。controller 重新验证所有检查、需求、版本与保护规则，
   合格时由 App 提交 `APPROVED` 和成功的 gate，按既有生产授权执行受保护合入。

本机审批工具、测试、文档和根配置没有生产业务影响时，人工记录可另声明
`noRuntimeImpact: true`。只有完整 diff 与需求摘要匹配、每个改动路径都在记录中，
且路径均属于 scripts/tests/docs 或明确的根配置时，该决定才定位原本未知的影响，
要求完整 CI 基线；不伪装成生产业务专项。apps/packages/eval 与未知路径不能使用
该出口，已有路径提示所要求的专项仍然执行。模型报告不能设置这个字段。

其余人工授权只解除匹配的路径门禁。失败 CI、P0–P2 发现、未解决的审核线程、风险标记、
能力发布、暂停与生产证据要求仍会阻断。代码或需求改变后重新审核与绑定。
已有绑定记录在只同步 main 且 diff 与需求摘要均未改变时可继续使用。
安装助手不得读取私钥，也不得取消分支保护、修改 App 权限或把模型报告当人工授权。

Luke 已确认 #311、#310、#327 的具体差异。控制器从 root-owned `config.json`
读取 `humanReviewAuthorizations`，每条记录绑定 PR 号、完整 diff 的 SHA-256、
`reviewContext.requirementDigest`、精确文件路径和批准时间。`approvedHeadSha`
记录被审提交用于追溯；仅同步 main 且完整 diff 与需求摘要未变时可继续匹配。
#310 还绑定已审 Validate 工作流的 Git blob SHA。记录必须通过本机管理员安装，
模型报告和普通 configure 命令不能添加授权。未匹配记录不解除路径门禁；风险标记、
删测试、人工线程、最新 CI、独立审批和 main 保护继续执行。

PR 需求摘要只排除身份同时匹配 Vercel Bot actor `35613825`、login、Bot 类型、
GitHub App `8329` 且正文以 `[vc]: #` 开头的部署状态评论。人工评论、其他 Bot
评论、非状态正文及全部 Issue 评论继续纳入需求摘要；部署评论随每次构建更新，
不作为需求变更。

#323 已由 App 合入，生产提交 `26b63c94f9dbe01171826fb856a9e7801c9d1465`
对应部署 `dpl_HCpv4YhwQjAWqmpGHEBsRDrCN2ao` 已 Ready，公开登录与 providers
入口返回 200。#326 已 request changes 并回写 #274；Luke 要求暂不修改其代码。

2026-10-11，重启后的默认 Codex 会话已通过精确固定启动器完成 Keychain 与 GitHub API 认证。Luke 已授权 #325 / #258 完整试运行至合入与日常生产部署，其余七个 PR 后续由 Luke 明确指定为待自动审批对象。#325 已为 Ready，旧正文禁止合入标记已解除，Issue 曾设为 ongoing。App 已发布真实 `pr-review-gate` check；首次报告因评估工具路径误触发生产 Provider 专项而返回 awaiting_verification，未提交批准或合入，并按既定规则回写 Issue。

main classic protection rule `84625756` 已保存并由 App API 回读：1 个审批、过期审批失效、最近一次推送由他人审批、跟上 main、管理员同样执行、无绕过 actor；required checks 精确为 GitHub Actions `validate`（15368）与 SayHear App `pr-review-gate`（5270295）。规则 UI 禁止强推和删除。仓库 Allow auto-merge 已保存，用户连接器和刷新后的 UI 回读为 true；旧 App REST 读取会省略该字段，控制器已改为 GraphQL 明确布尔值读取并通过实测。

分类修复只识别已核实的十个评估工具、配置和测试路径，不将其文件名当作生产迁移；显式迁移声明、真实运行时路径、混合与未知改动继续保留门禁。已安装版本通过 App GraphQL 回读确认 Allow auto-merge 为 true；#258 已恢复 ongoing，App 已提交 #325 的 APPROVED review `5482359756`，gate check 成功。

试运行发现 Contents read 权限下的 App review 不计入分支保护。Luke 已明确授权 Contents write，App 和 installation `170161232` 的更新已完成；安装范围仍只有 SayHear。bundle `1e9fa694af8a511cf02dbb3ef5c3c419d9094b50da87bcd409f8958a5242c406` 已安装并通过认证、权限白名单和保护规则回读。合并请求绑定已审 head SHA；响应丢失先读取实际结果，手动关闭不算合入。83 个针对性测试、根与工具 TypeScript 检查通过。

#325 已由 App 于 `2026-10-11T07:37:40Z` 合入，merge SHA `bea67d2739de7cc1c64191d35a9964dd14336f2a`。#258 自动关闭，遗留 ongoing 已清理并回读。对应 Vercel deployment `dpl_GtX8f5k7kP1KScYRMsNy177Nzbom` 为 Production READY，git SHA 一致，生产域名已绑定；登录页和 auth providers 的 HTTP smoke 均为 200。未读取生产私人对话，smoke 不代表聊天功能验收。

每小时本线程 heartbeat `sayhear-pr` 已 ACTIVE，无变化不通知。首次定时执行待核验；已手动在默认会话执行 status/prepare，成功认证，合入后扫描没有候选，未写入其他七个 PR。运行证据存于 `artifacts/pr-approval/operations/2026-10-11-pilot.json`。修改三轮暂停与失败恢复由测试场景验证，实际试运行完成了待补证回写和成功合入，没有人为制造代码缺陷。

#309 已由 App 合入：分支同步最新 main 后 `validate` run `38128541215` 成功，独立审查结论为 approve（无 P0-P2）。merge SHA `328662a7a3746b83fd905cd96c67105c113bc23e`，Vercel Production deployment `dpl_91MNFTC2Y7day8pgrUnar2Pb7PAy` 为 READY 且 git SHA 一致，生产域名登录页与 providers 均返回 200；Issue #233 自动关闭，遗留 `ongoing` 已清理。非阻断备注：受版本控制的 `eval/continuation-acceptance-1a3b/run/validator-ledger.json` 指纹会因此变旧，需在下次 validator 采集时刷新；没有 CI 读取该文件。

#324 独立审查发现一个 P2：`packages/application/src/reflection/generator.ts` 的 `recordReflectionRunOutcome({status: "built"})` 仍在 post-Provider guard 内、`commitReflection` 之后执行，该独立事务抛错会被新 catch 吞掉并把已提交的 Reflection 结算为 terminal failed，正是 PR 自述要避免的「已提交结果被改写」；同一文件的新 catch 也不写 run-outcome 行，`reflection_runs` 会停在 `ready` 并被日常 readiness 查询排除。App 已提交 `request_changes`（review `5482816286`，head `bf60f2b4`），Issue #257 保持 open 与 `ready-for-agent`，接续原 PR。#324 分支已同步到含 #309 的 main，CI run `38129329755` 成功。

#327 的 CI 偶发红色已独立记录为 Issue #328：记忆检索服务默认注入真实单调时钟，越过版本化 200ms deadline 后 fail-closed 返回零注入，`context-inspector-retrieval` 因此偶发 `expected +0 to be 3`。这是 main 上的既有问题，不是 #327 的回归，也不作为 #327 的阻断理由。

2026-10-11，Luke 纠正七个存量 PR 的归属：它们是需要自动处理的待批准 PR，旧实现交接中的“等人工审核合入”不代表持续保留。调度 prompt 已同步。#309 的旧合入保留及两处关联 Issue 歧义已修正，相关 Issue 已恢复 ongoing；按最新 main、独立审查和 CI 逐个处理，不能免除实质门禁。

本文件记录实现边界和启用前置条件；方案背景见
[`../research/pr-auto-approval-design-2026-10-10.md`](../research/pr-auto-approval-design-2026-10-10.md)。

## 当前入口

```sh
pnpm pr:review-gate:dry-run -- --input <snapshot.json>
```

命令读取 JSON 快照，输出以下结果之一：

- `merge_candidate`：快照通过当前确定性规则。它不是 GitHub 批准、required check 或合入授权。
- `request_changes`：审核报告发现需要修改的问题。
- `awaiting_verification`：版本、SHA、权限或验收证据不足。
- `human_decision`：需求、产品、权限、迁移或保护规则需要人决定。

此命令不访问 GitHub，不执行 PR 代码，不调用 shell 命令，不创建 review/check，不回写 Issue，也不合入 PR。退出码 0 只表示快照可读取并完成评估；调用方必须读取 JSON 中的 `outcome`。

生产控制器只允许通过 `/Library/Application Support/SayHear/PRApproval/` 下的 root-owned 固定模式启动器调用：`pr-approval-status`、`pr-approval-prepare`、`pr-approval-scan`、`pr-approval-submit`、`pr-approval-configure`。`prepare` 只读取状态并写本地审核包；`scan` 可额外创建受控的 `pr-review-gate` 运行中检查；`configure` 仅由本机管理员在安装时写入 App 安装配置。控制器启动时逐一核验五个启动器、bundle 和 Node 均位于受保护目录。启动器固定 Node 与命令、清理继承环境变量，并拒绝任意子命令；不要用工作区源码、`pnpm pr:approval` 或 PR 提供的脚本访问 App 凭证。固定启动器已安装；2026-10-11 重启后的默认会话已确认精确执行规则允许正式路径在沙箱外运行并成功访问 Keychain。

## Gate 规则

- 报告绑定仓库、PR、head SHA、base SHA、策略版本，以及 Issue 标题、正文和 `updated_at` 摘要。Issue 评论或字段发生变化时，旧报告失效。
- 仅接受完整 diff、非 Draft PR、指向当前 `main` 的同仓库 PR，以及唯一、开放、无阻塞依赖的关联 Issue。
- Issue 必须处于 `ongoing`，不能同时带 `ready-for-agent`、人工处理、待补充或暂停状态。
- PR Validate 的证据必须对应当前 head、base 和 merge SHA，并匹配可信 workflow 文件摘要、GitHub Actions App、仓库和 `pull_request` 事件。
- 每项必要证据都必须显式为 `passed`。`skipped`、`cancelled`、`neutral`、`planned` 和 `out-of-scope` 均阻断。
- `scripts/daily-release-validation.ts` 决定行为专项；gate 不使用它的退出码代替验收结果。
- 涉及审批规则、CI、产品定义、删除测试、完整能力验收或生产新能力启用时转人工。UI 变化按 Luke 确认的标准，追加 `ui:portal-smoke`（`tests/portal-integration.test.ts` 与 `tests/portal-conversation-status.test.ts` 两个模块级行为测试），不再要求设计稿所述的桌面与移动端交互证据；仓库当前没有接入 PR CI 的浏览器 E2E runner。该降级是产品决定，不是测试通过，等真实浏览器 E2E 落地后可恢复。当前所有数据库迁移都返回 `awaiting_verification`；gate 尚未接入旧 schema、既有数据约束和新旧程序兼容证据。
- 只有可读的 main 保护规则、最新 base、过期 review 失效、管理员强制执行、恰好一个审批名额、没有绕过 actor，以及精确匹配来源的 `validate` 和 `pr-review-gate` 两项 required checks 同时成立时，才会生成 `merge_candidate`。
- 所有必要证据必须来自同一个 PR Validate workflow run 和 attempt。快照采集器仍须证明它们是当前最新 run；gate 本身不连接 GitHub，也不提供全仓合入锁。

## 快照信任边界

模型输出、PR 内容、Issue 正文和 CI artifact 都是不可信输入。解析器只将它们当作 JSON 数据，不执行内容。可信控制器自行从 GitHub API 读取 PR、Issue、保护规则和 workflow run，并验证 artifact 后再调用 gate；不能让模型填写 GitHub App 身份、检查来源或保护状态。controller 源码位于 `scripts/pr-approval-controller.ts`；受保护 bundle 依赖 Node 内置模块。密钥只从 macOS Keychain 读取，配置文件位于 root-owned 安装目录。

App ID、installation ID、slug 和生产授权标记存于 root-owned 本机配置，不是密钥。可信策略同时固定 Actions App 与 `pr-validate.yml` blob SHA。GitHub App 私钥只存于 macOS Keychain，不得传入模型进程、PR checkout 或普通 CI。controller 使用 `service=SayHear PR Approval GitHub App`、`account=lukemyself-hub/SayHear` 查找当前用户 Keychain；macOS CLI 可能以十六进制文本返回条目数据，controller 会先解码并校验 PEM。当前已有密钥已通过 API 认证。曾下载的第 7 把 PEM 已删除；最近提供的路径目前不存在，不要为了它再次生成密钥。

## 定时运行规则

- 每次先读取 status 和 prepare；认证、保护、部署核验失败则停止写入。
- 合入后确认实际 merged、merge SHA，并清理已关闭关联 Issue 的 ongoing。
- 对应 main merge SHA 的 Production Deployment 与 smoke；失败或状态未知停止后续合入。
- 每小时任务使用现有 Coding Plan 和精确启动器规则，无额外 API key，无变化不通知。
- 调度先 prepare，再仅对无人工保留且符合条件的 PR 调用 scan/submit；七个待批准 PR 按 Luke 最新指示纳入处理，仍逐个验证全部门禁。

最新操作证据见本文件顶部状态。安装后的当前状态必须重新读取，不能以本地文件存在代替真实核验。

## 首版专项证据限制

controller 当前只从同一次可信 PR Validate 的 Vitest 报告采集专项。
`prompt-budget:effective-config-diff`、`provider:effective-config-diff` 和
`provider:affected-role-calls` 是独立配置/Provider 工具，不是 Vitest 测试，尚没有
可信 producer artifact 的接入路径。需要这些专项的 PR 会保持待验证；重复运行
Vitest 或人工路径授权不能满足它们。后续应在可信 workflow 中接入 producer 输出、
绑定 head/base/merge SHA 与配置身份，再由 controller 校验 artifact。首版只开放
现有证据可满足的普通改动，不声称支持这些 Provider/配置变更的自动合入。
