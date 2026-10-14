# PR 自动审批 gate

## 状态

### 可恢复合并收尾

#339 将合并意图与 Issue 收尾分开持久保存。签名意图在请求合并前落盘，绑定已审
PR、仓库、head、base、App approval 和交付 Issue。恢复只读核验并补 Issue 收尾，
不重复批准或合并。未完成或明确不匹配的记录阻止后续合入。
单次最多五次确认、等待不超过 60 秒，最多十个自动执行周期，遵守 Retry-After。
来源、签名信任、回归证据、受控安装及回滚步骤见
[收尾实施说明](../plans/pr-approval-recoverable-completion.md)。
源码和构建夹具通过不代表当前特权安装版已完成更新，必须回读安装哈希及版本。

### 多 Issue PR 与关闭排除

Luke 于 2026-10-12 确认：PR 可以引用多个 Issue；合入后自动关闭其中仍开放的 Issue，
同时尊重 PR 对部分 Issue 的“不关闭”声明。多 Issue 版本已由 Luke 安装。2026-10-13T03:09Z 固定 `status` 回读确认
`policyVersion=sayhear-pr-review-gate:v4`，bundle SHA-256 为
`64e0f5674dd45c74a1067895ce7051fea9a31f8ca6deea0b0c707fce360707d8`。
#333 的 `prepare` 返回 `incomplete_diff`：1077 个文件超过 GitHub 整份 diff 接口
300 文件上限，API 返回 406。尚未生成正式审核包或提交批准。

- 引用来自同仓库 PR 标题、正文中的 `#数字` 或本仓库 Issue URL，去重并排除 PR 编号与
  其他仓库链接。审核包的 `issues` 包含全部引用的 Issue 和各自需求、评论摘要、状态。
- 明确的关闭排除单独记录在 `pullRequest.keepOpenIssueNumbers`。支持
  `本 PR 不关闭也不修改 #301。`、`Do not close: #301, #308.` 和
  `#301、#308 保持开放。`，以及直接列出本仓库 Issue URL 的声明。排除语句未明确
  列出编号或无法确定范围时进入 `human_decision`，先让维护者改写为明确编号列表。
- 排除项是需求上下文：完整读取并绑定需求摘要，但不认领、不写交接评论、不改标签、
  不关闭。#333 的“不关闭也不修改 #301”声明必须保留。
- 其余开放 Issue 均须认领、无暂停或互斥标签。交付集合内的开放依赖允许随本 PR 一起
  交付；集合外依赖，包括被声明保持开放的 Issue，仍须先解除。已关闭 Issue 只作
  需求上下文，不重新打开；合入后可清理未排除的已关闭 Issue 遗留状态标签。
- 每个交付 Issue 都须满足需求，不能用一个 Issue 的实现替代其他 Issue 的验收。
  任一正文、标题、非 App 评论或引用集合改变都会使需求摘要失效。
- 审批策略版本为 `sayhear-pr-review-gate:v4`，报告结构保持
  `sayhear-pr-review-report:v3`。旧报告与旧人工绑定不能直接用于新摘要。
- `prepare` 返回 `issue_completion_pending` 时，使用固定 `scan --pr 数字` 恢复合入后
  收尾。只开启 auto-merge 时继续等待并保留执行占用；必须回读 `merged=true` 和匹配
  的真实 App approval，才逐个关闭交付 Issue、清理标签并回读。失败不跳过其余 Issue，
  保留待收尾记录并报告失败项，下次 scan 重试。记录只是重试线索，不能替代 GitHub
  认证身份、已审需求摘要和实际合入状态。该路径不重新批准或合入 PR。

### PR 落后 main 的交接

Luke 于 2026-10-12 要求：发现 PR base 落后当前 main 时，将同步要求回写相应 Issue，
让实现 Agent 接续原 PR/分支。root-owned 版本已由 Luke 按 A 方案安装。2026-10-13T04:24Z 固定 status 确认三项版本，
bundle SHA-256 为 `ebfa3d099f916b7109a58283bc783b83de570a5644c305d5378684ff697392bc`。
#333 prepare 正式包完整，1077 文件、85 二进制，keepOpenIssueNumbers 为 [301]；
固定 scan 已由 App 回写 #321/#322 并回读 ready-for-agent、无 ongoing；#301 未修改。
PR 仍等待同步 main，本次未提交批准或合入。
新增状态标识 `baseSyncHandoffVersion=sayhear-pr-base-sync:v1`，policy v4 与 diff v2 保持不变。

- 在复用旧审核和等待旧 CI 前处理 base 落后。`prepare` 只生成本地包并返回
  `waiting_for_current_base`、`handoffRequired=true`、head/base/currentMainSha 和 packetPath。
  包生成不表示批准，也不表示 CI、人工授权或生产验收门禁通过。
- 使用固定 `scan --pr 数字` 完成 App 身份回写；这条专用交接不要求 Issue 已全部 ongoing，
  也不因旧 CI 排队而无限等候。先核验 Ready、同仓库 main、最新 head/base、引用集合和排除，
  暂停或合入保留仍阻断。`submit` 遇到匹配当前身份与需求摘要的 stale-base 报告也走此交接。
- 每个未排除的开放 Issue 收到 PR 链接、head/base/当时 main SHA、同步 main、处理冲突、
  在新 SHA/base 上重跑可信 CI 与专项、接续原 PR 不另建 PR 的要求。#301 等明确保持开放项
  不写评论、不改标签；已关闭项不重新打开。
- 确认 App 评论后恢复 `ready-for-agent`、清除 `ongoing` 和互斥标签并回读。
  `ready-for-human`、`needs-info`、`needs-triage`、`wontfix` 只收到提醒，原标签保留，
  输出 `held_for_human` 与 heldIssueNumbers。交接不解除人工决定、暂停或集合外依赖。
- App 在标签回读后写已完成标记，以 PR/head/base/main 去重；后续 Agent 已重新认领的
  `ongoing` 不被同一轮扫描释放。评论成功但标签失败可重试；逐项失败不跳过其余项，
  `base_sync_handoff_incomplete` 不可报告为已交接。
- 此路径不创建 request changes review，不增加三轮代码修改失败计数，也不批准、合入或
  直接修改 PR 分支。实现 Agent 执行前须重读最新 main、评论、依赖与暂停，再按 Git 授权同步。

交接评论已有、完成标记缺失且 Issue 仅有 ongoing 时，无法可靠区分旧占用与新认领，
保留占用并报告未完成交接，等待人工核实；不盲目释放。main 再前进时，已交接后新认领
的 Agent 只收到更新提醒，ongoing 保留。标签变更函数也回读人工状态，遇到新人工标签停止。

### 大 PR 完整 diff 取证

新增 collector 已用 #333 的认证 API 元数据和固定 Git 对象完成离线重放验证：
1077 文件、85 个二进制文件，完整 patch 正向应用后全部 blob SHA 与 head 一致，反向
还原也通过。该 collector 的正式 root-owned bundle 已由 Luke 安装；固定
`status` 回读确认 `diffCollectionVersion=sayhear-pr-diff:v2`，bundle SHA-256 为
`2ab4934dbc43cc65df9be0c2f2ebac4f109f94f4a3f9eb23bf859d619d08c049`。
2026-10-13T04:00:28.835Z 的正式 `prepare --pr 333` 返回
`waiting_for_current_base`：PR base 为 `b31cc25a`，main 已到 `575cd63b`，GitHub 状态
为 `BEHIND`，因此尚未生成正式包。待 PR 跟上当前 main 后再回读包内完整性与排除项。

- 普通文本 PR 从固定 base/head SHA 的 compare 接口读取 unified diff，逐项校验文件头、
  状态、index SHA、hunk 数量及增删计数。没有 hunk 的修改必须回退到 tree/blob 核验。
- 大 PR 或 diff 无法证明完整时，交叉核对分页 files、compare 的 merge-base、固定 commit
  tree。要求树未截断、文件数与 `changed_files` 相符、路径去重，完整树差异与 manifest
  覆盖集合完全一致。缺失路径、mode 或 SHA 不匹配都阻断。
- 内容只来自固定 blob SHA 的原始数据接口，验证 Git blob SHA 和字节数；按旧/新完整
  内容生成 full-file patch，包括可正反应用的 Git binary literal patch。不能将
  `Binary files differ` 摘要或 per-file `patch` 字段当作完整内容。接口依据见
  [GitHub blob API](https://docs.github.com/en/rest/git/blobs#get-a-blob) 和
  [GitHub tree API](https://docs.github.com/en/rest/git/trees#get-a-tree)。
- `diff.source` 为 `github-diff`、`github-blobs` 或 `unavailable`，并记录 merge-base、
  内容大小、二进制数量、预期文件数和失败原因。fallback 的完整文本参与 `diff.digest`
  与修改轮次摘要；任何二进制内容改变都使摘要改变。
- 限制 3000 个改动文件、单 blob 8 MiB、旧/新内容合计 64 MiB、patch 128 MiB、6 个并发
  blob 读取。改变限额须经过 gate 改动授权。变更中的 submodule 不自动当作完整 diff。
- `artifacts/pr-approval/git-blobs/` 是可删除的内容缓存，不能授予审批。每次都按认证
  tree 的 SHA 和大小重新验证，拒绝符号链接与非普通文件，有界读取；缓存污染则重新
  从 API 取得内容。缓存写入失败不改变已验证的证据。controller 不调用工作区 Git，
  不 checkout、不执行被审代码、不安装依赖。
- 全部内容读取后再次回读 PR head/base/file count。漂移、截断、下载超限、manifest
  读取失败或内容校验失败仍保持 `incomplete_diff`。已能读取 PR/Issue 上下文时，
  `prepare` 会生成带原因的诊断包，包中 `diff.complete=false`，不能提交批准。
- 安装后先 `status`，再 `prepare --pr 333`，核验 `diff.complete=true`、1077 文件与
  `keepOpenIssueNumbers=[301]`。完整取证不代表代码审核、CI、迁移或生产验收通过。

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
3. 若仅剩 Issue 的人工交接标签，按这次决定恢复 `ongoing`，并清除审核回写留下的
   `ready-for-agent` 和旧流程可能残留的 `ready-for-human`，随后再次 `prepare`，
   独立审核报告必须匹配最新需求摘要。
4. 用固定 `submit` 提交报告。controller 重新验证所有检查、需求、版本与保护规则，
   合格时由 App 提交 `APPROVED` 和成功的 gate，按既有生产授权执行受保护合入。

本机审批工具、测试、文档和根配置没有生产业务影响时，人工记录可另声明
`noRuntimeImpact: true`。只有完整 diff 与需求摘要匹配，且每个改动路径都是明确列出的
离线评估路径，或精确授权的 scripts/tests/docs/根配置路径时，该决定才定位原本未知的
影响，要求完整 CI 基线；不伪装成生产业务专项。当前仅列出
`eval/retrieval-precision-v1/README.md`、`eval/retrieval-precision-v1/harness.ts` 和
`tests/system/retrieval-precision-corpus.system.test.ts` 三个离线路径。其他 eval、runtime
和未知路径不适用。人工授权的 scripts/ci 与 tests/ci 路径仍须逐个精确匹配。混合 runtime
改动按声明的影响执行正常专项检查。模型报告不能设置这个字段。

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

- 报告绑定仓库、PR、head SHA、base SHA、策略版本，以及全部引用 Issue 的标题、正文和非 App 评论摘要。只改标签或 App 自身回写不改变需求摘要。
- 仅接受完整 diff、非 Draft PR、指向当前 `main` 的同仓库 PR，以及完整的关联 Issue 集合。交付集合的开放 Issue 须已认领，集合外依赖须解除。
- 每个未排除的开放 Issue 必须处于 `ongoing`，不能同时带 `ready-for-agent`、人工处理、待补充或暂停状态。
- PR Validate 的证据必须对应当前 head、base 和 merge SHA，并匹配可信 workflow 文件摘要、GitHub Actions App、仓库和 `pull_request` 事件。
- 每项必要证据都必须显式为 `passed`。`skipped`、`cancelled`、`neutral`、`planned` 和 `out-of-scope` 均阻断。
- `scripts/daily-release-validation.ts` 决定行为专项；gate 不使用它的退出码代替验收结果。
- 涉及审批规则、CI、产品定义、删除测试、完整能力验收或生产新能力启用时转人工。UI 变化按 Luke 确认的标准，追加 `ui:portal-smoke`（`tests/portal-integration.test.ts` 与 `tests/portal-conversation-status.test.ts` 两个模块级行为测试），不再要求设计稿所述的桌面与移动端交互证据；仓库当前没有接入 PR CI 的浏览器 E2E runner。该降级是产品决定，不是测试通过，等真实浏览器 E2E 落地后可恢复。当前所有数据库迁移都返回 `awaiting_verification`；gate 尚未接入旧 schema、既有数据约束和新旧程序兼容证据。
- 只有可读的 main 保护规则、最新 base、过期 review 失效、管理员强制执行、恰好一个审批名额、没有绕过 actor，以及精确匹配来源的 `validate` 和 `pr-review-gate` 两项 required checks 同时成立时，才会生成 `merge_candidate`。
- 所有必要证据必须来自同一个 PR Validate workflow run 和 attempt。快照采集器仍须证明它们是当前最新 run；gate 本身不连接 GitHub，也不提供全仓合入锁。

## Issue 标签交接

- Gate 因 PR Validate 仍处于 `queued`、`in_progress`、`missing` 或 `unknown` 而返回
  `awaiting_verification`，或审核上下文报告 `repository_merge_busy`、
  `github_context_unavailable`、`stale_review`、`policy_version_mismatch`、
  `incomplete_diff` 等可重试状态时，审核尚在等待，Issue 保持 `ongoing`，不写终态评论。
  `trusted_identity_unconfigured`、`review_author_unavailable`、
  `branch_protection_unreadable`、`production_deploy_behavior_unknown` 等阻断属于终态，
  先回写评论，再按 `ready-for-agent` 交接，不能让 `ongoing` 长期占用 Issue。
- 对每个未排除的开放 Issue，其他终态非批准结果（`request_changes`、终态 `awaiting_verification` 或
  `human_decision`）必须先确认 Issue 评论已写入，再设置 `ready-for-agent`、移除
  `ongoing` 和其他互斥分诊状态，并回读最终标签。更新失败时不能声称已完成交接。
  评论若要求维护者决定，Agent 先等待决定，不得自行替代。Agent 接续时检查依赖、暂停
  记录和关联 PR；恰好一个开放关联 PR 时继续原 PR 和分支，不创建重复 PR。多个关联 PR、
  依赖或暂停仍阻断。本仓库不含 Issue 调度器，因此这条接续行为是外部调度器的要求，
  不能仅凭本文档声称已经实测。
- App 已提交 `APPROVED` 且 GitHub 回读确认 PR 实际合入后，逐个关闭未排除的开放 Issue，
  清理 `ongoing` 和互斥分诊状态，并回读确认。类别标签如 `bug` 保留。只启用
  auto-merge 时继续等待，保持执行占用，不提前关闭。

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
