# Hosted 验收执行与授权方案

状态：待 Luke 审阅与授权。**本方案未接触任何 hosted 环境，未产生费用，未创建
部署或绕过链接。** 授权前只允许本地 profile 的证据。

对应 Issue：[#345](https://github.com/lukemyself-hub/SayHear/issues/345) 的 hosted
部分。执行环境为 ADR-0144 定义的隔离验收环境 `sayhear-g1-acceptance`，别名
`sayhear-g1-canary-lukemyself.vercel.app`；部署身份、配置与验收授权相互独立
（ADR-0148）。本方案不改变产品定义、认证、隐私或发布门槛。

## 已核实的起点

2026-10-12 的历史只读盘点（见 [`README.md`](README.md) 的“Hosted 验收环境现状”）
只能作为旧快照：开始执行前必须重新读取，不能直接采用。

- 别名受 Vercel Authentication 保护，匿名请求被重定向到 Vercel SSO。
- 部署由 CLI 上传，没有 Git 元数据；平台读不出它对应的 commit。
- `/api/internal/inspection/release-identity` 需要 Owner session 或 operator secret。
- Preview 环境变量中的 OAuth client、业务库、Purge Marker 库、Provider key 与
  G1 开关全部是不可读 secret；变量列表中没有 G1 release manifest，当前 G1 是否
  开启未知。

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
