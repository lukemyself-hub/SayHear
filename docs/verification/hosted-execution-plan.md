# Hosted 验收执行与授权方案

状态：**已授权并于 2026-10-14 执行第一轮**。执行结果、替身、清理回执与剩余缺口见
[evidence/hosted-execution-proof.json](evidence/hosted-execution-proof.json)（文末有执行
结果表）；完整截图、请求与数据库日志留在验收工作树的
`artifacts/verify/hosted-345-1/`（Git 忽略）。本轮未改变产品定义、认证、隐私或发布
门槛，未改动生产配置，未创建公开绕过链接。

对应 Issue：[#345](https://github.com/lukemyself-hub/SayHear/issues/345) 的 hosted
部分。执行环境为 ADR-0144 定义的隔离验收环境 `sayhear-g1-acceptance`，别名
`sayhear-g1-canary-lukemyself.vercel.app`；部署身份、配置与验收授权相互独立
（ADR-0148）。本方案不改变产品定义、认证、隐私或发布门槛。[#322](https://github.com/lukemyself-hub/SayHear/issues/322)
的发布授权不覆盖本方案中的部署、绕过链接、配置变更或 paid Provider 调用，这些
动作逐项走下面的授权表。

## 已核实的起点

2026-10-12 的历史只读盘点只能作为旧快照，开始执行前必须重新读取，不能直接采用。
环境事实（别名保护、未读的部署 commit、G1 manifest/pins 状态）以
[`README.md`](README.md) 的“Hosted 验收环境现状”和
[`SKILL.md`](../../.agents/skills/verify/SKILL.md) 的 Hosted target 为维护源，
本方案不复制；执行时刷新并逐项核对。

## 需要的授权与参与（逐项确认，不默认）

| # | 动作 | 需要谁 | 授权内容 | 未授权时的状态 |
| --- | --- | --- | --- | --- |
| 1 | 登录 Vercel 访问 `sayhear-g1-acceptance` | Luke | 本人登录或提供受控会话；不创建公开绕过链接 | 无法读部署与环境变量 |
| 2 | 决定并执行部署 | Luke | 部署哪个 commit（建议本票合入后的 `main`），由谁执行 CLI 上传 | 不部署，不假设平台上的旧部署等于候选代码 |
| 3 | 环境身份与配置读回 | Luke + Agent | 以 Owner 身份读 `/api/internal/inspection/release-identity`，核对独立 OAuth、业务库、Purge Marker 库、G1 manifest/pins | 缺失或未知即停止，不发明 pins、不开启 G1 |
| 4 | Paid Provider 预算 | Luke | Journal、Episode、Daily/Weekly 生成的调用上限（建议先给单轮预算，例：≤ 12 次生成调用） | 不发起任何付费调用 |
| 5 | Owner / GitHub 登录 | Luke | 正常 Owner 登录与 Reflection Evidence 的 GitHub step-up | 不驱动需要会话的用户路径 |
| 6 | Weekly due rule 时间控制 | Luke | 采用实际 due rule；到期才验收。允许受控测试时钟或明确“未到期” | “未到期”既不算失败也不算通过 |

任何一项未获授权时，对应子项记为“待授权”，本票保持开放，不用本地空状态或历史
成功替代。

## 执行步骤（获授权后）

### 1. 读回部署 commit 与实际环境

1. 以 Owner 登录，读 `/api/internal/inspection/release-identity`，记录部署
   commit、构建与配置身份。
2. 核对独立 OAuth client、业务库与 Purge Marker 库地址、active G1 manifest 与
   pins；与候选代码的预期差异逐项列出。
3. 若部署 commit 与候选代码不一致：记录差异，请求部署决定；不继续生成验收。
4. 若 manifest/pins 缺失或不可读：停止并报告，不发明值、不开启 G1。

### 2. 固定合成数据的生成链路

1. 在隔离环境用固定合成表达，从正常表达结束开始：经 admission、outbox、
   Workflow、Provider，到 current Journal。
2. 继续核验 Episode、Daily 与 Weekly Reflection 的生成与运行记录、血缘与
   Inspector 显示；Weekly 按实际 due rule/时间控制。
3. 对生成与恢复行为分别提供重试/幂等证据（重复触发同一命令、回调重投、恢复
   扫描），记录哪些路径实际执行。

### 3. Reflection Evidence 展开

1. 在未验证状态下请求展开，必须拒绝且不预取原文。
2. 经正常 Owner/step-up 路径完成 GitHub 验证。
3. 验证后只返回所请求的原文摘录，并写审计。
4. 已通过的 OAuth 往返不替代生成后的摘录展开验收。

### 4. 结果与失败处理

- 每项输出：命令、合成 fixture、浏览器行为、数据库/Workflow/Provider 证据、
  替身、清理回执、剩余缺口。
- 发现产品缺陷时保留失败证据，另行建产品修复票，不改动本票范围。
- hosted 前提受阻时本票保持开放并记录具体缺项。

## 预算与规模预估

| 项目 | 预估 | 说明 |
| --- | --- | --- |
| 部署与读回 | 0 次付费调用 | 只读身份与配置 |
| Journal 生成 | 1–3 次 `journal.draft` / `journal.validate` | 单日验收 |
| Episode / Daily / Weekly | 按实际开关与 due rule | Weekly 未到期则不调用 |
| 重试/幂等 | 复用既有命令，不重复付费生成 | 幂等重放不产生新 Provider 调用 |

总额以 Luke 给出的单轮预算为准；超出即停止并报告。

## 停止条件

- 未获对应授权、预算或部署决定。
- 部署身份与候选代码不一致且未获部署决定。
- G1 manifest/pins 缺失或未知。
- 需要变更生产配置、创建公开绕过链接或调用生产 Owner 私人数据。

## 与本地证据的边界

本地 `timeline` / `fault` profile 的 Journal、跨日期、中断重试证据只证明本地
Next dev 与本地 Workflow runtime 的行为。hosted Workflow dispatch、回调重投、
真实调度与 hosted Provider 不因本地通过而视为已验证。

## 执行结果（2026-10-14）

授权逐项确认并执行；完整事实、时间线与引文见
[evidence/hosted-execution-proof.json](evidence/hosted-execution-proof.json)。

| 步骤 | 结果 | 证据与备注 |
| --- | --- | --- |
| 1. 部署身份与环境读回 | 完成 | 别名 → `dpl_9DYrp9ARfSxCNNcKggBu1FEteE5m`（commit `acaa502`）；release identity 与 67 项 effective runtime config 读回；两个连接串哈希 `d9ce28dd…` / `e862afea…` 与配置一致 |
| 1. G1 manifest / pins | 缺口，按停止条件记录 | `switch.episode_build_enabled` 与 `switch.reflection_enabled` 为 false，prompt/manifest 等版本项 `unverified`；未开启 G1、未发明 pins |
| 2. 生成链路 | 完成 | 03:22Z 首次发送因站上停在迁移 0067 失败且零提交；03:52Z 补齐 0068–0070 后重发成功；04:28:14Z Journal 发布；浏览器复制/导出/回链全通过 |
| 2. 重试/幂等 | 完成（部分） | 三次恢复扫描后两次全 0（幂等）；未强制回调重投与真实 Provider 故障，已记录 |
| 2. Episode / Daily / Weekly | 未跑（配置缺口） | G1 off 下扫描开出 0 条 episode/reflection 命令；Weekly due 状态未评估 |
| 3. Reflection Evidence | 完成 | 未验证/过期拒绝且无原文 → 两次 GitHub step-up（一次经 UI「Verify again」按钮）→ 只返回所点摘录；`sensitive_access_audits` 三条 allowed/denied/allowed |
| 4. 预算 | 4 / 12 | `conversation.text`、`evidence.extract`、`journal.draft`、`journal.validate` |
| 替身 | 记录 | 扫描触发用 `vercel curl` + Bearer `CRON_SECRET`（站上无 cron、GitHub Actions 指向生产）；首次 step-up 由脚本复现 UI 的两条调用；浏览器链到可见 Vercel SSO 会话 |
| 清理回执 | 记录 | 未改生产、未建公开绕过链接；轮换后的 `CRON_SECRET` 只存本地 0600 文件；合成数据留在一次性验收站；证据在 Git 忽略的 `artifacts/` |

后续：G1-off 缺口（Episode / Daily / Weekly 生成）与跨日期证据（
[#340](https://github.com/lukemyself-hub/SayHear/issues/340)）补齐前，Issue
[#345](https://github.com/lukemyself-hub/SayHear/issues/345) 保持开放。
