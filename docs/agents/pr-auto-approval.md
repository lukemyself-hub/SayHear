# PR 自动审批 gate

本文件是实现边界与启用前置条件；方案背景见
[`../research/pr-auto-approval-design-2026-10-10.md`](../research/pr-auto-approval-design-2026-10-10.md)。

## 当前状态

**集成模式是 `serialized-merge`。** PR 不要求与最新 main 对齐，也不需要为了合入先同步
base；审批绑定被审 head，main 前进本身不使批准失效。controller 在最新 main 的组合上
验证可信 CI，真实代码冲突才交回原 PR 处理。

判断能力是否生效只看固定 `pr-approval-status` 的回读结果，不看源码里写着什么版本号。
2026-10-15 回读：

- `integrationMode=serialized-merge`，`branchProtection.requiresUpToDate=false`
- `policyVersion=sayhear-pr-review-gate:v11`，`reportVersion=sayhear-pr-review-report:v4`
- `diffCollectionVersion=sayhear-pr-diff:v2`，`baseSyncHandoffVersion=sayhear-pr-base-sync:v1`
- `browserApprovalVersion=sayhear-pr-browser-approval:v1`，
  `build.completionVersion=sayhear-pr-completion:v1`
- `controllerSha256=22e5616f67846fac68881679662f39c19e99f4ec79d3295c73352e2a19c9e97c`，
  `build.sourceCommit=c05a4e339124fdfcd6abed11ac62cdfdf249a7b0`
- main 写入守卫：ruleset `25189203`，root-owned 见证指纹
  `63ba66c4d3acc4705cfda8b02912e80c72a016a97b92bcb52860954f57e026a9`，断言 bypass
  只有审批 App `5270295`。GitHub 不把 bypass 名单返回给 App token，因此
  `bypassActorsEnumerated=false` 是正常结果，由见证判定。

`up-to-date-base` 保留为回退模式，行为见「集成模式与合并队列」与「PR 落后 main」。

### 审批工具链路径的影响定位

release planner 用 `NON_RUNTIME_TOOL_PATHS` 枚举不配置部署运行时的路径：离线评估工具，
以及 PR 审批工具链自身的 controller、gate、planner、build、verifier、其测试、夹具与
文档。改动只落在该集合内时 `requiresImpactLocation=false`，只要求固定 PR CI 基线；
显式影响声明、混合改动和集合外路径继续按原规则定位，这些路径也不再触发
`provider-migration` 提示。

### 迁移专项证据

`packages/data/migrations/` 与 `packages/data/migrations-purge-marker/` 的改动强制选择
`migration:upgrade-compatibility`。该专项由统一 release planner 注册，gate 与 collector
都读 planner，窄影响声明不能删掉它；`purge:full-restore-drill` 继续必需。

collector 从同一次可信 PR Validate 的 `vitest-report.json` 收集专项，报告须实际覆盖
`tests/ci/migration-upgrade-compatibility.test.ts`，且测试文件与其非空 assertion 列表
全部 passed。空报告、空 assertion、缺失、失败、跳过、身份不符、重复记录或 artifact
覆盖不符都不能批准。证据绑定 repository、App、workflow 版本、head/base/merge SHA、
run/attempt 与 artifact digest。缺少该证据时迁移 PR 保持待验证，协议回归测试不代表
真实迁移兼容性已通过；破坏性迁移仍转人工。

### 可恢复合并收尾

合并意图与 Issue 收尾分开持久保存：签名意图在请求合并前落盘，绑定已审 PR、仓库、head、
base、App approval 与交付 Issue；确认合入后只补 Issue 收尾，不重复批准或合并。未确认的
即时合入在重试前重新核验完整门禁；写入状态不明阻断后续合入，明确拒绝与已合入的收尾
失败只阻断本 PR。一次最多五次确认、等待不超过 60 秒、最多十个自动执行周期，并遵守
`Retry-After`。实现说明见
[收尾实施说明](../plans/pr-approval-recoverable-completion.md)。

### 多 Issue PR 与关闭排除

PR 可以引用多个同仓库 Issue，合入后只关闭明确由该 PR 完成的开放 Issue。

- 引用来自 PR 标题、正文中的 `#数字` 或本仓库 Issue URL，去重并排除 PR 编号与其他
  仓库链接；审核包的 `issues` 含全部引用的 Issue 及其需求、评论摘要与状态。
- 关闭排除记在 `pullRequest.keepOpenIssueNumbers`，支持
  `本 PR 不关闭也不修改 #301。`、`Do not close: #301, #308.`、`#301、#308 保持开放。`
  以及直接列出本仓库 Issue URL。声明含糊时返回 `human_decision`，先让维护者改成明确编号。
- 排除项是需求上下文：完整读取并绑定需求摘要，但不认领、不写交接评论、不改标签、
  不关闭。
- 其余开放 Issue 须已认领、无暂停或互斥标签；交付集合内的开放依赖可随本 PR 解除，
  集合外依赖先解除。已关闭 Issue 只作需求上下文，不重新打开。
- 每个交付 Issue 都要各自满足需求，不能用一个 Issue 的实现替代另一个的验收。正文、
  标题、非 App 评论或引用集合改变都会使需求摘要失效。
- 多 Issue、串行合并与 main 写入守卫对应策略 `sayhear-pr-review-gate:v11` 与报告
  `sayhear-pr-review-report:v4`。旧报告与人工绑定保留各自原版本，不能改标成当前版本。
  已签发收据的恢复允许列表为 v4、v5、v6、v8、v9、v10、v11；v7 只存在于源码，从未
  安装，也从未写过收据，不猜它的需求投影，位置不对的版本一律拒绝。
- `prepare` 返回 `issue_completion_pending` 时用固定 `scan --pr <数字>` 恢复合入后收尾。
  只开启 auto-merge 时继续等待并保持执行占用；必须回读 `merged=true` 与匹配的真实 App
  approval，才逐个关闭交付 Issue、清理标签并回读。失败不跳过其余 Issue，保留待收尾
  记录并报告失败项。该路径不重新批准或合入 PR。

## 集成模式与合并队列

独立 PR 并行开发和审查，controller 依次验证并合入；配置只来自 root-owned `config.json`。
当前启用 `serialized-merge`，`up-to-date-base` 保留为回退模式。

- 代码审查绑定 head、完整 diff/change digest、全部需求摘要、受保护路径、被审 workflow
  blob 与策略版本。历史 base 保存在报告中，不改写成当前 main。
- 浏览器挑战用 `reviewBinding=head-v2` 标识可复用授权：head、完整 diff、需求、受保护
  路径与 workflow blob 仍精确绑定，base 不参与摘要比较。旧 exact-base 挑战不能升级为
  head-v2 收据。
- main 前进本身不改写审查结论。controller 读取认证的 base 变化，确认 main 没有触及本 PR
  已改动的路径，也没有触及安全、依赖、迁移、策略等实质风险路径，就复用已有审查；比较
  被截断（≥250 commits 或 ≥300 files）、读取失败或风险不明时要求重新审查，并把该 PR
  报告为 `stale_base_review_risk`。head、需求或完整 diff 改变同样使旧审查失效。
- 审核报告的 `baseSha` 取自包内 `reviewContext.baseSha`：严格模式下是 PR base，
  `serialized-merge` 下是本次审查针对的 main SHA。`pullRequest.baseSha` 始终保留 GitHub
  原值。
- 轻量模式的 legacy root 授权额外绑定 `approvedBaseSha` 与精确 `approvedHeadSha`；缺少
  被审 main 基线的旧记录不能获得新模式权限。严格模式保留旧记录的原有解释。
- 集成证据绑定当前 main、被审 head 与 GitHub 当前 merge ref：controller 验证 merge commit
  的两个父提交，并检查可信 Validate artifact 的 checkout SHA、两个父 SHA、run ID 与
  attempt。旧 run 的绿色结果不能证明新集成；最终写入前再次回读 head/main/merge ref，
  变化时等待新证据。
- Validate 使用无特权的 `pull_request` 事件，固定 checkout 为事件的 `github.sha`，写入
  `pr-validate-source.json` 后与测试报告一起上传。workflow 监听 `labeled` 事件，App 用
  保留标签 `ci-int:<mergeSHA>` 请求当前集成跑一次；标签只请求 CI，不授予批准。
- 只有完整可信、已结束的旧 run 能触发集成刷新；排队、运行中、缺失、未知、缺 artifact
  或读取失败继续等待。刷新请求区分未发送、结果不确定、已确认三种状态，发送前持久化
  不确定状态，丢失响应后不重复触发；GitHub 明确拒绝的请求可以重试。单个 PR 的刷新错误
  单独记录，扫描继续处理其他 PR；当前集成失败不盲目重跑。
- `mergeable=false` 是真实冲突，交回原 PR 修复；未知状态继续等待。gate 不要求
  `mergeable_state=clean`，因为它自己就是 required check；最终合入动作要求
  `mergeable=true` 且状态为 `clean` 或 `behind`，不使用延后 auto-merge。
- `serialized-merge` 要求关闭 `requiresUpToDate`，并由 active Branch ruleset 的 `update`
  规则限制 main 写入，唯一 bypass 是审批 App `5270295`。controller 从
  `/rulesets?includes_parents=true` 枚举编号再读详情；规则或目标读不全就阻断。bypass
  名单能实时读到就按实时名单判（必须恰好等于 `[reviewAppId]`），读不到时看 root-owned
  见证，指纹相符才放行，不等转人工。不能把不可见名单当成空名单。
- controller 的仓库锁保护最终写入，main 写入守卫阻止外部写入者在验证后推进 main。
  GitHub merge API 没有 expected-base 参数，两者缺一不可；所有使用同一 App 的 main 写入
  程序都要遵守同一把锁。
- 带未完成 pre-merge deferral 的合入被拒绝，两个人工通道都不能绕到延后 auto-merge。
  签名 intent 保存原审查身份与请求结果；重试先确认实际合入，再对未合入操作重新读取
  授权、需求、保护、当前集成与 CI，不能只凭旧 intent 重发。
- 已确认合入但 Issue 收尾失败只保留本 PR 待办；能证明未合入且没有未决写入的拒绝只阻断
  本 PR。写入响应丢失、可能仍在合入、签名或状态不可读仍阻断后续合并。逐个处理 Issue，
  保留失败收据，不靠删收据解除占用。
- `merge-queue` 只用于识别历史状态，禁止激活：即使 GitHub 报告存在原生队列，也返回
  `merge_queue_not_supported`。当前 workflow 的 `merge_group` 只提供 `validate`，必需的
  `pr-review-gate` 没有 merge-group producer。

### 启用或回退 serialized-merge

顺序固定，启用永远最后一步，因为它的硬门禁要同时看到见证与关掉的 `requiresUpToDate`。
第 2 步到第 5 步之间不要停：只改一半仓库设置会让审批停在转人工，不会提前放行。

1. 安装通过审核的 root-owned controller（安装助手默认只换版、不动仓库设置），用固定
   `pr-approval-status` 回读 `policyVersion` 与 `controllerSha256` 确认换版。
2. 在 main 的经典 branch protection 里关闭 "Require branches to be up to date before
   merging"（`requiresUpToDate=false`）。
3. 新建一条 ruleset：Target 选 Branches 且包含 `main`，规则至少要有 Restrict updates
   （`update`），bypass 只放审批 App `sayhear-pr-review-gate`（app id `5270295`）。多一个
   bypass actor 就是多一个能在审批与合入之间推进 main 的写入者，gate 会判
   `main_writer_guard_bypass_actors`。
4. 运行固定 `pr-approval-status`，确认 `mainWriterGuard.readable === true`、
   `restrictsDefaultBranchUpdates === true`、`requiresUpToDate === false`。
   `bypassActorsEnumerated === true` 且 `bypassActorIds === [5270295]` 时直接进第 5 步，
   否则先做第 4b 步。
4b. 运行安装助手的见证模式，把当前 ruleset 指纹与设置页看到的 bypass 名单写进 root-owned
   见证文件。对照设置页确认 bypass 恰好只有审批 App 再确认写入。指纹不含 bypass 名单
   本身，靠 GitHub 每次改 ruleset 都刷新 `updated_at` 感知改动；见证只支持恰好一条覆盖
   main 的 update ruleset，多了先合并再见证。
5. 带启用参数再跑同一个助手，把 `config.json` 的 `integrationMode` 写成 `serialized-merge`，
   再回读 `policyVersion`、`controllerSha256` 与 `integrationMode`。启用前助手做写入前硬
   门禁：实时枚举通过或见证指纹相符才写，否则直接退出。
6. 回退：先把 `integrationMode` 改回 `up-to-date-base`，再删除第 3 步的 ruleset 并重新
   打开 `requiresUpToDate`；只做一半同样停在转人工。

## 合入前无法产出的检查

检查注册表只允许三个条目携带 `preMergeDeferral`：`prompt-budget:effective-config-diff`、
`provider:effective-config-diff` 和 `provider:affected-role-calls`。前两个需要部署后的
effective configuration，第三个需要付费 Live Provider 调用；后续阶段都是 `acceptance`。
这些记录表示未运行，不进入 `acceptedEvidenceIds`，也不授予额外调用预算。

- 收集器优先记录可信 `passed` 证据，无法产出时才记录 `kind: "deferred-before-merge"`。
  gate 逐字段比对注册表策略，其他检查不能延后。
- legacy root 通道通过其余门禁后返回 `merge_candidate_with_deferrals`，报告、check
  summary 与 App review 都列明未运行项与后续命令，App review 使用 `approve_deferred`；
  该标记不被 Issue completion 接受。
- 延后合入要求 GitHub `closingIssuesReferences`、PR 标题与正文以及完整 commit messages
  都没有 closing 信号；任一非空或不可读时返回 `human_decision`，原因是
  `deferred_merge_would_close_issues`。明确保持开放的 Issue 仍不写评论、不改标签、不关闭。
- legacy root 延后合入跳过 completion receipt 与全部 Issue 收尾，Issue 保持开放等待验收；
  合入前再次确认最新 PR 作者仍属于 legacy root 通道。
- browser 通道出现 deferral 时返回 `human_decision`，原因是
  `browser_deferred_merge_requires_human`；浏览器立即合入流程不支持延后检查，不能借此
  开启 auto-merge。
- 修改 `packages/data/migrations/` 或 `migrations-purge-marker/` 直接选中
  `migration:upgrade-compatibility`，只有可信 Validate run 中
  `tests/ci/migration-upgrade-compatibility.test.ts` 的完整、无 skip 证据才能满足它；
  迁移不在 deferral 白名单内。

## PR 落后 main

**`serialized-merge` 下 base 落后不是缺陷。** `prepare` 与 `submit` 都不会因为 base 落后
派发同步交接，也不会要求实现 Agent rebase，更不需要为了合入先同步 main。controller 在
最新 main 的组合上验证可信 CI，并在最终写入前回读 head/main/merge ref。唯一的例外是
main 触及本 PR 改动路径或实质风险路径时要求重新审查，见「集成模式与合并队列」。

以下交接只服务于回退到 `up-to-date-base` 的部署。此时 `prepare` 返回
`waiting_for_current_base` 与 `handoffRequired=true`：

- 用固定 `scan --pr <数字>` 完成 App 身份回写；这条路径不要求 Issue 已全部 `ongoing`，
  也不因旧 CI 排队而无限等待。先核验 Ready、同仓库 main、最新 head/base、引用集合与
  排除项；真实冲突与合入保留仍阻断。
- 每个未排除的开放 Issue 收到 PR 链接、head/base/当时 main SHA、同步 main、处理冲突、
  在新 SHA/base 上重跑可信 CI 与专项、接续原 PR 不另建 PR 的要求。明确保持开放的 Issue
  不写评论、不改标签；已关闭项不重新打开。
- 确认 App 评论后恢复 `ready-for-agent`、清除 `ongoing` 与互斥标签并回读。
  `ready-for-human`、`needs-info`、`needs-triage`、`wontfix` 只收到提醒，原标签保留，
  输出 `held_for_human` 与 `heldIssueNumbers`。交接不解除人工决定、暂停或集合外依赖。
- App 在标签回读后写完成标记，以 PR/head/base/main 去重；后续 Agent 已重新认领的
  `ongoing` 不被同一轮扫描释放。评论成功但标签失败可重试；逐项失败不跳过其余项，
  `base_sync_handoff_incomplete` 不能报告为已交接。
- 该路径不创建 request changes review，不增加三轮代码修改失败计数，也不批准、合入或
  直接修改 PR 分支。

真实代码冲突走冲突交接，不要求维护者改仓库设置：`mergeable=false` 时把冲突交回原 PR
修复，合入保留与暂停优先。

交接评论已有、完成标记缺失且 Issue 只有 `ongoing` 时，无法区分旧占用与新认领，保留
占用并报告未完成交接，等待人工核实；main 再前进时，已交接后被 Agent 重新认领的 Issue
只收到提醒，`ongoing` 保留。标签变更函数也回读人工状态，遇到新人工标签停止。

## 大 PR 完整 diff 取证

- 普通文本 PR 从固定 base/head SHA 的 compare 接口读取 unified diff，逐项校验文件头、
  状态、index SHA、hunk 数量及增删计数。没有 hunk 的修改回退到 tree/blob 核验。
- 大 PR 或 diff 无法证明完整时，交叉核对分页 files、compare 的 merge-base 与固定 commit
  tree。要求树未截断、文件数与 `changed_files` 相符、路径去重，完整树差异与 manifest
  覆盖集合完全一致。缺失路径、mode 或 SHA 不匹配都阻断。
- 内容只来自固定 blob SHA 的原始数据接口，校验 Git blob SHA 与字节数；按旧/新完整内容
  生成 full-file patch，包括可正反应用的 Git binary literal patch。不能把
  `Binary files differ` 摘要或 per-file `patch` 字段当作完整内容。接口依据见
  [GitHub blob API](https://docs.github.com/en/rest/git/blobs#get-a-blob) 与
  [GitHub tree API](https://docs.github.com/en/rest/git/trees#get-a-tree)。
- `diff.source` 为 `github-diff`、`github-blobs` 或 `unavailable`，并记录 merge-base、
  内容大小、二进制数量、预期文件数与失败原因。fallback 的完整文本参与 `diff.digest`
  与修改轮次摘要；任何二进制内容改变都使摘要改变。
- 上限为 3000 个改动文件、单 blob 8 MiB、旧/新内容合计 64 MiB、patch 128 MiB、6 个
  并发 blob 读取。改变限额须经过 gate 改动授权。变更中的 submodule 不自动当作完整 diff。
- `artifacts/pr-approval/git-blobs/` 是可删除的内容缓存，不能授予审批。每次都按认证 tree
  的 SHA 与大小重新验证，拒绝符号链接与非普通文件，有界读取；缓存污染时重新从 API 取
  内容。缓存写入失败不改变已验证的证据。controller 不调用工作区 Git，不 checkout、
  不执行被审代码、不安装依赖。
- 全部内容读取后再次回读 PR head/base/file count。漂移、截断、下载超限、manifest 读取
  失败或内容校验失败仍保持 `incomplete_diff`。已能读取 PR/Issue 上下文时，`prepare`
  生成带原因的诊断包，包中 `diff.complete=false`，不能提交批准。

大 PR 取证完整只表示 diff 可被完整复核，不代表代码审核、CI、迁移或生产验收通过。

## controller 修复与 UI 证据标准

gate 的 UI 证据来源与 `scripts/daily-release-validation.ts` 共用同一份路径规则，不会
产生 `RELEASE_CHECKS` 中不存在的 check id。

Luke 已确认接受以 `ui:portal-smoke` 取代设计稿所述的桌面与移动端浏览器交互证据。该标准
只在 Portal UI 路径（`apps/web/app/**` 中非 `api/` 的 `.tsx/.css/.scss`）上追加检查；
`apps/web/src/**` 是 handler 与组合根，不触发 UI 证据。这是产品决定，降低了 UI 证据
强度；仓库目前没有浏览器 E2E runner 支撑更强的结论。

## 人工授权

### 版本标识

当前策略 `sayhear-pr-review-gate:v11`，报告 `sayhear-pr-review-report:v4`，浏览器能力
`browserApprovalVersion=sayhear-pr-browser-approval:v1`。构建身份另记录
`sourceDiffSha256`：源码包含 main 之上的未提交改动时，只有 `sourceCommit` 不能证明安装版
包含这些变更。

### 人工授权的两个通道

人工授权按 PR 作者分流，两条通道互不通用。作者与审核者身份按 PR 与 review payload 里的
固定数字 ID、login 与类型三元组同时核对；App bot 与 owner 身份另按 `/users` 回读比对，
只用 login 判断会在账号重建后误授权。

- `luke-agents`（id 342173548，User）作者的 PR 只走浏览器通道。`prepare` 先在本机签名
  冻结上下文，再让 Luke（`lukemyself-hub`，id 236989142，User）在 GitHub 当前 head 上
  直接提交 `APPROVED` review；不要求把口令抄进 review body。
- `lukemyself-hub` 的历史 PR 继续用管理员写入 root `config.json` 的
  `humanReviewAuthorizations`。未知作者不获得任何人工授权。
- 浏览器通道绝不用 root 记录兜底：`luke-agents` 的 PR 即使在 root 记录里出现，也不进入
  受保护路径的允许列表。

冻结上下文包含仓库与 PR 的数字及 node 身份、已认证的作者与审核者、精确 head/base、完整
`diff.digest`、`requirementDigest`、受保护路径清单，以及 head 候选的 Validate workflow
blob。`prepare` 在任何 CI 结果之前冻结，避免 workflow 改动与绿色 CI 互证；同一上下文
重复 `prepare` 幂等。`serialized-merge` 的 head-v2 授权另按「集成模式与合并队列」核验
main 风险。

浏览器批准的判定规则：

- 挑战保存审核者最新已提交 review 的水位（id 与提交时间）。只有严格晚于 `frozenAt`、
  id 大于水位、且时间严格递增的审核才能绑定；同一秒、时钟回拨或之前已出现过的批准
  一律不绑定。
- 每次读取都重新计算当前上下文并回读实时 review。上下文漂移、新需求、缺失去除的挑战
  都会重置 epoch 并作废旧 receipt；上下文恢复后旧 receipt 也不会复活。
- Luke 在任意 head 上最后提交的 review 必须是 `APPROVED`；其后的 `COMMENTED`、
  `CHANGES_REQUESTED`、`DISMISSED` 都拒绝，`PENDING` 忽略。审核者元数据、时间戳或顺序
  异常按失败关闭处理：清空本地 epoch，把该 PR 记为 blocked 等待维护者复核，不静默当作
  批准，也不静默降级成普通拒绝。该阻塞只作用于该 PR，同轮其余 PR 继续处理；GitHub 不
  提供删除已提交 review 的接口，因此这个 PR 需要维护者处理（通常是改用新 PR 重新走流程），
  自动化只如实汇报，不猜恢复路径。
- 需求摘要排除全部顶层 review 记录（正文、状态、commit），inline review 评论继续计入。
  批准本身不改变需求摘要，因而不会因批准而失效。
- 授权只覆盖冻结时的精确路径与 workflow blob，不解锁产品、隐私、迁移、新能力或绕过 CI
  的风险标记。浏览器通道的 `noRuntimeImpact` 恒为 false，不从 `APPROVED` 推断；需要该
  豁免时按 root 记录逐路径精确绑定，而 root 记录只对 `lukemyself-hub` 作者的 PR 生效。

### 浏览器通道的合入与收尾

浏览器通道只发起绑定已审 head 的立即合入，不开启 GitHub 延迟 auto-merge。App 审批仍会
写入以满足分支保护；延迟 auto-merge 会让 Luke 事后撤回 review 时，App 审批独自占住
分支保护的审批位，从而在人工授权已失效后仍然合入。

- 未达到可合入状态时只等待并报告：不开启 auto-merge，也不写签名合入意图，让下一次
  `scan` 在状态变干净时重新发起绑定 head 的立即合入。root 通道保留原有 auto-merge 语义。
  当缺少的浏览器批准是唯一的人工决定时，agent PR 既不合并也不中断整轮扫描，`submit` 与
  `scan` 返回 `awaiting_verification` 并说明需要当前 head 上的实时人工批准，且不写 Issue
  交接；若同时还有暂停、分诊、依赖或关闭声明等人工决定，仍按原规则交回并如实报告。
  未触及受保护路径的 agent PR 不需要浏览器批准，直接按绑定 head 的立即合入处理。
- 签名合入意图记录浏览器来源与 provenance（`humanChannel`、`humanReviewId`、epoch）。
  写 Issue 前再次回读实时绑定的人工 review，确认它仍是绑定 id、绑定 head 上最后提交的
  `APPROVED`，并重新推导需求摘要、核对合入提交与绑定 head；其余冻结字段按 head 绑定，
  不重复采集 diff。合入后若 Luke 撤回 review，记录转入 `needs_attention` 并报告该撤回，
  不重复合入、不写 Issue；合入是否真的落地以 GitHub 实时状态为准。
- 最终回读与 GitHub 合并请求之间仍存在不可消除的竞态：回读通过后 reviewer 仍可能在毫秒
  级窗口内撤回。该窗口只能靠立即合入与合入后复查收窄，不能完全消除。
- 已签名旧版本合入意图按其原 policy 与当时的摘要算法恢复，兼容仅限已存在的 signed
  receipt，不改标、不重新批准；新提交只接受当前策略与 report v4。

PR 需求摘要只排除身份同时匹配 Vercel Bot actor `35613825`、login、Bot 类型、GitHub
App `8329` 且正文以 `[vc]: #` 开头的部署状态评论。人工评论、其他 Bot 评论、非状态正文
及全部 Issue 评论继续纳入需求摘要；部署评论随每次构建更新，不作为需求变更。

## 当前入口

```sh
pnpm pr:review-gate:dry-run -- --input <snapshot.json>
```

命令读取 JSON 快照，输出以下结果之一：

- `merge_candidate`：快照通过当前确定性规则。它不是 GitHub 批准、required check 或合入授权。
- `merge_candidate_with_deferrals`：legacy root 快照通过其余规则，但列明的检查未在合入前运行。
- `request_changes`：审核报告发现需要修改的问题。
- `awaiting_verification`：版本、SHA、权限或验收证据不足。
- `human_decision`：需求、产品、权限、迁移或保护规则需要人决定。

此命令不访问 GitHub，不执行 PR 代码，不调用 shell 命令，不创建 review/check，不回写
Issue，也不合入 PR。退出码 0 只表示快照可读取并完成评估；调用方必须读取 JSON 中的
`outcome`。

生产控制器只允许通过 `/Library/Application Support/SayHear/PRApproval/` 下的 root-owned
固定启动器调用：`pr-approval-status`、`pr-approval-prepare`、`pr-approval-scan`、
`pr-approval-submit`、`pr-approval-configure`。`prepare` 只读取状态并写本地审核包；`scan`
可额外创建受控的 `pr-review-gate` 运行中检查；`configure` 仅由本机管理员在安装时写入 App
安装配置。控制器启动时逐一核验五个启动器、bundle 与 Node 均位于受保护目录；启动器固定
Node 与命令、清理继承环境变量，并拒绝任意子命令。不要用工作区源码、`pnpm pr:approval`
或 PR 提供的脚本访问 App 凭证。

## Gate 规则

- 报告绑定仓库、PR、head SHA、base SHA、策略版本，以及全部引用 Issue 的标题、正文和非
  App 评论摘要。只改标签或 App 自身回写不改变需求摘要。
- 仅接受完整 diff、非 Draft PR、同仓库 PR，以及完整的关联 Issue 集合。交付集合的开放
  Issue 须已认领，集合外依赖须解除。`serialized-merge` 下 PR base 不要求等于最新 main；
  真实冲突、未关闭的 `requiresUpToDate` 或未通过的 main 写入守卫阻断合入。
  `merge-queue` 暂不可激活。
- 每个未排除的开放 Issue 必须处于 `ongoing`，不能同时带 `ready-for-agent`、人工处理、
  待补充或暂停状态。
- PR Validate 证据必须对应当前 head、base 与 merge SHA，并匹配可信 workflow 文件摘要、
  GitHub Actions App、仓库和 `pull_request` 事件。
- 每项必要证据都必须显式为 `passed`；`skipped`、`cancelled`、`neutral`、`planned` 和
  `out-of-scope` 均阻断。
- `scripts/daily-release-validation.ts` 决定行为专项；gate 不用它的退出码代替验收结果。
- 涉及审批规则、CI、产品定义、删除测试、完整能力验收或生产新能力启用时转人工。UI 变化
  按上一节的标准追加 `ui:portal-smoke`。数据库迁移要求可信、无 skip 的升级兼容专项证据。
- 只有同时满足以下条件才生成 `merge_candidate`：main 保护规则可读；base 满足当前集成
  模式（`serialized-merge` 要求无真实冲突、`requiresUpToDate=false`，且 main 写入守卫的
  实时名单或见证恰好只给审批 App 一个 bypass）；过期 review 失效；管理员强制执行；恰好
  一个审批名额；以及精确匹配来源的 `validate` 与 `pr-review-gate` 两项 required checks。
  一旦存在限制 main 写入的 ruleset，这条 App-only 证明在所有模式下都要过。
- 所有必要证据必须来自同一个 PR Validate workflow run 与 attempt。快照采集器须证明它们是
  当前最新 run；gate 本身不连接 GitHub，也不提供全仓合入锁。

## Issue 标签交接

- Gate 因 PR Validate 处于 `queued`、`in_progress`、`missing` 或 `unknown` 而返回
  `awaiting_verification`，或审核上下文报告 `repository_merge_busy`、
  `github_context_unavailable`、`stale_review`、`policy_version_mismatch`、
  `incomplete_diff` 等可重试状态时，审核仍在等待，Issue 保持 `ongoing`，不写终态评论。
  `trusted_identity_unconfigured`、`review_author_unavailable`、
  `branch_protection_unreadable`、`production_deploy_behavior_unknown` 等阻断属于终态，
  先回写评论，再按 `ready-for-agent` 交接，不让 `ongoing` 长期占用 Issue。
- 其他终态非批准结果（`request_changes`、终态 `awaiting_verification` 或
  `human_decision`）必须先确认该 Issue 的评论已写入，再对每个未排除的开放 Issue 设置
  `ready-for-agent`、移除 `ongoing` 与其他互斥分诊状态，并回读最终标签。更新失败时不能
  声称已完成交接。评论要求维护者决定时，Agent 先等待决定，不自行替代。Agent 接续时检查
  依赖、暂停记录与关联 PR；恰好一个开放关联 PR 时继续原 PR 与分支，不创建重复 PR，
  多个关联 PR、依赖或暂停仍阻断。本仓库不含 Issue 调度器，因此这条接续行为是外部调度器
  的要求，不能仅凭本文档声称已经实测。
- App 已提交 `APPROVED` 且 GitHub 回读确认 PR 实际合入后，逐个关闭未排除的开放 Issue，
  清理 `ongoing` 与互斥分诊状态并回读确认；类别标签如 `bug` 保留。只启用 auto-merge 时
  继续等待，保持执行占用，不提前关闭。

## 快照信任边界

模型输出、PR 内容、Issue 正文与 CI artifact 都是不可信输入。解析器只把它们当作 JSON
数据，不执行内容。可信控制器自行从 GitHub API 读取 PR、Issue、保护规则与 workflow run，
验证 artifact 后再调用 gate；不能让模型填写 GitHub App 身份、检查来源或保护状态。
controller 源码位于 `scripts/pr-approval-controller.ts`，受保护 bundle 只依赖 Node 内置
模块。密钥只从 macOS Keychain 读取，配置文件位于 root-owned 安装目录。

App ID、installation ID、slug 与生产授权标记存于 root-owned 本机配置，不是密钥。可信
策略同时固定 Actions App 与 `pr-validate.yml` blob SHA。GitHub App 私钥只存于 macOS
Keychain，不得传入模型进程、PR checkout 或普通 CI。controller 使用
`service=SayHear PR Approval GitHub App`、`account=lukemyself-hub/SayHear` 查找当前用户
Keychain；macOS CLI 可能以十六进制文本返回条目数据，controller 会先解码并校验 PEM。

## 定时运行规则

- 每次先读取 status 与 prepare；认证、保护或部署核验失败则停止写入。
- 合入后确认实际 merged 与 merge SHA，并清理已关闭关联 Issue 的 `ongoing`。
- 核验对应 main merge SHA 的 Production Deployment 与 smoke；失败或状态未知时停止后续
  合入。
- 每小时任务使用现有 Coding Plan 与精确启动器规则，无额外 API key；无变化不通知。
- 调度先 prepare，再仅对无人工保留且符合条件的 PR 调用 scan/submit，仍逐个验证全部门禁。

## 首版专项证据限制

controller 当前只从同一次可信 PR Validate 的 Vitest 报告采集专项。
`prompt-budget:effective-config-diff`、`provider:effective-config-diff` 与
`provider:affected-role-calls` 是独立配置/Provider 工具，不是 Vitest 测试，尚没有可信
producer artifact 的接入路径。需要这些专项的 PR 会保持待验证；重复运行 Vitest 或人工
路径授权不能满足它们。后续应在可信 workflow 中接入 producer 输出，绑定 head/base/merge
SHA 与配置身份，再由 controller 校验 artifact。首版只开放现有证据可满足的普通改动，
不声称支持这些 Provider/配置变更的自动合入。
