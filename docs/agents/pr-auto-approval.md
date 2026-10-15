# PR 自动审批 gate

## 状态

### 审批工具链路径的枚举与安装顺序

#352 在浏览器通道与合入前延后检查之上收窄了 gate 的「影响未定位」判定：release
planner 用 `NON_RUNTIME_TOOL_PATHS` 枚举了不配置部署运行时的路径，包括离线评估
工具，以及 PR 审批工具链本身的 controller、gate、planner、build、verifier、
其测试、夹具和文档。改动只落在该集合内时 `requiresImpactLocation=false`，
只要求固定 PR CI 基线；显式影响声明、混合改动和集合外路径继续按原规则定位，
这些路径也不再触发 `provider-migration` 提示。

判定在已安装的 controller 内运行，源码可见不等于生效：必须构建并安装新 bundle
之后 gate 行为才会改变。合并顺序保持 #351 先合入，再让 #352 以新 main 为 base
合入。安装版若不含本枚举，#351（Issue #350）与 #352 自身都会停在
`impact_not_located`。

源码验证：6 个套件 327 项通过，构建后的 bundle 内 280 项通过，`tsc -p
tsconfig.json` 与 `tsc -p tsconfig.g1-tools.json` 均无错误。用同一源码重算
#351 的冻结审核上下文，`requirementDigest` 复现 `b66c6691…`，受保护路径仍是
同样的 7 个文件；安装本版本不会作废 Luke 在 head `b028f7df` 上已提交的浏览器
批准。安装后的固定 `status` 回读仍是判断是否生效的唯一依据。

### 迁移专项证据候选

#350 的独立候选将策略标识更新为 `sayhear-pr-review-gate:v7`，报告结构保持
`sayhear-pr-review-report:v3`。该候选从 main 构建，尚未完成受控安装。
v5、v6 保留给其他审批工具改动，安装顺序须协调，不能用此候选覆盖独立浏览器审批能力。
源码保留 `sayhear-pr-diff:v2`、`sayhear-pr-base-sync:v1` 和可恢复合并收尾。
安装完成与否须回读固定 status、bundle 哈希及实际功能，不能根据源码版本判断。

两种迁移目录 `packages/data/migrations/` 与 `packages/data/migrations-purge-marker/`
强制选择 `migration:upgrade-compatibility`。专项由统一 release planner 注册，
gate 和 collector 都读取该 planner；窄影响声明不能删掉它。现有
`purge:full-restore-drill` 继续必需。

collector 从同一次可信 PR Validate 的 `vitest-report.json` 收集专项。
报告须实际覆盖 `tests/ci/migration-upgrade-compatibility.test.ts`，测试文件及其非空
assertion 列表必须全部 passed。空报告、空 assertion、缺失、失败、跳过、身份不符、
重复记录或 artifact 覆盖不符都不能批准。证据继续绑定 repository、App、workflow
版本、head/base/merge SHA、run/attempt 和 artifact digest。

此候选只开放上述证据核验路径，替换 v4 的无条件迁移终止。真实 PostgreSQL drill
将在 #349 接续新 main 后实现，须覆盖 base 迁移后升级 head、既有数据约束、
升级后 schema 与 fresh head 安装的比较，并说明新旧程序兼容和 forward-fix 边界。
缺少该测试时迁移 PR 继续待验证。本候选的协议回归测试不代表真实迁移兼容性已通过。
审批策略本身仍须人工审核；破坏性迁移、产品及权限边界仍转人工。
Provider/配置专项的证据限制继续有效，没有新增 deferral 或豁免。

### 可恢复合并收尾

#339 将合并意图与 Issue 收尾分开持久保存。签名意图在请求合并前落盘，绑定已审
PR、仓库、head、base、App approval 和交付 Issue。已确认合入后只补 Issue 收尾，
不重复批准或合并。v10 对未确认的即时合入重新核验完整门禁后才重试；写入状态
不明仍阻断后续合入，明确拒绝与已合入的收尾失败只阻断本 PR，详见集成模式。
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
- 多 Issue 版本安装时审批策略为 `sayhear-pr-review-gate:v8`，报告结构为
  `sayhear-pr-review-report:v4`。旧报告与人工绑定保留各自原版本，不能用于新审批，
  也不能改标成当前版本号。
- 串行合并修复把审批策略提高到 `sayhear-pr-review-gate:v10`，报告结构仍是
  `sayhear-pr-review-report:v4`，并加入 main 写入守卫。已签发收据的恢复允许列表为
  v4、v5、v6、v8、v9、v10、v11。v7 只存在于源码与审核记录中，从未安装，因此从未写过收据；
  不猜它的需求投影，位置不对的版本一律拒绝，而不是按最近的版本套用。
- v11 给 main 写入守卫加上 root-owned 见证（attestation）：GitHub 不把 bypass 名单
  返回给审批 App token，v10 要求的实时枚举在这类仓库里永远不成立。见证记录 Luke
  在设置页亲眼看到的 bypass 名单和当时 ruleset 指纹；之后每次运行重读实时指纹，
  相等才放行，不等（任何改动，包括改 bypass 名单）直接转人工。见证没有过期时间：
  重新见证只发生在 ruleset 真被改过之后，改 ruleset 本来就是少见且故意的动作。
- `prepare` 返回 `issue_completion_pending` 时，使用固定 `scan --pr 数字` 恢复合入后
  收尾。只开启 auto-merge 时继续等待并保留执行占用；必须回读 `merged=true` 和匹配
  的真实 App approval，才逐个关闭交付 Issue、清理标签并回读。失败不跳过其余 Issue，
  保留待收尾记录并报告失败项，下次 scan 重试。记录只是重试线索，不能替代 GitHub
  认证身份、已审需求摘要和实际合入状态。该路径不重新批准或合入 PR。

### 集成模式与合并队列

Luke 于 2026-10-14 选择轻量串行集成模式：独立 PR 并行开发和审查，controller
依次验证并合入。配置只来自 root-owned `config.json`。默认
`integrationMode=up-to-date-base` 保留精确 base 规则；发布本 PR 不启用新模式，也不
修改仓库保护设置。v10 修复 v9 的审批复用、集成 CI 触发与中断恢复问题，旧 v9
安装包不能用于启用轻量模式。

- `serialized-merge` 的代码审查绑定 head、完整 diff/change digest、全部需求摘要、
  受保护路径、被审 workflow blob 与策略版本。历史 base 保存在报告中，不改写成
  当前 main。main 前进时，controller 完整读取认证的 base 变化，确认没有触及
  PR 文件或安全、依赖、迁移、策略等实质风险路径，才复用已有审查；截断、读取失败
  或风险不明都要求重新审查。head、需求或完整 diff 改变也使旧审查失效。
- 审核报告的 `baseSha` 从包内 `reviewContext.baseSha` 取得。严格模式下它仍是
  PR base；v10 轻量模式下它是本次审查针对的 main SHA。`pullRequest.baseSha`
  始终保留 GitHub 原值。这样实质 main 风险可以通过重新审查当前集成解除，无须
  为了改变报告身份而强制提交一次 rebase。
- 浏览器新挑战用 `reviewBinding=head-v2` 标识可复用的授权。只有 controller 已证明
  main 变化安全时，才允许比较忽略 base；作者、审核者、head、完整 diff、需求、
  路径与 workflow blob 仍精确绑定。旧 exact-base 挑战不能升级为 head-v2 收据。
- 轻量模式的 legacy root 授权额外绑定 `approvedBaseSha` 与精确
  `approvedHeadSha`。缺少被审 main 基线的旧记录不能获得新模式权限；main 引入
  实质风险时，重新审查并安装新的 root 绑定。默认严格模式保留旧记录的原有解释。
- 集成证据始终绑定当前 main、被审 head 和 GitHub 当前 merge ref。controller
  验证 merge commit 的两个父提交，并检查可信 Validate artifact 的 checkout SHA、
  两个父 SHA、run ID 与 attempt。旧 run 的绿色结果不能证明新集成。最终写入前再次
  回读 head/main/merge ref，变化时等待新证据。
- Validate 使用无特权的 `pull_request` 事件，固定 checkout 为事件的 `github.sha`，
  写入 `pr-validate-source.json` 后与测试报告一起上传。workflow 增加 `labeled`
  事件，App 用保留的 `ci-int:<mergeSHA>` PR 标签请求一次当前集成运行。
  标签只请求 CI，不授予批准。每次添加 PR 标签都会运行完整 Validate，这是保留
  单一 required check 与现有事件来源的成本。
- 只有完整可信的已结束旧 run 能触发集成刷新。排队、运行、缺失、未知、缺 artifact
  或读取失败继续等待。刷新请求区分未发送、发送结果不确定、已确认发送三种状态。
  未发送或 GitHub 明确拒绝的请求可以重试；发送前持久化不确定状态，丢失响应后
  不能因为尚未发现 run 就重复触发。单个 PR 的刷新错误单独记录，扫描继续处理其他
  PR。当前集成失败不会盲目重跑。
- `mergeable=false` 是真实冲突，交回原 PR 修复；未知状态继续等待。gate 不要求
  `mergeable_state=clean`，因为它自己就是 required check，尚未变绿时 GitHub 可以
  正常报告 `blocked`。最终合入动作仍要求 `mergeable=true` 且状态为 `clean` 或
  `behind`，不使用延后 auto-merge。
- `serialized-merge` 必须关闭 `requiresUpToDate`，并以 active Branch ruleset 的
  `update` 规则限制 main 写入，唯一 bypass 是审批 App `5270295`。controller 从
  `/rulesets?includes_parents=true` 枚举编号，再读每条详情。规则、目标条件读不全
  就阻断。bypass 名单能实时读到就按实时名单判（必须恰好等于 `[reviewAppId]`）；
  读不到时看 root-owned 见证：实时指纹与见证指纹相等才放行，不等就转人工。
  不能把不可见列表当成空列表。默认严格模式也拒绝不可读或格式错误的 bypass 列表。
- controller 的仓库锁保护最终写入；main 写入守卫阻止外部写入者在验证后推进 main。
  GitHub merge API 没有 expected-base 参数，所以两者缺一不可。所有使用同一 App
  的 main 写入程序也必须遵守同一把锁。
- 轻量模式拒绝带未完成 pre-merge deferral 的合入，两个人工通道都不能绕到延后
  auto-merge。签名 intent 保存原审查身份与请求结果。重试先确认实际合入，再对
  未合入操作重新读取授权、需求、保护、当前集成和 CI，不能只凭旧 intent 重发。
- 已确认合入但 Issue 收尾失败只保留本 PR 的待办；能够证明未合入且没有未决写入
  的拒绝只阻断本 PR。写入响应丢失、可能仍在合入、签名或状态不可读仍阻断后续
  合并。逐个处理 Issue，保留失败收据，不能删除收据来解除占用。
- `merge-queue` 配置仍能被解析以识别历史状态，但本交付禁止激活。即使 GitHub
  报告存在原生队列，也返回 `merge_queue_not_supported`。当前 workflow 的
  `merge_group` 只提供 `validate`，必需的 `pr-review-gate` 没有 merge-group producer，
  不能把 enqueue 接口和一个 workflow trigger 当作完整队列支持。

#### 启用 serialized-merge 的操作顺序（Luke 的仓库设置）

先发布本 PR，再安装通过审核的 v11 bundle，最后做仓库设置、见证并启用新模式。
已安装的 v10 保持默认严格模式；不能用旧助手启用轻量模式。规则集详情（规则、
目标、指纹）必须可读；bypass 名单实时可读就走实时判定，读不到就走见证判定，
两者都立不起来时保留阻断。

另有两个前提。其一，`.github/workflows/pr-validate.yml` 的收据改动必须先在 main 上
生效，否则 head-bound 模式要求 `pr-validate-source.json`，而这个 workflow 还不产出它，
证据会全部不成立。其二，审批绑定被审当时的 Validate workflow blob，所以 main 改动该
文件之后，落后 base 的 PR 需要重新审查一次以绑定新 blob。这不是代码冲突，而是“CI
管线本身变了，要重新确认一次”；`up-to-date-base` 下同类情况表现为要求 base 等于
main，代价相同。

旧 run 如果没有新的 checkout 收据，controller 会等待，不把缺证据解释成可以重复
派发。启用时仍有这种旧候选，维护者须先用一次 PR 标签事件生成新收据；之后
main 单独前进由 controller 按可信终态旧 run 自动请求刷新。保留标签只作派发记录，
不能人工把它改成 CI 已通过的证据。

1. 先安装本交付的 root-owned controller（安装助手默认只换版、不动仓库设置）。
   此时 `config.json` 仍没有 `integrationMode`，行为与现在完全相同
   （`up-to-date-base`），只是修好了 ruleset 读取，并让 `status` 开始报告 main
   写入守卫。装完用固定 `pr-approval-status` 回读 `policyVersion` 与
   `controllerSha256` 确认换版完成。
2. 在 main 的经典 branch protection 里关闭 "Require branches to be up to date
   before merging"（`requiresUpToDate = false`）。head-bound 审批不再要求 base
   等于 main，这是 GitHub 接受落后 base 合并的前提。
3. 新建一条 ruleset：Target 选 Branches、包含 `main`，规则至少要有 "Restrict
   updates"（`update`），bypass 列表只放审批 App `sayhear-pr-review-gate`
   （app id `5270295`）。不要放 Repository admin、团队、Luke 本人或其他 App：
   多一个 bypass actor 就是多一个能在审批与合入之间推进 main 的写入者，gate 会
   判为 `main_writer_guard_bypass_actors`。
4. 运行固定 `pr-approval-status`，必须同时看到 `mainWriterGuard.readable === true`、
   `restrictsDefaultBranchUpdates === true`，并且 `branchProtection.requiresUpToDate
   === false`。bypass 名单分两种情况：`bypassActorsEnumerated === true` 且
   `bypassActorIds === [5270295]`，直接进第 5 步；`bypassActorsEnumerated === false`
  （GitHub 不把名单返回给 App token，设置正确也会这样），走第 4b 步见证，
   不要跳过见证直接进第 5 步：没有见证时 gate 会把 `serialized-merge` 判为
   `main_writer_guard_bypass_actors_unreadable` 转人工。第 2 步关掉 `requiresUpToDate`
   之后、第 5 步写入新 `integrationMode` 之前，gate 在 `up-to-date-base` 下会因
   `branch_protection_incomplete` 转人工，这段时间审批不会通过（fail-closed，
   不会合入任何东西）。所以第 2 到第 5 步要一次做完，中间不要停：只改一半仓库
   设置只会让所有审批停在转人工，不会提前放行。
4b. 运行安装助手的见证模式（随安装包交付，见交付记录），把当前 ruleset 指纹和
   设置页看到的 bypass 名单写进 root-owned 见证文件。助手会打印实时指纹、规则与
   目标，请对照设置页确认 bypass 名单恰好只有审批 App 再确认写入。指纹里不含 bypass
   名单本身，靠 GitHub 每次改动 ruleset 都刷新 updated_at 来感知改动（本仓库已实测：
   ruleset 建后一次保存就推高了 updated_at）。见证没有过期时间；之后改过 ruleset
   （加规则、改目标、改 bypass 名单都会变指纹），下次运行会转人工并提示重新见证。
   见证模式只支持恰好一条覆盖 main 的 update ruleset，多了就转人工，先合并不必要的
   ruleset 再见证。
5. 再次运行同一个安装助手并带启用参数，把 `config.json` 的 `integrationMode`
   写成 `serialized-merge`，再用固定 `pr-approval-status` 回读 `policyVersion`、
   `controllerSha256` 与 `integrationMode`。启用前助手先做写入前硬门禁：实时枚举
   通过或见证指纹相符才写，否则直接退出。`scripts/pr-review-gate.ts`、
   `scripts/pr-approval-controller.ts` 属受保护路径，走当时的审批通道。
6. 回退：先把 `config.json` 的 `integrationMode` 改回 `up-to-date-base`，再删除
   第 3 步的 ruleset 并重新打开 `requiresUpToDate`；只做一半同样会停在转人工。

### 合入前无法产出的检查

检查注册表只允许三个条目携带 `preMergeDeferral`：
`prompt-budget:effective-config-diff`、`provider:effective-config-diff` 和
`provider:affected-role-calls`。前两个需要部署后的 effective configuration，
第三个需要付费 Live Provider 调用；后续阶段都是 `acceptance`。这些记录表示未运行，
不会进入 `acceptedEvidenceIds`，也不授予额外调用预算。

- 收集器优先记录可信 `passed` 证据，无法产出时才记录
  `kind: "deferred-before-merge"`。gate 逐字段比对注册表策略，其他检查不能延后。
- legacy root 通道通过其余门禁后返回 `merge_candidate_with_deferrals`。报告、
  check summary 和 App review 都列明未运行项与后续命令，App review 使用
  `approve_deferred`。该标记不被 Issue completion 接受。
- 延后合入要求 GitHub `closingIssuesReferences`、PR 标题与正文以及完整 commit
  messages 都没有 closing 信号。任一非空或不可读时返回
  `human_decision`，原因是 `deferred_merge_would_close_issues`。明确保持开放的
  Issue 仍不写评论、不改标签、不关闭。
- legacy root 延后合入跳过 completion receipt 和全部 Issue 收尾，Issue 保持开放，
  等待验收。合入前再次检查最新 PR 作者仍属于 legacy root 通道。
- browser 通道出现 deferral 时返回 `human_decision`，原因是
  `browser_deferred_merge_requires_human`。现有 browser 立即合入流程不支持延后检查，
  不能借此开启 auto-merge。
- 修改 `packages/data/migrations/` 或 `migrations-purge-marker/` 会直接选中
  `migration:upgrade-compatibility`。只有可信 Validate run 中
  `tests/ci/migration-upgrade-compatibility.test.ts` 的完整、无 skip Vitest 证据才能
  满足它；迁移不在 deferral 白名单内。

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
- `serialized-merge` 下 base 落后本身不是缺陷，`prepare`
  与 `submit` 都不会因为 base 落后就派发这条 base-sync 交接，也不会要求实现 Agent
  rebase；base-sync 交接只服务于仍使用 `up-to-date-base` 的部署。其它非阻塞结果
  （证据缺失、`human_decision` 分诊等）仍按通用规则把 Issue 交回，真实冲突走
  `merge-conflict` 交接。

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

#### 版本标识

新审批策略版本为 `sayhear-pr-review-gate:v10`，报告结构为
`sayhear-pr-review-report:v4`。v9 是本次修复前的在位版本，v4、v5、v6、v8 是更早的已签发版本；
已签发收据的恢复允许列表为 v4、v5、v6、v8、v9、v10。`status`、构建身份与审核包保留能力标识
`browserApprovalVersion=sayhear-pr-browser-approval:v1`。构建身份另记录
`sourceDiffSha256`：源码包含 main 之上的未提交改动，只有 `sourceCommit` 不能
证明安装版包含这些变更。

#### 人工授权的两个通道

人工授权按 PR 作者分流，两条通道互不通用。作者与审核者身份按 PR 与 review
payload 里的固定数字 ID、login 与类型三元组同时核对；App bot 与 owner 身份另按
`/users` 回读比对。只用 login 判断会在账号重建后误授权。

- `luke-agents`（id 342173548，User）作者的 PR 只走浏览器通道。`prepare` 先在
  本机签名冻结上下文，再让 Luke（`lukemyself-hub`，id 236989142，User）在 GitHub
  当前 head 上直接提交 `APPROVED` review。不要求把口令抄进 review body。
- `lukemyself-hub` 的历史 PR 继续用管理员写入 root `config.json` 的
  `humanReviewAuthorizations`。未知作者不获得任何人工授权。
- 浏览器通道绝不用 root 记录兜底：`luke-agents` 的 PR 即使在 root 记录里出现，
  也不进入受保护路径的允许列表。

默认模式冻结上下文包含仓库与 PR 的数字及 node 身份、已认证的作者与审核者、精确 head/base、
完整 `diff.digest`、`requirementDigest`、受保护路径清单，以及 head 候选的
Validate workflow blob。`prepare` 在任何 CI 结果之前冻结，避免 workflow 改动与
绿色 CI 互证。同一上下文重复 `prepare` 幂等。轻量模式的 head-v2 授权另按上方集成规则核验 main 风险。

浏览器批准的判定规则：

- 挑战保存审核者最新已提交 review 的水位（id 与提交时间）。只有严格晚于
  `frozenAt`、id 大于水位、且时间严格递增的审核才能绑定；同一秒、时钟回拨或
  之前已出现过的批准一律不绑定。
- 每次读取都重新计算当前上下文并回读实时 review。上下文漂移（含只同步 head 但
  diff 未变）、新需求、缺失去除的挑战都会重置 epoch 并作废旧 receipt；上下文恢复
  后旧 receipt 也不会复活。
- Luke 在任意 head 上最后提交的 review 必须是 `APPROVED`。之后的 `COMMENTED`、
  `CHANGES_REQUESTED`、`DISMISSED` 都拒绝；`PENDING` 忽略；审核者元数据、时间戳或顺序异常按失败关闭处理：
  清空本地 epoch，并把该 PR 记为 blocked，等待维护者复核，不静默当作批准，也不静默
  降级成普通拒绝。该阻塞只作用于该 PR，同一轮其余 PR 继续处理；GitHub 不提供删除
  已提交 review 的接口，因此这个 PR 需要维护者处理（通常是改用新的 PR 重新走流程），
  自动化只如实汇报，不猜测恢复路径。
- 需求摘要（v5）排除全部顶层 review 记录（正文、状态、commit）；inline review
  评论继续计入。批准本身不再改变需求摘要，因而不会因批准而失效。
- 授权只覆盖冻结时的精确路径与 workflow blob，不解锁产品、隐私、迁移、新能力或
  绕过 CI 的风险标记。浏览器通道的 `noRuntimeImpact` 恒为 false，不从 `APPROVED`
  推断；需要该豁免时按 root 记录逐路径精确绑定，而 root 记录只对
  `lukemyself-hub` 作者的 PR 生效，`luke-agents` 的 PR 拿不到该豁免。

#### 浏览器通道的合入与收尾

浏览器通道只发起绑定已审 head 的立即合入，不开启 GitHub 延迟 auto-merge。App
审批仍会写入以满足分支保护，但延迟 auto-merge 会让 Luke 事后撤回 review 时，
App 审批独自占住分支保护的审批位，从而在人工授权已失效后仍然合入。

- 未达到可合入状态时只等待并报告：不开启 auto-merge，也不写签名合入意图，让下一次
  `scan` 在状态变干净时重新发起绑定 head 的立即合入。root 通道保留原有 auto-merge
  语义。当缺少的浏览器批准是唯一的人工决定时，agent PR 既不合并也不中断整轮扫描，`submit`/`scan`
  返回 `awaiting_verification` 并说明需要当前 head 上的实时人工批准，且不写 Issue 交接；
  若同时还有暂停、分诊、依赖或关闭声明等人工决定，仍按原规则交回并如实报告该决定。
  未触及受保护路径的 agent PR 不需要浏览器批准，直接按绑定 head 的立即合入处理。
- 签名合入意图记录浏览器来源与 provenance（`humanChannel`、`humanReviewId`、
  epoch）。写 Issue 前再次回读实时绑定的人工 review，确认它仍是绑定 id、绑定 head
  上最后提交的 `APPROVED`，并重新推导需求摘要、核对合入提交与绑定 head；其余冻结
  字段都按 head 绑定，不重复采集 diff。合入后若 Luke 撤回 review，记录转入
  `needs_attention` 并报告该撤回，不重复合入、不写 Issue；合入是否真的落地以 GitHub
  实时状态为准，自动化不据此宣布合入结果。已写入的浏览器合入意图在恢复时
  会重新发起绑定 head 的立即合入（发起前再次回读实时人工 review），而不是只确认，
  因此一次瞬时不可合入不会把已批准合入永久搁置。
- 最终回读与 GitHub 合并请求之间仍存在不可消除的竞态：回读通过后 reviewer 仍可能
  在毫秒级窗口内撤回。该窗口只能靠立即合入与合入后复查收窄，不能完全消除。
- 已签名 v4 合入意图按原 v4 policy 与含 review 的摘要恢复，v5 按原 v5 policy 与
  排除 review 的摘要恢复。v6 继续使用 v5 摘要算法。兼容仅限已存在的 signed
  receipt，不改标、不重新批准；新提交只接受当前策略与 report v4。

PR 需求摘要只排除身份同时匹配 Vercel Bot actor `35613825`、login、Bot 类型、
GitHub App `8329` 且正文以 `[vc]: #` 开头的部署状态评论。人工评论、其他 Bot
评论、非状态正文及全部 Issue 评论继续纳入需求摘要；部署评论随每次构建更新，
不作为需求变更。

#323 已由 App 合入，生产提交 `26b63c94f9dbe01171826fb856a9e7801c9d1465`
对应部署 `dpl_HCpv4YhwQjAWqmpGHEBsRDrCN2ao` 已 Ready，公开登录与 providers
入口返回 200。#326 已 request changes 并回写 #274；Luke 要求暂不修改其代码。

2026-10-11，重启后的默认 Codex 会话已通过精确固定启动器完成 Keychain 与 GitHub API 认证。Luke 已授权 #325 / #258 完整试运行至合入与日常生产部署，其余七个 PR 后续由 Luke 明确指定为待自动审批对象。#325 已为 Ready，旧正文禁止合入标记已解除，Issue 曾设为 ongoing。App 已发布真实 `pr-review-gate` check；首次报告因评估工具路径误触发生产 Provider 专项而返回 awaiting_verification，未提交批准或合入，并按既定规则回写 Issue。

main classic protection rule `84625756` 已保存并由 App API 回读：1 个审批、过期审批失效、最近一次推送由他人审批、跟上 main、管理员同样执行、无绕过 actor；required checks 精确为 GitHub Actions `validate`（15368）与 SayHear App `pr-review-gate`（5270295）。规则 UI 禁止强推和删除。仓库 Allow auto-merge 已保存，用户连接器和刷新后的 UI 回读为 true；旧 App REST 读取会省略该字段，控制器已改为 GraphQL 明确布尔值读取并通过实测。

分类修复枚举已核实的非运行时路径：十个评估工具、配置和测试路径，加上 PR 审批工具链（controller、gate、planner、build、verifier、其测试、夹具与文档），不将其文件名当作生产迁移；显式迁移声明、真实运行时路径、混合与未知改动继续保留门禁。已安装版本通过 App GraphQL 回读确认 Allow auto-merge 为 true；#258 已恢复 ongoing，App 已提交 #325 的 APPROVED review `5482359756`，gate check 成功。

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
- `merge_candidate_with_deferrals`：legacy root 快照通过其余规则，但列明的检查未在合入前运行。
- `request_changes`：审核报告发现需要修改的问题。
- `awaiting_verification`：版本、SHA、权限或验收证据不足。
- `human_decision`：需求、产品、权限、迁移或保护规则需要人决定。

此命令不访问 GitHub，不执行 PR 代码，不调用 shell 命令，不创建 review/check，不回写 Issue，也不合入 PR。退出码 0 只表示快照可读取并完成评估；调用方必须读取 JSON 中的 `outcome`。

生产控制器只允许通过 `/Library/Application Support/SayHear/PRApproval/` 下的 root-owned 固定模式启动器调用：`pr-approval-status`、`pr-approval-prepare`、`pr-approval-scan`、`pr-approval-submit`、`pr-approval-configure`。`prepare` 只读取状态并写本地审核包；`scan` 可额外创建受控的 `pr-review-gate` 运行中检查；`configure` 仅由本机管理员在安装时写入 App 安装配置。控制器启动时逐一核验五个启动器、bundle 和 Node 均位于受保护目录。启动器固定 Node 与命令、清理继承环境变量，并拒绝任意子命令；不要用工作区源码、`pnpm pr:approval` 或 PR 提供的脚本访问 App 凭证。固定启动器已安装；2026-10-11 重启后的默认会话已确认精确执行规则允许正式路径在沙箱外运行并成功访问 Keychain。

## Gate 规则

- 报告绑定仓库、PR、head SHA、base SHA、策略版本，以及全部引用 Issue 的标题、正文和非 App 评论摘要。只改标签或 App 自身回写不改变需求摘要。
- 仅接受完整 diff、非 Draft PR、指向当前 `main` 的同仓库 PR，以及完整的关联 Issue 集合。交付集合的开放 Issue 须已认领，集合外依赖须解除。`merge-queue` 暂不可激活；`serialized-merge` 换成“无真实冲突且 main 已关闭 `requiresUpToDate`，由 controller 串行合入”。
- 每个未排除的开放 Issue 必须处于 `ongoing`，不能同时带 `ready-for-agent`、人工处理、待补充或暂停状态。
- PR Validate 的证据必须对应当前 head、base 和 merge SHA，并匹配可信 workflow 文件摘要、GitHub Actions App、仓库和 `pull_request` 事件。
- 每项必要证据都必须显式为 `passed`。`skipped`、`cancelled`、`neutral`、`planned` 和 `out-of-scope` 均阻断。
- `scripts/daily-release-validation.ts` 决定行为专项；gate 不使用它的退出码代替验收结果。
- 涉及审批规则、CI、产品定义、删除测试、完整能力验收或生产新能力启用时转人工。UI 变化按 Luke 确认的标准，追加 `ui:portal-smoke`（`tests/portal-integration.test.ts` 与 `tests/portal-conversation-status.test.ts` 两个模块级行为测试），不再要求设计稿所述的桌面与移动端交互证据；仓库当前没有接入 PR CI 的浏览器 E2E runner。该降级是产品决定，不是测试通过，等真实浏览器 E2E 落地后可恢复。数据库迁移要求可信、无 skip 的升级兼容专项证据。
- 只有可读的 main 保护规则、base 满足当前集成模式（`up-to-date-base` 要求等于最新 main；`merge-queue` 暂不可激活；`serialized-merge` 要求无冲突、main 已关闭 `requiresUpToDate`，且 main 的写入守卫正好只给审批 App 一个 bypass）、过期 review 失效、管理员强制执行、恰好一个审批名额、绕过 actor 符合当前模式（`up-to-date-base`/`merge-queue` 除审批 App 外不得有别的 bypass actor；`serialized-merge` 要求实时 bypass 名单恰好等于 `[reviewAppId]`，名单不可读时要求见证指纹相符且见证断言恰好等于 `[reviewAppId]`），以及精确匹配来源的 `validate` 和 `pr-review-gate` 两项 required checks 同时成立时，才会生成 `merge_candidate`。
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
