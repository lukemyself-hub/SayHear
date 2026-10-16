# PR 审批 v12 迁移说明（最终源码已安装；受控验收待定）

本文件是 SPEC #362 → #369 的迁移 howto。`v12 / report v5` 最终源码安装已完成（控制器 `05ee8089fad58a1d49d7138a15941a8e348e60d2fd85918301fd8defcdc1d4aa`，`build.sourceCommit 7ee8e897194df8300089094cef7fac2b86e20fc1` 干净源码身份），`serialized-merge` 生效，真保护／App-only 守卫 intact；全部 completion 收据 `phase` 已 complete。先前预合入候选（`c5fa984f`，`build.sourceCommit 34ab5815`）现为旧 fallback。
一切以固定 `status` 回读为准，不以源码存在为准。

## 现状快照（2026-10-16，最终源码安装后；真实值以固定 `status` 为准）

- 已安装运行中：`v12 / report v5`（控制器 `05ee8089fad58a1d49d7138a15941a8e348e60d2fd85918301fd8defcdc1d4aa`，`build.sourceCommit 7ee8e897194df8300089094cef7fac2b86e20fc1` 干净源码身份），`serialized-merge` 生效，
  真保护／App-only main 写入守卫 intact；全部 completion 收据 `phase` 已 complete。PR #379 已合入 `7ee8e89`，PR #381 已合入 `2f52fa1`（3 笔 docs-only），两者 completion attempt 均为 1。
  先前预合入候选（`c5fa984f`，`build.sourceCommit 34ab5815`）现为旧 fallback；旧 `v11 / report v4` 备份为历史保留，本次已审查回滚恢复对象为 `c5fa984f`／`34ab5815`，不声称旧 `v11` 适用同一 helper。
  每小时自动化 `sayhear-pr` 现有 prompt 已更新为 SPEC362 worker 流程并经回读核验，当前仍 PAUSED，尚无实际 hourly 执行。
- 旧版：历史 `v11 / report v4` 已由 root 备份保留（历史，不作当前回滚依据）。本次已集成：人工最终决定、
  最新 main 组合、Provider＋行为范围、零 Issue、生命周期、归属、服务观察（均为最终源码 `7ee8e89` 及其后修复范围；完整受控验收仍待定）。最终安装／回滚 helper 已独立审查：bundle 内 605 项通过，helper `bash -n` 2 项＋收据解析 10 项通过；这只证明安装，不证明完整端到端验收。人工手动无 Issue #381 合入已完成；普通自动／hourly／main 竞态受控验收仍待定。
- History 与 thin CLI 已集成并通过审查，与其它候选模块同属本候选。
- #369 受控验收行仍待验证（人工手动无 Issue #381 合入除外）。不新增常驻服务、webhook、事件桥或统一台账。

## 前提与冻结

- 先冻结最终干净不可变提交，记录源码 manifest 与 bundle 哈希绑定。
- 用仓库 `.node-version` 指定的确切 Node（当前 `24.18.0`）构建＋验证。
- 策略／报告／旧收据兼容：不删除收据来解除占用，被阻断的操作等待人工。
- 运行时 App 私钥永不传入 worker，只走本机 Keychain 与 root-owned 配置。
- 保留已安装备份：旧 bundle、见证、config、Keychain 条目、收据。

## 安装与回滚（最终源码已安装；受控验收仍待定）

- 最终源码安装已完成（控制器 `05ee8089fad58a1d49d7138a15941a8e348e60d2fd85918301fd8defcdc1d4aa`，`build.sourceCommit 7ee8e897194df8300089094cef7fac2b86e20fc1` 干净源码身份；policy v12／report v5）；回滚恢复对象为已审查旧 bundle `c5fa984f`（`build.sourceCommit 34ab5815`），不声称旧 `v11` 适用同一 helper。普通自动／hourly／main 竞态受控验收仍待定；不虚构 installer，不声称可从未合入候选直接安装。
- 安装与回滚的共同前置条件：先读固定 `pr-approval-status`，其
  `completionStates` 不得存在任何未完成（`phase !== "complete"`）且
  `mergeSha === null` 的条目。这种条目在 v11 写入、v12 读取（反之亦然）时
  会被当作仓库级阻断，而收据永不删除，只能由人工核实实际合入状态后处理。
- 现有固定启动器均为 root-owned，不经工作区源码或 PR 脚本触碰凭证。
- 回滚为已审查旧 bundle 恢复：先确认无在途写入再恢复；
  永不假设旧 `v11` 能消费 `v12` 收据。
- 先暂停自动化并检查待收尾；不兼容的占用记录交人工，永不删除。
- 确切源码、哈希、操作员命令由协调者在冻结时填入，不提前编造。

## 已知迁移死锁（历史：预合入候选阶段记录，最终安装后仅追溯）

- 历史：旧 `v11` 要求至少 1 个开放非 keep-open 交付 Issue，
  且不能用完整人工最终决定覆盖语义标记（候选阶段死锁记录；前提公式本次不动，另任务修正）。
- #362..#369 在真正验收前保持开放；不可将 #369 指定为提前自动关闭的交付、
  不用 dummy Issue、虚假报告标记、候选自批或保护 bypass。
- 历史：尚无已证明合法的旧固定启动器迁移路径（候选阶段记录；最终安装已另行完成）。
- 历史：先产出 artifact，再由 Luke 决定迁移 bootstrap（候选阶段记录；最终安装已另行完成）；
  正式 GitHub Approve 本身不授予 root 安装权限。
- 不重复已被否决的“合入源码即关闭 #369”方案。

## 每小时候选提示词逻辑（仅候选，不启用自动化）

现有 Codex 每小时任务只调固定 `status / prepare`，再查实时 GitHub
暂停、head、范围与台账；用户所有的 worker 调度经已合入可信来源安装的
thin  helper：

```text
CI=true pnpm pr:work capture --state-dir /absolute/path/state
CI=true pnpm pr:work reserve --request /absolute/path/request.json --state-dir /absolute/path/state
```

部署收尾沿用同一 helper：`pnpm pr:deploy-closeout --pr <number>` 汇总已合入
PR 的生产部署结果（`not_required` / `succeeded` / `pending` / `failed` /
`unverified`），只读 `gh api`，不重新合入、不擅自回滚。

用法为示意占位：子命令之间以空格分隔，`capture` 不带 `--request`，
`reserve` 等才带 `--request /absolute/path/request.json`；
其中 `--owner-token TOKEN` 的 `TOKEN` 仅为元变量占位。
以上不是可直接安装执行的实际命令。

之后仍只由现有 `delegate-opencode` 做实际派发，不新增调度器。

- 每次新建／恢复前：确认旧属主已停、已释放，再做新的 null 会话预约，
  预约必须在 wrapper 调用之前。
- null／unknown 阻断第二个写入者；实际收据绑定 attempt／角色／任务／
  head／范围；中断保留已有部分改动。
- wrapper 核验当前有效 role／model／effort，故障不静默切换模型；
  confirmed／refuted／disputed 的 finding 均由 Codex 核验后再修复。
- 恢复用原实现会话，审查用全新独立会话；Codex 在 commit／push 前核验
  实际 diff 与测试。
- 同一 PR 最多三轮代码修复审查，由控制器以可信 PR 历史拥有轮次；
  不清／被反驳的不自动改；遇暂停即停。
- 轮次与暂停在 `pr:work` 侧依赖协调者在每次 reserve 前立即读取 `prepare` 输出，把其中
  的 controller `ledger` 快照（执行轮次、暂停标记、历史一致性；`pr:work` 自身不持有
  或重算，原样传给 `reserve`）连同绑定的 head 与观测时间一起使用；观测晚于 reserve、
  head 漂移或 `prepare` 已过期时该快照不再可信，须重新 `prepare`。暂停生效时协调者
  必须对在途 worker 调用 `pr:work stop`：它只停会话，返回 `awaiting_release`，随后仍
  需 `release` 才解除占用；已停止且已释放的旧 worker 才不算第二个写入者。
- Luke 有效 Approve 后停止语义审查重复，只做常规 CI／版本／保护核验。
- 依实际需要的部署才跟进，否则静默 noop。不启用任何实际自动化。

## 受控验收矩阵（分组 SPEC AC01..16）

- 普通修复＋全新审查通过；未知／人工接管／P2／证据缺口走人工。无 Issue 的普通 PR 证据齐备时走自动通路，不写任何 Issue。
- 伪造身份／CI 不良／冲突阻断；新 head／实质范围变化重新 Approve；
  普通评论／标签／CI 更新不撤销已有 Approve，main 前进只做重组合不重新 Approve。无例外。
- 最新 main 竞态／树身份／重放按组合重验；超时重叠／取消恢复／三轮预算
  按控制器拥有计数。
- Issue 写入精确绑定，部署异常如实报告；每小时发现恢复静默。
- 所有真实外部行均为待验证，源码夹具另计。
- 本地真实 worker smoke：实际实现会话＋独立审查通过；
  占用 null／running 拒绝第二个写入者；
  停止保留部分改动且同一实现恢复＋全新预约通过。
  这只是叶子模块证明，不是最终 CLI／hourly／App gate／合入证明。
