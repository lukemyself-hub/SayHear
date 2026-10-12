---
status: accepted
date: 2026-07-26
---

# Generation Commands Use Versioned Freshness Policies

每个异步或可恢复 `GenerationCommand` 必须冻结一个版本化 `freshness_policy` 和具体
source revision / coverage。提交前按命令语义使用 `exact_head`、`source_valid` 或
`monotonic_projection` 判断结果是否仍可写入，不能由各 Workflow 临时手写新鲜度规则。

Journal publish、current Reflection 等要求 exact head；只要原 Evidence 仍有效即可
追加的派生物使用 source valid；Summary、DialogueState 等投影只能单调推进 coverage。
任何删除、epoch 变化或 source invalidation 都优先 fail closed，旧 command 不能覆盖
新 revision 或复活数据。

## 修订（2026-10，issue #319，ADR-0152）：对话响应的请求截止与最新输入围栏

对话响应链上的 GenerationCommand（`decision`、`action_finalization`、`history_answer`）在
`source_valid:v1` 之外，冻结两条**具名**规则；`freshness_policy` 本身与它的 CHECK 约束不变，
规则记在两个新增的可空列上（迁移 0080），旧命令为 NULL 并保持旧行为。`latest_input_fence_version` 是无 CHECK 的
版本文本列，而不是 `freshness_policy` 的新取值：`freshness_policy` 的 CHECK 属于受 G1 schema 守卫保护的约束，
不能为此修改，所以新规则以独立、可空、带版本名的列表达，守卫也不需要为它开例外：

- **`request_deadline_at`**：请求被接受时冻结的绝对截止时刻（整体请求 30 秒，ADR-0152）。各阶段共用
  剩余时间，不重新领取：截止后不再开始新步骤（Provider 派发、技术重试与退避、历史回答、提交），不展示、
  不提交迟到结果。Finalization 与 History Answer 从 Decision 命令复制该列。技术重试只在重试时刻早于
  截止时才被安排；请求已结束（截止或取消）永不重试。恢复扫描遇到截止已过的未结算命令直接终止它，
  不续跑，也不等待长恢复窗口。
  **空正文的技术重试（2026-10-12，Luke 确认，SPEC #301）。**回复调用正常结束但没有任何可见正文（只有推理；真实模型在
  历史回答与基准中都出现过）不再立即失败关闭：它与超时 / 限流 / 不可用一样，作为同一 Command 的一次技术重试，
  条件相同——重试时刻早于截止、请求未结束、未超过恢复策略的尝试上限——并且**只有该 Command 的第一次尝试**可以为此重试，
  所以最多重试一次；第二次仍为空（或在其他重试之后为空）照旧以 `invalid_response` 失败关闭。只认已证明的原因
  （`ProviderResponseFailure.kind = empty_output`，由适配器或 Harness 在「调用完成且正文长度为 0」时给出），
  格式错误的流、模型身份不符、被截断等其他 `invalid_response` 不重试。重试是一次新的 ModelRunAttempt，走普通派发路径：
  `claimDispatch`、Egress 重推导与来源重新过资格、首个可见 token 前探针、提交围栏全部重新执行；空的那次没有任何内容
  上屏或提交，两次调用的 usage 各自记在自己的 attempt 上。适用于 Decision、Action Finalization 与 History Answer。
- **`latest_input_fence_version = latest_user_input:v1`**：回答只有在其输入仍是所属 Daily Session 最新的用户
  文本消息（含显式 Retry 动作）时才可保留。更新的用户消息一经接受，旧待完成回答即失去展示与提交资格。

检查点各自独立：首个可见 token 前的探针（使被取代的回答不上屏）、`claimDispatch`（不派发）、
`commitCompleteResponse`（正确性围栏，同一 SERIALIZABLE 事务内重验）、恢复扫描。探针是单条只读、幂等查询：
抛错或超时（短超时）时立即就地重探一次；仍失败则**失败关闭**——这条回答不展示、不提交，attempt 按
「中断」结算（此时 Provider 首 token 已落库，所以是 interrupted、不排技术重试，流事件与库状态一致），人可显式
Retry。探针与重探同样受请求截止与取消约束，请求已结束则以截止/取消结算，不再重探。提交围栏仍是正确性保证，
探针只决定是否把可能已被取代的文字送上屏。**取消信号只是优化而不是
正确性来源**：进程内新消息会取消旧请求，但跨进程时数据库围栏单独保证旧结果不展示、不提交。围栏冲突产生的
可串行化失败（40001）在这些事务上重跑，因为新消息与旧回答的结算并发是预期情形。
