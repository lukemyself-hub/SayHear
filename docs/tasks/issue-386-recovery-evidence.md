# Issue #386 派生延迟诊断与交付边界

关联需求 https://github.com/lukemyself-hub/SayHear/issues/386 。

## 已确认根因

2026-10-18 使用 Luke 指定的 `.env.neon` 中 `DATABASE_URL` 执行只读元数据查询。
所有查询使用 `BEGIN TRANSACTION READ ONLY`、20 秒 statement timeout 和 `ROLLBACK`，
未读取消息、Journal 文本或 Evidence 内容，未执行生产写入。

Recovery route 把 `reflection-readiness:v1` 传给 `readDerivedLatency`，但实际生成器
把 `reflection-admission:v1` 写入 `reflection_runs.policy_version`。
Readiness 版本用于调度；版本表另用 `schedule_policy_version` 保存它。
因此 11 条当前 head 已有 built Reflection 的 Session 被误计为 pending。

修复 route 参数后，按相同条件只读核对仍有 3 条真实 pending。最老一条的 quiescent
时间为 2026-08-18 01:48 UTC，仍超过 7200 秒。此修复不代表生产扫描已恢复通过。

初稿曾把 date outcome 的 LEFT JOIN 改成 INNER JOIN。生产 14 条全部已有当前 head
outcome，初稿不能消除这批误计，而且会隐藏尚未提交 outcome 的真实工作。该修改已撤销。

## 逐 Session 分类

时间均为 UTC。下表只包含标识、revision、状态和时间。

| Session | Head | Quiescent | 当前 head Reflection | 分类 |
| --- | --- | --- | --- | --- |
| 01a011fd-cbc4-73b7-a353-adf2e8a34bd0 | 20 | 2026-08-18 01:48 | ready/admission:v1 | 真实积压 |
| 01a01c80-fc81-7152-9746-04a1e96a8dd2 | 14 | 2026-08-20 01:49 | ready/admission:v1 | 真实积压 |
| 01a065a0-ee64-7f31-a82f-4f9f7a5ed2df | 14 | 2026-09-03 11:10 | 无 | 真实积压 |
| 01a06f18-c1e8-78bf-8693-4709d97507cb | 12 | 2026-09-05 04:23 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a094b5-7248-74d9-ba8e-d8a6b1f8953e | 3 | 2026-09-12 10:42 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a09b50-33a8-7e9c-91de-9ab3aac0dbf8 | 2 | 2026-09-13 15:43 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a10d42-a933-7f84-9f4b-1e5775fcb008 | 4 | 2026-10-05 19:01 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a114cb-cb54-7d88-83d2-12e3e01b56e4 | 18 | 2026-10-07 08:36 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a119b9-6f34-763a-a877-0b8173e63ae1 | 6 | 2026-10-08 08:55 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a11cad-eafd-73af-ad9e-25dc7a84d05e | 24 | 2026-10-08 22:03 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a1229c-24b1-71db-819d-fe7b21ef43a8 | 22 | 2026-10-10 07:03 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a127c4-5335-7ddf-972d-1dc36103847b | 8 | 2026-10-10 22:29 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a13b95-535a-73f0-bfe1-eaf680cf80f6 | 3 | 2026-10-15 09:52 | built/admission:v1 | 已完成，被版本错配误计 |
| 01a140fb-94e9-7a39-be31-8a3790b828ad | 4 | 2026-10-15 22:13 | built/admission:v1 | 已完成，被版本错配误计 |

表中 admission:v1 为 `reflection-admission:v1`。

## 剩余积压

3 条 Episode 均为当前 head `failed/schema_incompatible`。Episode terminal failure 满
30 分钟可以走既有 Reflection degraded 路径，但不会自动修复 Journal 或重新执行已终态的命令。

- `01a011fd` 的 date outcome 为 `journal_available`，Journal 为 `needs_review@r20`。
- `01a01c80` 的 date outcome 为 `eligible_queued`，Journal 为 `needs_review@r14`。
- 上述两条 Reflection 都从 2026-09-14 19:20 UTC 停在 `ready`，关联 generation command
  为 `failed`、recovery status 为 `terminal`，关联 attempt 为 `failed`。该 ready ledger
  不等于 live attempt，也不等于 built。Daily admission 不会自动重试相同 intent。
- `01a065a0` 的 date outcome 为 `eligible_queued`，无 Journal outcome、无 Reflection run。
  Journal 未 settled，因此不能仅通过重排 Reflection 来完成。

尚未核实第三条的 Journal command 终态和所有重放所需的当前 owner、epoch、baseline、
role pin 与幂等身份。不能把修改 ledger status 或删除旧 run 当作恢复办法。
下一步需要为这 3 条逐一制定既有 service/workflow 路径下的受控恢复，明确费用和生产写入
范围，取得单独授权后执行。必要的调度改动应以这些身份和状态证据为依据，保留同 intent
不隐式重试的既有边界。

## 验证

- `pnpm typecheck` 通过。
- Reflection、Episode、Journal stale recovery 3 个系统套件共 38 项通过。
- Recovery handler、workflow 行为、workflow trigger contracts、internal access、Journal
  eligibility 5 个套件共 127 项通过。
- 补 route 接线与缺 outcome 回归后，Reflection 系统套件和 route 单测共 28 项通过。
  上述数字含重复执行，不应相加为独立测试总数。
- route 测试直接断言传入 admission policy；系统测试在真实 Daily build 后验证 pending=0。
  ready-but-unbuilt、缺 outcome 以及 7201 秒真实积压仍计入；旧 policy built 不能消除 pending。
- 独立 reviewer 核对真实生成、持久化、指标与门禁调用链，未发现阻塞代码缺陷。
  其建议的 route 接线和缺 outcome 两项回归均已补入。
- 尝试临时改回旧参数执行负向测试被自动权限审核拒绝，未执行该临时覆盖。
- 尚未部署、补处理生产 Session，未获得修复后定时扫描通过的证据。

## 交付状态

指标修复可审查，Issue #386 尚未完成。PR 保持 Draft，Issue 保持开放并保留 `ongoing`。
不得用 closing keyword 提前宣称完整交付，也不得放宽两小时门禁或隐藏这 3 条真实积压。
