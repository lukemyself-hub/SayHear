# 故障矩阵与组合版本（T07 #320，给 T08 #321）

稳定可运行环境 = 本包的 `pnpm acceptance:continuity ...`（真实聊天路由 + 真实 `next dev`，只替换外部 Provider）加下表的进程内系统套件
（真实 Service / Harness / Compiler / Egress / PostgreSQL，只替换模型）。**组合版本**用 `pnpm acceptance:continuity versions` 取得：
提交、迁移摘要（最新 `0081_history_recall_governance.sql`）、全部历史路径版本（`history-recall:v4`、`conversation-harness:v4`、
`history-experience-search:v1`、`task-instruction-history-answer:v1/v2`、`history-reading:v1`、两个 Compiler 版本、人格版本）、验收包 fixture 摘要，
并给出一个指纹。T08 的每次运行应记录该指纹。

开关：`SAYHEAR_HISTORY_RECALL_ENABLED`（部署，默认 false）。验收环境与系统套件另需 history-recall 治理版本为 active：验收 harness 经真实操作路由
`POST /api/internal/operator/history-recall {"action":"enable"}` 启用；关闭同一路由 `{"action":"disable"}`。七天背景由独立的
recent-context 治理控制，互不影响。

每一行的“证明”列写的是测试文件与用例名片段；`tests/continuity-fault-matrix.test.ts` 机械核对这些文件与用例名仍然存在。

| # | 故障 / 竞态 | 注入方式 | 期望的可观测结果 | 证明 |
| --- | --- | --- | --- | --- |
| 1 | Correction（改写某条用户消息）落在读取前/读取后/冻结后/编译后/首 token 前/首 token 后，三个入口 | `tests/support/history-path-harness.ts` 钩子 + 真实 `conversationService.correct` | 旧原文及其绑定的 Assistant 回复零出站（发送前之后到达的控制则零新展示、零接受）；独立允许来源仍可用 | `tests/system/history-source-control.system.test.ts`：`a control that lands at any point of a history request`（`<entrance>: correct <point>`） |
| 2 | Forget（明确关联的 Evidence 排除）同上 6 个点，三个入口 | 同上 + 真实 `memory_forget_*` 行 | 同上 | `history-source-control.system.test.ts`：`a control that lands at any point of a history request`（`<entrance>: forget <point>`） |
| 3 | Data Epoch 变化（Purge 围栏）读取后/编译后/首 token 后 | `bumpEpoch` | 结果被拒、答案不发送；首 token 后只留 interrupted，无 Assistant Event | `history-source-control.system.test.ts`：`a control that lands at any point of a history request`（`<entrance>: epoch <point>`） |
| 4 | 被拦截的 History Answer 被恢复扫描捞起；Forget 后重问 | `scanPendingHistoryAnswers` | 不重发、不复活旧引用 | `history-source-control.system.test.ts`：`recovery scan finds it after a Forget` |
| 5 | Full Purge 落在 读取后/冻结后/编译后/首 token 前，及 Decision 进行中 | `fullPurge()`（真实 `PostgresOwnerPurgeRepository` + marker） | 零行残留、零 Assistant Event、不再发送；恢复扫描无事可做 | `tests/system/history-purge-recovery.system.test.ts`：`purge lands` |
| 6 | Purge 注册清单与实际读写面一致 | 记录历史回合内每条 SQL 的表名 + 行数增量比对 | 每个触达的表都在注册表或是无内容的全局策略表 | `history-purge-recovery.system.test.ts`：`registered for Purge` |
| 7 | 清除后全库残留 | 整库按文本扫描原话与检索线索 | 清除前持有、清除后零命中 | `history-purge-recovery.system.test.ts`：`removes the words, the search clue` |
| 8 | 旧备份恢复 + marker 重放，含新数据面 `history_recall_results` | 恢复后插入含线索的结果行，重放 marker | 行被清除、不复活 | `tests/system/g1-purge-restore-drill.system.test.ts`：`restore and marker reapply` |
| 9 | 关闭历史分支（运行前） | `disableGovernance` | 不提供函数、普通单 command 回复、不声称查过历史；七天背景不变；关闭/开启/未部署三种状态下普通回合 Context 逐字相同 | `tests/system/history-recall-governance.system.test.ts`：`closing the history branch` |
| 10 | 运行中关闭：Decision 中/读取后冻结前/冻结后/编译后/首 token 前/首 token 后 | 钩子内 `disableGovernance` | 不再发送、不展示、不提交；首 token 后已展示文字不撤回但不提交 | `history-recall-governance.system.test.ts`：`a running request stops by rule` |
| 11 | 重新启用不复活 | 关闭后 Forget，再启用；冻结在旧版本的结果 | 旧结果仍不可用（含恢复扫描），Forget 仍生效；既有 Context 行逐字不变 | `history-recall-governance.system.test.ts`：`opening the branch again revives nothing` |
| 12 | 读取为空 / 部分 / 失败的区分 | 窄页预算、失败的来源桩、空日期 | Inspector 状态与实际 payload 的 `Read status` 一致，诊断分别给出 empty / partial / failed | `tests/system/history-diagnostics.system.test.ts`：`empty, partial and failed reads` |
| 13 | 五类问题定位（无来源/选漏/时间丢失/读取失败/生成错误） | 证据来自权威历史 + Inspector + 实际出站请求 | 各自判定；生成错误只能来自语义裁定，缺裁定为 `undetermined` | `history-diagnostics.system.test.ts`：`a complete read`、`the other faults` |
| 14 | 从 Inspector command 追到实际 Provider 请求 | `providerRequestId` 与桩的 `x-request-id` 对齐 | 诊断 trace 指向同一次 Provider 调用 | `tests/system/continuity-acceptance.system.test.ts`：`keeps corrected and forgotten sources` |
| 15 | 原文展开权限 | 无 capability / 过期 step-up / 合格 | 固定拒绝码且不含查询、人物、范围；合格时只返回仍允许的来源 | `history-diagnostics.system.test.ts`：`opening the original words` |
| 16 | 日志无正文 | 整个历史回合后读取 app 进程输出 | 不含任何种子原话或其 12 字片段 | `continuity-acceptance.system.test.ts`：`keeps corrected and forgotten sources` |
| 17 | Provider 卡住 / 超时 / 补充输入 / 取消 / 重发 / 重启恢复 | T06 `conversation-request-lifecycle` 与验收案例 L01、C10 | 30 秒内终止、无迟到续答、幂等 | `tests/system/conversation-request-lifecycle.system.test.ts` |
| 18 | 失败重试 / 重复分发 | T01 套件 | 一个 Assistant Event，不重读历史 | `tests/system/history-recall.system.test.ts`：`retries the answer stage` |

## 已知不能撤回或未覆盖的边界（如实）

- 首个可见 token 之后才到达的控制：已展示文字不可撤回；系统保证它不被提交、不被后续轮当作事实，Turn 为 `interrupted`，用户显式 Retry。
- 通过 HTTP 并发触发 Full Purge 无法在验收 CLI 内读回（Purge 会撤销该 owner 的 Web 会话），所以 C12 的 `O-purge-race` 保持 `not-run`；
  Purge 竞态由第 5–8 行的进程内证明承担。
- 真实模型是否会为带感受的当前表达调用接续、是否遵守阅读合同，仍待 T08 用真实模型验收（见 #315–#319 交接）。
- 用户自己此后对旧说法的不相关复述不被排除（ADR-0149 范围）；C12 把它记录为已接受的局限，由语义裁定判断“旧数字不被当作现在”。
