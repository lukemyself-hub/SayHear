# PR 自动审批：现状调查与流程设计

状态：实施中。Luke 已确认设计选择并授权继续实施和启用。本文件整合方案与验收要求，不是已发布 SPEC。平台信息是 2026-10-10 的快照；本机与 GitHub 当前状态于 2026-10-11 重新核验。

## 已确认方案

本机审批 Agent 每小时扫描一次，复用当前 Coding Plan。GitHub Actions 继续承担现有全量 CI；GitHub Pro 保护 main；仅安装于 SayHear 的独立 GitHub App 发布审批、回写 Issue 并执行受保护的合入。普通改动沿用现有生产发布方式。离线或额度不足时等待，不切换付费模型 API。

实现 Agent 开始执行时用 `ongoing` 占用 Issue 并移除 `ready-for-agent`，调度 Agent 不重复派发；交回修改、转人工、暂停或完成时清理该标签。完成实现和自检后把 Draft 转为 Ready。审批 Agent 检查需求、代码和必要验收：通过则合入；确定缺陷则 request changes 并把结果同步到 Issue、更新 ready-for-agent；缺证据则待验证并交回补齐；需要产品或权限决定则交给 Luke。连续三轮修改后复审仍失败就暂停。无变化不重复深审或通知。

实施者必须先完成保护规则、独立身份、沙箱隔离、真实 Issue tracker 接续及试运行的验证，才能启用无人值守合入。仓库已实现只读 gate、GitHub API 控制器、review/check 发布、Issue 回写、暂停与轮次记录和全仓锁。`pr-approval-scan` 固定启动器与 runtime 完整性清单已构建；针对性测试、两套 TypeScript 检查通过。新版 bundle `fd9968aae662d4241b6437147fd686328b60e76ff79a001c6f969e8f610fde96` 已安装到 root-owned runtime（`root:wheel 0644`）。GitHub App（ID `5270295`）仅安装在 `lukemyself-hub/SayHear`（installation ID `170161232`），权限符合最小范围；生产合并授权标记已写入 root-owned 配置。

2026-10-11，重启后的默认 Codex 会话已用精确固定启动器成功访问 Keychain 和 GitHub API，规则已实际生效。当前已有有效密钥，不需要再次创建或导入；下载 PEM 已清理。Luke 已指定 #325 / #258 进行完整试运行至合入、生产部署，并授权保存 main 保护和仓库 Allow auto-merge；其余七个 PR 后续由 Luke 明确指定为待自动审批对象。

main 保护规则 `84625756` 已保存：1 个审批、过期审批失效、最新推送由他人批准、跟上 base、管理员同样执行、无绕过 actor、禁止强推和删除。App 回读确认 required checks 精确为 GitHub Actions `validate`（15368）和 SayHear App `pr-review-gate`（5270295）。仓库 Allow auto-merge 的用户连接器/UI 回读均为 true。

#325 的 App check 已真实发布，首次提交报告返回 awaiting_verification，按规则回写 Issue，未批准或合入。试运行发现并修复两项控制器问题：已核实的九个评估工具/测试路径不应仅因文件名 provider 而触发生产迁移验收，显式迁移声明和真实运行时/未知混合路径继续受控；App installation-token REST 会省略合并设置，改为 GraphQL 显式布尔值读取，读取失败仍阻断。独立审查确认两项逻辑无阻断；测试样例的缺失类型字段已补齐。81 个针对性测试、根 TypeScript、工具 TypeScript及六个项目 TypeScript 均通过。pnpm 包装命令尝试自动安装并因无 TTY 中止，未批准清理依赖，实际验证使用已安装的 tsc/vitest。

bundle `49af57fb3fbc76bae34a655f47c4a634d2ee1c89604af30154d359bb96deb9b4` 已安装，App GraphQL 确认 Allow auto-merge 为 true。#258 已恢复 ongoing，App APPROVED review `5482359756` 与成功 gate check 已发布。GitHub 实测 Contents read 下的 App 审批不计入保护要求；Luke 已明确授权 Contents write，App 和唯一 SayHear 安装的权限更新已保存并接受。

最新 bundle `1e9fa694af8a511cf02dbb3ef5c3c419d9094b50da87bcd409f8958a5242c406` 已安装，权限白名单同步为 Contents write，支持 clean PR 的受保护 REST 合并。请求绑定已审 head SHA，响应丢失先核实实际结果，手动关闭不算合入。83 个针对性测试及根、工具 TypeScript 检查通过。

#325 已由 App 于 `2026-10-11T07:37:40Z` 合入 main，merge SHA `bea67d2739de7cc1c64191d35a9964dd14336f2a`；#258 已关闭并清理 ongoing。对应 Production deployment `dpl_GtX8f5k7kP1KScYRMsNy177Nzbom` 为 READY、git SHA 一致、生产域名绑定完成，登录与 auth providers HTTP smoke 均为 200。每小时本线程 heartbeat `sayhear-pr` 已 ACTIVE；首次定时执行待核验，手动默认会话 status/prepare 已成功且未写入其余七个保留 PR。详细证据在 `artifacts/pr-approval/operations/2026-10-11-pilot.json`。三轮暂停和失败恢复使用测试场景验证；真实试运行验证了待补证回写和成功合入，没有人为制造代码缺陷。

## 目标与调研边界

让 Agent 定期审查 PR，根据代码、当前需求和实际验证证据决定能否合入，同时保持流程精简。
本轮检查了工作流、测试配置、系统测试实现、发布工具、相关产品规则与 ADR，以及 GitHub 实际设置、开放 PR 和 CI 日志。未重新执行全量测试，也未读取生产私人数据。

本地 HEAD 与 GitHub API 查询到的 main 均为 `c74076f68f8a48a94b5f56b8faea2d7a764be1ea`。没有据此宣称本地 origin/main 已 fetch。原有未跟踪文件 `docs/agents/local-environment.md` 保持不动。

## 已核实的现状

| 项目 | 证据与结论 |
| --- | --- |
| PR 基线 | [pr-validate.yml](../../.github/workflows/pr-validate.yml) 对所有 PR 执行，没有 paths 过滤。两个 PostgreSQL 17 service，固定 Node/pnpm、frozen lockfile、只读 contents 权限、30 分钟上限，同 PR 新运行取消旧运行。 |
| 实际执行 | [run 38093928722](https://github.com/lukemyself-hub/SayHear/actions/runs/38093928722) 对 PR #323 通过 160 文件、2024 测试；系统套件 40/40、463 测试、skipped 0。最近八次所查运行均成功，约 4–6 分钟；这不是长期故障率统计。 |
| 防跳过 | [数据库预检](../../scripts/ci/verify-test-databases.ts) 与 [系统执行检查](../../scripts/ci/system-suite-execution.ts) 会阻断缺库、套件缺失和非通过测试。40 是当前套件数量，不应永久阻止有理由的增删。数量正确不等于断言有效。 |
| 静态与构建 | [package.json](../../package.json) 包含 runtime、模块边界、Purge inventory、schema extension、typecheck、测试及 build。工作流 build 包含 startup 和 browser bundle 检查。未发现根级 lint 命令。 |
| 核心数据库回归 | tests/system 覆盖对话、安全姿态、Journal、Memory、Episode、Reflection、权限、Full Purge/恢复、配置切换与 Portal 数据读取。已有真实 PostgreSQL，常规模型路径使用确定性适配器，不代表真实 Provider 或浏览器交互已验收。 |
| UI 证据 | [portal-acceptance](../../tests/system/portal-acceptance.system.test.ts) 主要验证服务及数据库的历史重试契约；当前 Vitest 为 node 环境。未发现接入 PR CI 的浏览器 E2E runner。文件名中的 acceptance 不证明布局、滚动、移动端、键盘或流式渲染通过。 |
| 按影响验证 | 已关闭的 [SPEC #275](https://github.com/lukemyself-hub/SayHear/issues/275) 已有 [daily-release-validation.ts](../../scripts/daily-release-validation.ts) 实现。保留基线，路径提示只增加专项，未知影响先定位；整体能力验收只由特定能力变化触发。 |
| 计划与结果不同 | 上述工具默认可只生成计划；`--execute` 仅执行允许的轻量检查，重型项可能标为 out-of-scope。`dailyReleaseValidationExitCode` 不要求所有计划项 executed。其 exit 0 不能直接充当合入许可。 |
| 现有自动化 | 另有每小时 Recovery Scan 和每月 Backup Evidence Renewal；它们是运维工作流，不是 PR 审批器。仓库仅发现这三个 workflow。 |
| GitHub 设置 | 仓库为 private，API 曾返回 allow_auto_merge=false。2026-10-10 在 GitHub Billing 页面核实个人账户已订阅 GitHub Pro（$4/月）；仓库 Rulesets 页面当前显示没有 ruleset。main 保护尚未配置或验证，不能把 CI 绿灯描述成服务器已强制保护 main。 |
| 开放 PR | 调研时八个 PR 均有人工保留。Luke 后续解除 #325 / #258 的保留并授权完整试运行，现已合入；Luke 后续明确 #309、#310、#311、#323、#324、#326、#327 是待自动审批对象，旧人工交接文字不再视作保留。 |
| 生产关联 | Vercel 项目 `say-hear-web` 连接 `lukemyself-hub/SayHear`；Production 跟踪 `main`，每次向该分支推送都会创建 Production Deployment，并启用了 Auto-assign Custom Production Domains。[vercel.json](../../apps/web/vercel.json) 在 production build 先执行 db:migrate。Luke 已授权普通合并沿用该发布方式；生产新能力、配置授权和破坏性迁移仍转人工。 |

## 必须沿用的产品决定

- [ADR-0148](../adr/0148-deployment-identity-config-authorization-and-acceptance-are-separate.md)：部署身份、运行配置授权、历史能力验收分开。不能每次 PR 重跑完整 G1，也不能伪造旧证据为新 commit 实测。Purge/Schema/清理集成变化仍需相关恢复专项。
- [ADR-0150](../adr/0150-recent-context-ships-after-deterministic-validation.md)：近期背景通过确定性合成验证后，体验在正常聊天中观察，不新增普遍人评门槛。
- [ADR-0110](../adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md) 与 [ADR-0143](../adr/0143-g1-ships-without-semantic-reflection-validation.md)：LLM 不能把味觉评分或 Reflection 语义判断升级为最终发布裁定。代码审查模型可以发现契约问题，但不能另造产品质量标准。
- [ADR-0131](../adr/0131-every-private-data-surface-registers-its-purge-contract.md)、[隐私承诺](../product/19-privacy-and-trust.md)：新增私人数据面必须有完整删除合同；正式自动验收使用合成数据。
- 当前 G1-only；不借本任务重启 G2/Bio、Voice、External MVP。正式需求仍在 GitHub Issue，不能仅信 PR 作者摘要。

## 流程

### 1. 本机定期审核，GitHub 继续执行 CI

保留 PR Validate。Luke 已选择本机 Agent 复用现有 Coding Plan，不使用额外的模型 API。通过本机已有的定时能力每小时读取 PR、CI 和 Ready 状态的变化，不为接收 webhook 建设常驻公网服务。电脑离线时允许延迟，恢复后下一次扫描按 GitHub 当前状态处理，不重放过期审批动作。

每次重新读取 PR、head/base、Draft、审核意见、关联 Issue、阻塞关系及检查状态。Draft 或明确暂停合入的 PR 不进入自动合入。对同一证据版本去重；无变化时不重复调用模型或刷评论。全仓合入串行，每个 PR 只保留一个有效审核任务。

GitHub 自身保存 PR/review/check/run 及 Issue 交接记录，不另建队列数据库或通用 Agent 平台。重启后从这些记录重建状态。本机仅保存必要的任务锁和缓存，不能以本地缓存覆盖 GitHub 已变化的状态。仍会使用 GitHub API；“不使用模型 API”约束模型计费和接入方式，不禁止仓库操作 API。

### 2. 每个可审核 PR 做一次有边界的代码审查

同一次审查覆盖两件事：是否符合已确认 Issue/ADR，以及实现有没有正确性、异常、并发、隐私、架构或测试缺陷。读取完整 diff 与必要调用路径，不能只读摘要；diff 截断或关键上下文缺失时停止自动判定。

阻断发现必须给文件位置、触发条件、用户后果和证据，区分已确认缺陷与待查疑点。P0/P1/P2 的实质问题建议阻断，风格和无证据猜测不阻断。不为了批准而自动改 PR，也不无限循环审查；发现修复后的新 SHA 再审，持续争议交给人工。

### 3. 固定 CI + 受影响专项

继续全量现有基线，当前耗时不支持引入复杂测试选择器。专项复用现有影响分类，结合真实 diff 和 Issue，不能只信作者标签。

| 改动 | 必要证据方向 |
| --- | --- |
| 普通服务端修复 | 能触发原问题的回归案例、正常路径与失败路径；复用基线已执行的相同测试，不重复跑。 |
| 对话、近期背景、Journal、Memory、Reflection | 对应输入到实际消费点的确定性验证，包含日期/语言、来源、revision/epoch、并发失效。模型自然度不得冒充确定性结果。 |
| UI | 在合成环境验证受影响的桌面/移动端路径；不能用 typecheck 或 PostgreSQL 套件代替交互证据。先选少量稳定浏览器 smoke，再按改动扩充，避免整站截图大工程。 |
| 权限、Purge、恢复、新数据面 | owner 隔离、并发围栏、登记及真实数据库清理/恢复专项，保持隔离环境。 |
| Prompt、预算、Provider | 受影响合成样本及配置版本比对；真实 Provider 验证独立受控执行，普通 PR job 不持有生产或 Provider secrets。 |
| 迁移 | 空库建表之外，验证代表性的旧 schema 升级、已有数据约束和旧新程序兼容。生产构建会执行迁移，破坏性变更不应自动放行。 |
| CI、审核规则、权限和验收标准 | 人工审核；被审 PR 不能修改自身的放行规则来获得批准。 |

计划中的每个必要项目必须是已通过且身份匹配的证据，或已有明确适用的豁免；planned、out-of-scope、缺失、取消、超时、skipped 均不等于通过。PR 本文声称“已测”只能作为检索线索。

### 4. 四类结果

采用“可合入、需修改、待验证、需人工决定”。

- 需修改：确定的代码/契约问题，提交 request changes，保留 PR。
- 待验证：CI 未完、环境失败、证据缺失；不能标成代码错误或批准。
- 需人工决定：需求/ADR 冲突、策略自改、产品边界或未授权高影响变化。
- 可合入：代码审查、固定基线、必要专项、授权和最新版本条件均满足。

“驳回”已确认定义为 request changes，不自动关闭 PR，并回写对应 Issue、转为 ready-for-agent。PR 审核属于通用工程流程，不向产品领域 GLOSSARY 添加这些通用术语。

待验证时区分两种情况：CI 仍在运行或临时不可用，就等待，不反复派发修改；确有缺失的专项证据，就在对应 Issue 列出目标 SHA、所缺检查与通过条件，交回实现 Agent 补齐。补证不是代码缺陷，不发送虚假的 request changes，也不增加三轮修改失败计数。必要验收需要额外付费模型调用或扩大权限时报告阻塞，不自行扩权。实现 Agent 的自述不直接成为通过依据，必须提供可核验的报告、运行记录或交互证据。

### 5. 合入由确定性条件执行

审查结论绑定 repository、PR、head SHA、base SHA、策略版本及需求版本/摘要。测试证据还记录被测 merge commit、workflow/run/attempt 和来源。合入前重读状态；head、base、相关需求或策略改变则失效，不能仅凭旧绿色 check 或旧 APPROVED 复用。

优先使用服务器强制 required checks、过期 review 失效和最新 base 验证，再让独立身份的 Agent 批准并启用 auto-merge。最终 check 必须验证可信工作流来源，不能只匹配 check 名字。新 CI 自修改、少测/删测必须经过可信基线策略判断。

Pro 升级未完成、保护未生效或保护状态无法读取时，不自动合入。带 head SHA 的 merge API 只保护 head，不能替代服务器对最新 base 的校验；不提供绕过保护的备用路径。

审核控制器与测试执行环境分开。前者持有最小发布审核/合入权限，后者执行 PR 代码但没有这些凭证。PR 文本、代码注释和测试 artifact 都是不可信输入，不得提供 shell 指令或提高权限。只输出结构化结论，由控制器验证后执行。

独立 GitHub App 身份已创建；安装时只选择 SayHear。本机个人 gh 身份不承担自动批准。App 申请 Actions read、Administration read、Checks write、Contents write、Issues write、Pull requests write，及 GitHub 必需的 Metadata read。Contents write 是试运行发现审批计入保护和执行合并所需的权限，已由 Luke 单独授权；不授予管理保护规则的写权限，不加入绕过名单。review 是否被分支保护认可须在试运行中验证。也不预设自动化产生的事件一定能自动继续 CI。

## 建议实施顺序及验收

1. 将已确认方案转为可执行任务；先核实本机 Coding Plan 路由、Pro 和保护能力，以及实际 Issue tracker 的暂停/接续行为。
2. 先实现只读审查结果和确定性合入判定，使用真实 PR 的固定快照试运行；用户正常审核对照漏报/误报。
3. 对已授权范围启用自动 request changes / approve；保护规则和身份核验完成后再启用合入。
4. 补最有价值的 UI/迁移专项，避免一开始添加覆盖率硬阈值、整仓 lint 格式改造、多模型投票或通用平台。

控制器必须通过：head 更新、base 更新、两 PR 竞争、重复事件、执行中断、旧报告重放、CI 跳过/取消、伪造同名 check、测试规则自改、Draft、需求冲突、模型输出不合法、注入文本、无权限、合入超时后查询实际结果等场景。失败默认不合入；重试有界且保留失败证据。无法确认上次合入结果时先查 GitHub，不重复执行。

合入、部署、功能启用分别记录。Vercel 已核实会随 main 更新自动创建 Production Deployment，Luke 已将普通合并产生的日常发布纳入授权范围；启用合入前仍须核验生产部署身份和必要 smoke。生产失败默认停止后续合入并报告，不自动执行数据回退或破坏性 down migration。

## 第一轮决定

2026-10-10 Luke 已确认以下设计决定；后续已授权实施和启用：

1. 自动合入覆盖既有范围内、证据充分的普通前后端改动；CI/审批规则、权限与隐私边界、破坏性迁移、新能力启用和产品定义变化留给人工。
2. 驳回使用 `request changes`，保留 PR。审核结果必须同步到相应 Issue，并将 Issue 分诊状态更新为 `ready-for-agent`，供 Issue tracker Agent 接续修改。
3. 普通改动沿用现有发布方式，自动合入可关联日常生产发布；已只读核实 Vercel Production 跟踪 `main`，每次 main 更新会启动生产部署。配置授权、新能力启用和破坏性迁移仍单独处理。
4. Luke 已确认按个人 GitHub Pro 继续设计。API 已核实 `lukemyself-hub` 的 owner.type 为 `User`，无需为此迁入组织。GitHub Billing 页面现已核实 Pro 订阅有效；仓库保护尚未生效，须继续设置并回读。

Issue 回写包含 PR/review 链接、head SHA、阻断发现、修改要求和复验要求；先确保评论成功再更新标签，保留 bug/enhancement 等非分诊标签。用 review ID 去重，失败后可补做，不能宣称已交接。接续修改继续现有 PR；映射不明确或 Issue 已关闭时报交接阻塞，已有活动执行者时不重复派发。`ready-for-agent` 不绕过依赖、暂停和执行占用检查。

费用核查：GitHub 官方 FAQ 列个人 Pro 为 USD 4/月，按月价乘 12 为 USD 48/年，这不是年付报价。Team 定价页列 USD 4/用户/月，页面标有前 12 个月说明；它面向组织，本仓库无需选它。税费、Actions 超额另行考虑，最终结账价格以账户页面为准。审核使用现有 Coding Plan 额度，不开额外模型 API 计费；额度不足时等待恢复，不自动切换付费 API。

来源：[官方套餐 FAQ](https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans)、[定价页](https://github.com/pricing)、[私有仓库保护可用性](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)。

三轮设计问答已完成。剩余事项是实施前验证，不再把已确认选择重复提问；涉及超出本方案的产品或权限变化时才重新确认。

## Pro 方案细化与第二轮决定

Pro 采用 required checks + 分支必须跟上 main + 过期审批失效 + 普通 auto-merge，不依赖原生 merge queue。GitHub 文档明确私有仓库 merge queue 属于 Enterprise Cloud 组织能力。本方案每次只为一个 PR 开启合入；其他 PR 在 main 前进后重新更新、测试、审核。禁止 Agent 绕过保护。

建议保留现有 validate，再增加由可信控制器发布的 review gate；专项验收结果汇入 gate，避免堆积许多独立 required checks。独立审核身份不能兼做同一 PR 的代码作者或最后修改者。main 更新进 PR 分支由实施者完成，无冲突时也必须触发新的 CI；不使用审核者身份修改后自批。

调研开始时仓库 agent 文档没有规定“实现完成后自动将 Draft 转为 Ready”的交接，本次已补齐。本机 Codex automations 目录只查到与 SayHear G1 验收跟进相关的文件，没有找到可据此确认已运行 Issue tracker 的自动化定义；不能推断其他主机或外部服务没有此 Agent。写入 ready-for-agent 不等于真实接续已经验证。

第二轮 Luke 已确认：

1. 由实现 Agent 完成实现和自检后将 Draft 转为 Ready，表示提交自动审核。开始执行时添加 `ongoing`、移除 `ready-for-agent`，避免调度 Agent 重复派发；交回修改、转人工、暂停或完成时移除 `ongoing`。审批 Agent 不自行把存量 Draft 升级为 Ready，不解除明确的暂停合入要求。无关联 Issue 的 PR 先要求补齐需求来源；关联多个 Issue 时只回写实际受影响的任务。
2. 同一 PR 连续三轮“修改后复审仍有阻断问题”时停止自动修复循环，通知 Luke。每次 request changes 仍按已确认规则回写 ready-for-agent；Issue tracker 必须读取暂停标记，暂停状态优先于标签，避免继续领任务。CI 等待和环境重试不计为修复轮次。
3. 使用本机 Agent 审批，复用当前 Coding Plan，不使用模型 API，可以接受电脑离线时延迟审核。GitHub Actions 只继续执行确定性 CI。本机模型身份和 GitHub 审批身份分开，独立审核身份仍需配置。

Luke 同时要求把实现 Agent 的要求写入 repo。已同步到 [Issue tracker](../agents/issue-tracker.md#实现与-pr-审核交接)，由 AGENTS.md、文档地图和分诊标签文档指向该规则。这部分是已确认的交接要求；实施与启用的当前状态见本文顶部。

本机调度可使用现有桌面应用的聊天定时任务；官方文档确认本地项目任务要求电脑开机、应用运行，遵循沙箱权限。实施前先手动试跑任务，再设置周期。当前 Coding Plan 的具体账号路由、额度与所选模型必须在配置时核验，不以官方 ChatGPT 登录文档推断第三方 Coding Plan 的计费。[本机定时任务文档](https://developers.openai.com/codex/app/automations/)

## 第三轮决定

1. 使用独立、仅安装于 SayHear 的 GitHub App 身份发布审核与合入结果。它不是模型服务，不增加模型 API 计费。本机普通 gh 仍保留实现者身份；审核凭证只由可信控制器使用。验证 App 审批被保护规则认可后才启用自动合入。
2. 每小时扫描一次，无变化不重复深审，只在合入、要求修改、三轮暂停或需要人处理时通知。机器离线/套餐额度耗尽后等下一次可用扫描，不自动购买额度。
3. 首版缺少必要浏览器、真实 Provider 或部署专项证据时，保持待验证并回写所缺证据，由实现 Agent 补齐。自动审批只运行无生产凭证、合成数据的已批准检查；不为了完成验收读取真实私人内容。一般不额外要求模型自然度评审，沿用现有 ADR。

独立 App 和具体沙箱隔离是实现前置，不是仅凭提示词能够证明的隔离。PR checkout 不加载用户工作区 .env，不执行 PR 提供的审批策略或本机启动钩子，不持有 App 私钥、现有 gh 登录或生产凭证。未能隔离的本机命令留作待验证，不能把独立 worktree 当成权限隔离。

## 实施合同与启用验收

### 保持实现精简

只增加一个可信的本机审批入口和一个最终 `pr-review-gate`，不另建服务数据库。模型负责审查并输出发现、证据和建议，控制器负责校验状态与执行 GitHub 操作。GitHub App 身份固定为 review gate 的预期来源；validate 和 gate 都必须实际 success，控制器不能将 skipped/neutral 当作已完成验收。

现有 daily-release-validation 作为选取专项的基础，另由 gate 检查必要证据的完成状态。基线已经执行的测试不重复执行。普通 PR 不增加覆盖率百分比门槛，不要求完整 G1 重验；新增数据面、迁移或边界变化按已有合同补充验收。

### 持久记录与重试

审核记录至少包含 PR、head/base、策略版本、需求身份、review ID、CI run/attempt、必要证据及结果。交接去重键用 PR + review ID；暂停记录包含原因、轮次和需 Luke 恢复的状态。只有受信任审批身份或 Luke 的操作能改变暂停状态，不能接受 PR 作者提交的文本解除暂停。

初次 request changes 不算“修改后失败”；其后每个为响应审查而提交的新版本复审失败计一轮，第三轮暂停。证据缺失、单纯 main 同步、重复扫描、CI 等待和环境失败不增加计数。换新 PR 规避原任务暂停时仍应识别该 Issue 的暂停记录，报告而非继续。

网络或平台短暂失败允许一次即时重试，仍失败则保存待办，等下一次扫描；确定性测试失败不能重跑到绿灯后隐藏首次结果。审批或合入请求结果未知时先查询远端实际状态。模型中断、限额或不合法输出均保持不合入，不自动更换模型或购买额度。

### 启用前必须验证

| 验证项 | 通过条件 |
| --- | --- |
| 本机执行与计费 | 手动试跑使用现有 Coding Plan 登录和可用模型，不依赖额外模型 API key；权限不足/额度耗尽能明确等待。 |
| GitHub 强制保护 | Pro 能力实际可用；main 必须通过 validate 和指定 App 来源的 review gate，要求最新 base 及独立审批；过期审批失效，Agent 无绕过权限。 |
| 独立审核身份 | App 能提交有效 review、回写指定 Issue 和更新标签，且与实现者分离；未批准版本不能合入。 |
| 执行占用 | 开始实现即添加 `ongoing` 并移除 `ready-for-agent`；调度看到 `ongoing` 不派发；交回、暂停、完成时清理，不留下陈旧占用。 |
| PR 代码隔离 | 恶意测试/启动脚本不能读取本机凭证或调用特权控制器；策略从可信版本加载。不能证明时不开放本机执行。 |
| 过期与并发 | head/base 更新、两个 PR 竞争、旧报告或同名伪造 check 不得放行；合入串行，后续 PR 按新 base 再验。 |
| 缺测与补证 | 缺数据库、缺系统套件、skipped、planned、out-of-scope、无浏览器证据均准确阻断；补证后可恢复，未改代码不虚增修改轮次。 |
| Issue 接续 | 一次 request changes 只产生一次完整交接，半途失败可补完；真实 Issue tracker 继续原 PR，并确实遵守三轮暂停。 |
| 恢复与发布 | 离线后恢复扫描不重放旧动作；先确认合入结果，再跟踪对应部署身份与 smoke；失败停止后续合入并通知。 |

先用固定 PR 快照和故障场景演练，再用一个明确授权的普通 PR 验证完整交付；不以静态配置文件存在代替上述结果。生产发布方式需读取 Vercel 实际设置核对，不能仅从 vercel.json 推断。自动回滚数据和破坏性 down migration 不在范围内。

本方案没有新的产品领域术语，不修改 GLOSSARY；运行机制先记录于本方案和执行任务，暂不为可逆的轮询与身份配置新增 ADR。

官方依据：[merge queue 可用性](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)、[分支保护与过期审批](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

## 官方资料

- [GitHub auto-merge 可用性](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)：私有仓库需要受支持付费套餐。
- [Merge queue](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)：验证最新 base 及排队组合；若未来采用，需要 merge_group 事件，不预设当前套餐可用。
- [特权工作流安全](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)：不要在持有特权 token/secrets 的作业中执行被审 PR 代码。
- [Merge REST API](https://docs.github.com/en/rest/pulls/pulls)：head SHA 不匹配返回 409。
- [GITHUB_TOKEN 事件规则](https://docs.github.com/en/actions/concepts/security/github_token)：自动化事件存在防递归和需批准的限制，实施时按当前规则验证。
- [定时任务限制](https://docs.github.com/en/actions/tutorials/manage-your-work/close-inactive-issues)：schedule 可能延迟或丢弃，不能承诺准点审批。

2026-10-11，Luke 纠正七个存量 PR 的归属：它们是需要自动处理的待批准 PR，旧实现交接中的“等人工审核合入”不代表持续保留。调度 prompt 已同步。#309 的旧合入保留及两处关联 Issue 歧义已修正，相关 Issue 已恢复 ongoing；按最新 main、独立审查和 CI 逐个处理，不能免除实质门禁。
