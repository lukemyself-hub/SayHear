# PR 审批 v12 迁移说明（最终源码已安装；受控验收进行中）

本文件是 SPEC #362 → #369 的迁移 howto。`v12 / report v5` 最终源码安装已完成（控制器 `5c454fdda28f3807e556f0c40ec7be0e91596147e6a90a0df69848d210129fbe`，`build.sourceCommit 2cdf0c60defc683dc06314dece2ca7193853dd5a` 干净源码身份，PR #384 合入），`serialized-merge` 生效，真保护／App-only 守卫 intact；2026-10-17 快照全部 19 项 completion 收据 `phase` 已 complete 且 attempt 均为 1（#348、#351、#352、#356、#359、#361、#373、#376、#379、#381、#383、#384、#385、#387、#388、#390、#391、#392、#394）（真实值以固定 `status` 为准）。先前最终源码（`05ee8089…`／`7ee8e89`）现为已审查回滚恢复对象；`c5fa984f`／`34ab5815` 为更旧 fallback，仅历史保留。
一切以固定 `status` 回读为准，不以源码存在为准。

## 现状快照（2026-10-17 历史保留；现行以 2026-10-18 增量为准，真实值以固定 `status` 为准）

- 已安装运行中：policy `sayhear-pr-review-gate:v12`／report `sayhear-pr-review-report:v5`（控制器 `5c454fdda28f3807e556f0c40ec7be0e91596147e6a90a0df69848d210129fbe`，`build.sourceCommit 2cdf0c60defc683dc06314dece2ca7193853dd5a` 干净源码身份，PR #384 合入），`serialized-merge` 生效，
  真保护／App-only main 写入守卫 intact；2026-10-17 快照全部 19 项 completion 收据 `phase` 已 complete 且 attempt 均为 1（#348、#351、#352、#356、#359、#361、#373、#376、#379、#381、#383、#384、#385、#387、#388、#390、#391、#392、#394）（真实值以固定 `status` 为准）。
  先前最终源码（`05ee8089…`／`7ee8e89`）现为已审查回滚恢复对象（升级／回滚对恢复它）；`c5fa984f`／`34ab5815` 为更旧 fallback，仅历史保留；旧 `v11 / report v4` 备份为历史保留，不声称旧 `v11` 适用同一 helper。
  每小时自动化 `sayhear-pr` 现为 ACTIVE，但受控验收期内仅处理 `sayhear-pr` automation 当前 prompt 指定的 PR；2026-10-16 22:55Z 与 23:54Z 两次受控运行仅观测（未 reserve／派发／合入），其后定时运行因 Codex App `execution-config-loading` 错误未执行（立即运行同样报错），重启后已恢复；#385 上 hourly 已真实完成发现、派发独立 review、确认缺陷修复派发与新会话复审，普通自动合入 `e2ef35b`。
- 旧版：历史 `v11 / report v4` 已由 root 备份保留（历史，不作当前回滚依据）。本次已集成：人工最终决定、
  最新 main 组合、Provider＋行为范围、零 Issue、生命周期、归属、服务观察（均为最终源码 `2cdf0c6` 及其前修复范围；完整受控验收仍待定）。
  PR #384（已合入 `2cdf0c6`）：未解决外部 review thread 不再遮蔽可执行的 `request_changes`（decision 加至少一个 P0/P1/P2 finding），其余仍走人工。
  最终安装／回滚 helper 已独立审查：bundle 内 607 项通过，安装与回滚 helper 各 `bash -n`＋收据解析 10 项通过；这只证明安装，不证明完整端到端验收。
  人工手动无 Issue #381 合入已完成；#383 在其被审 head `2c5f82e` 上由 Luke 一次 Approve 后经 submit 首次即合入 `aa45552`，completion 收据 attempt 1；#383 另观测到一次最新 main 竞态（main 到 `2cdf0c6` 后 submit 按当前 main 重建 merge ref `a88b1cc` 并派发 Validate，首 run 取到旧 merge `f004c12` 被判 stale 证据驳回，重派后 `a88b1cc` 上 run 通过被接受）。
  普通自动合入（#385 已有真实证据：无 Issue 纯文档，Luke 未作任何 review 或决定；hourly 发现并派发独立 review 确认真实 P2 后控制器 `request_changes` 到 `e2ef824`，确认缺陷后派发修复并由授权协调者核验 diff 后推送 `95e2f71`，全新独立会话复审通过后普通自动合入 `e2ef35b`，无需部署、无 Issue 写入，completion 收据 attempt 1）、#387 人工最终决定合入、真实 PR 上转人工路由（#390、#391 首轮、#394，未解决外部 review thread）、#391 交付 Issue 的普通自动合入与控制器 Issue 收尾、#395 双唤醒重叠真实观测（详见下文真实运行记录：same-head `already_reviewed` exit 2 与 `owner_store_misplaced` exit 1 为真实运行观测，helper 层 owner 忙拒绝仍仅源码／测试证明，不再要求另一次重叠运行）已有真实证据；2026-10-17 当时仍待验证中必须真实运行的为（中断 worker 跨小时恢复、Luke 暂停／撤回、真实 PR 上冲突与 CI 失败、main 前进复用既有 Luke 批准），其中后三项已在 2026-10-18 由下文真实运行记录证明，详见“真实运行记录（2026-10-18 UTC 追加）”，本快照其余历史语句保留；夹具已接受＋`awaiting_verification`（不记为真实 E2E 通过）：三轮预算耗尽、多 Issue 部分收尾、需部署 PR 与部署失败；未知路由已有 #365 下测试证明已接受，不记为真实 E2E 通过。不声称任一完整 AC 已通过，完整结论以受控验收矩阵及 2026-10-18 增量为准。
- History 与 thin CLI 已集成并通过审查，属已安装最终源码 `2cdf0c6` 一部分。
- #369 受控验收行仍待验证（人工手动无 Issue #381 合入、#383 人工最终决定合入、#383 上观测到一次的最新 main 竞态、#385 hourly 发现／独立 review 派发／确认缺陷修复派发／全新复审／普通自动合入、#387 人工最终决定合入、真实 PR 上转人工路由（#390、#391 首轮、#394）、#391 交付 Issue 的普通自动合入与控制器 Issue 收尾、#395 双唤醒重叠真实观测行除外）。不新增常驻服务、webhook、事件桥或统一台账。

## 前提与冻结

- 先冻结最终干净不可变提交，记录源码 manifest 与 bundle 哈希绑定。
- 用仓库 `.node-version` 指定的确切 Node（当前 `24.18.0`）构建＋验证。
- 策略／报告／旧收据兼容：不删除收据来解除占用，被阻断的操作等待人工。
- 运行时 App 私钥永不传入 worker，只走本机 Keychain 与 root-owned 配置。
- 保留已安装备份：旧 bundle、见证、config、Keychain 条目、收据。

## 安装与回滚（最终源码已安装；受控验收进行中）

- 最终源码安装已完成（控制器 `5c454fdda28f3807e556f0c40ec7be0e91596147e6a90a0df69848d210129fbe`，`build.sourceCommit 2cdf0c60defc683dc06314dece2ca7193853dd5a` 干净源码身份，PR #384 合入；policy v12／report v5）；回滚恢复对象为已审查旧 bundle `05ee8089…`（`build.sourceCommit 7ee8e89`），不声称旧 `v11` 适用同一 helper。普通自动合入（#385 已有真实证据：普通自动合入 `e2ef35b`）、#387 人工最终决定合入、真实 PR 上转人工路由（#390、#391 首轮、#394，未解决外部 review thread）、#391 交付 Issue 的普通自动合入与控制器 Issue 收尾、#395 双唤醒重叠真实观测（same-head `already_reviewed` exit 2 与 `owner_store_misplaced` exit 1 真实运行已观测；helper 层 owner 忙拒绝仍仅源码／测试证明，不再要求另一次重叠运行）、hourly 发现／派发（#385 已有真实证据）已有真实证据；其余仍待验证中必须真实运行的仅为（中断 worker 跨小时恢复、Luke 暂停／撤回、真实 PR 上冲突与 CI 失败、main 前进复用既有 Luke 批准）；夹具已接受＋`awaiting_verification`（不记为真实 E2E 通过）：三轮预算耗尽、多 Issue 部分收尾、需部署 PR 与部署失败；未知路由已有 #365 下测试证明已接受，不记为真实 E2E 通过；不虚构 installer，不声称可从未合入候选直接安装。
- 安装与回滚的共同前置条件：先读固定 `pr-approval-status`，其
  `completionStates` 每一项都必须 `phase === "complete"`（无论 `mergeSha` 是否为空）。
  helper 先做该检查，再在维护锁下重读 `pr-approval-status` 复核一遍后才 staging；未完成收据阻断维护且永不删除，只能由人工先核实实际合入状态再处理。
  控制器将未完成收据至少视为该 PR 阻断，其中 `mergeSha === null` 者（含 v11 写入、v12 读取，反之亦然）可为仓库级阻断；两种情形维护均等待。
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

## 每小时提示词逻辑（当前 ACTIVE，受控验收期内仅处理 `sayhear-pr` automation 当前 prompt 指定的 PR）

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
- 未派发的 null 会话预约由持 token 者直接 `release` 释放，不探活、无需 `stop`；无 token 或 token 不符永不释放。派发检查绑定本次预约的 attempt：本轮 session.json 已写（attempt 达本轮或 running／不可解析）时拒为 `dispatched_unattached`（held 类，exit 2），须先 `attach` 再走正常 stop／release；上一轮终态收据不阻断复用同一目录的新预约。释放与派发不可并发：持 token 者须先停派发再释放。
- 同一 head＋changeDigest 已有 accept 的 code-review 结果时，再次 `reserve` 同角色返回 `already_reviewed`（held 类，exit 2）；request 置 `"reReview": true` 才显式复审。只记最近 20 条已接受审查。
- owner store 在代码中 pin 定共享路径 `/Users/lukemyself/.codex/automations/sayhear-pr/pr-work-state`，任何其它 `--state-dir`（含干净 sibling／误拼目录、无 env／flag 覆盖）均拒为 `owner_store_misplaced`（exit 1，不写任何状态）；与 worker task state 目录相同或互为父子、或含 wrapper 产物亦拒；派发须在前台运行。
- Luke 有效 Approve 后停止语义审查重复，只做常规 CI／版本／保护核验。
- 依实际需要的部署才跟进，否则静默 noop。本节不新增部署自动化；每小时 `sayhear-pr` 现为 ACTIVE，受控验收期内仅处理 `sayhear-pr` automation 当前 prompt 指定的 PR；重启后已恢复，#385 上 hourly 已真实完成发现、派发独立 review、确认缺陷修复派发与新会话复审，普通自动合入 `e2ef35b`。

## 受控验收矩阵（分组 SPEC AC01..16）

- 普通修复＋全新审查通过；未知／人工接管／P2／证据缺口走人工。无 Issue 的普通 PR 证据齐备时走自动通路，不写任何 Issue。
- 伪造身份／CI 不良／冲突阻断；新 head／实质范围变化重新 Approve；
  普通评论／标签／CI 更新不撤销已有 Approve，main 前进只做重组合不重新 Approve。无例外。
- 最新 main 竞态／树身份／重放按组合重验；超时重叠／取消恢复／三轮预算
  按控制器拥有计数。
- Issue 写入精确绑定，部署异常如实报告；每小时发现恢复静默。
- 人工手动无 Issue 合入（#381）、#383 人工最终决定合入、#383 上观测到一次的最新 main 竞态、#385 hourly 发现并派发独立 review、#385 确认缺陷后修复派发与授权协调者推送、全新独立会话复审通过、#385 普通自动合入（无 Issue 纯文档、无 Luke 决定、无需部署、无 Issue 写入）、#387 人工最终决定合入、真实 PR 上转人工路由（#390、#391 首轮、#394，未解决外部 review thread；#391 为历史第二例，其时间戳见下文真实运行记录）、#391 交付 Issue 的普通自动合入与控制器 Issue 收尾、#395 双唤醒重叠真实观测（same-head `already_reviewed` exit 2 与 `owner_store_misplaced` exit 1 真实运行已观测）行已有真实证据；其余仍待验证中必须真实运行的仅为（中断 worker 跨小时恢复、Luke 暂停／撤回、真实 PR 上冲突与 CI 失败、main 前进复用既有 Luke 批准）；夹具已接受＋`awaiting_verification`（不记为真实 E2E 通过）：三轮预算耗尽、多 Issue 部分收尾、需部署 PR 与部署失败；未知路由已有 #365 下测试证明已接受，不记为真实 E2E 通过。源码夹具另计。不声称任一完整 AC 已通过。
- 本地真实 worker smoke：实际实现会话＋独立审查通过；
  占用 null／running 拒绝第二个写入者；
  停止保留部分改动且同一实现恢复＋全新预约通过。
  这只是叶子模块证明，不是最终 CLI／hourly／App gate／合入证明。

## 受控验收证据口径（Luke 2026-10-17 裁定）

- 仍待验证行中必须真实运行的：main 前进复用既有 Luke 批准、Luke 暂停／撤回、hourly 双唤醒并发重叠、
  中断 worker 跨小时恢复（`pr:work stop` 后同一会话恢复）、真实 PR 上文档级冲突与 CI 失败。
  上文已有真实证据的行不受本节影响。
- 允许以源码夹具证明并标记为待验证（`awaiting_verification`）：三轮整改预算耗尽、多 Issue 部分失败收尾、
  需部署 PR 与部署失败。这些行在真实场景自然出现前不算真实外部证据，也不据此声称对应 AC 完整通过。
  对应夹具：`tests/pr-approval-controller.test.ts` 中 “keeps the PR-level budget when the third round
  pauses even with zero Issues”、“recovers multi-Issue closure after a partial failure using live merge
  and App approval”、“recovers a partial multi-Issue close without a second merge”；
  `tests/pr-approval-deployment-closeout.test.ts` 中 `deploymentRequired` 与 `decideDeploymentCloseout`
  （含 “reports failure as fact without retrying”）。
- 每行证据须注明来源（真实运行的 PR／回执，或夹具测试名），两类证据不混记。

### 真实运行记录（2026-10-17）

- #388 hourly 双唤醒重叠（Luke 05:41Z 连点两次“立即运行”）：两轮从未同时持有写入权（第一轮 reserve → 派发
  `ses_eb798dd6` → accept → release 后，第二轮才 reserve 成功）。但第二轮未重复派发 reviewer 只因碰巧复用同名
  worker state 目录被 wrapper 拒绝，且未绑定会话的预约无合规释放路径，该轮直接编辑了 owner store。
  本行记为部分证据：无并发第二 writer 已真实观测；重复派发防护与预约释放缺口见 #389，修复前不算通过。
- #388 确认缺陷整改：控制器 `request_changes` 到 `02fadb7`（P2 token 不一致），授权协调者推送修复 `327da3b`，
  hourly 全新独立会话复审通过，submit 后普通自动合入 `b3e4ba3`，completion 收据 attempt 1，无 Issue 写入、无需部署。
- 人工最终决定的 challenge 时序：Luke 在 #387 上的 Approve（05:41:32Z）早于该 PR 首次 `prepare` 冻结
  final-decision challenge（06:08:52Z），watermark 把这条 review 记在 challenge 之前，因此不构成人工最终决定。
  需要 Luke 批准的 PR 必须先 `prepare` 冻结 challenge，再请 Luke Approve（与 #382 同类现象）。
- #387 人工最终决定合入：首次 Approve（05:41:32Z）不计数后，Luke 在冻结后再次 Approve（06:11:39Z），该 Approve 构成人工最终决定；humanChannel browser 在 head `0e6c4b7` 上合入 `9b7941a`（06:45:31Z），completion 收据 `~/Library/Application Support/SayHear/PRApproval/completions/pr-387.json` attempt 1。
- #390 真实 PR 上转人工路由：未解决外部 review thread（chatgpt-codex-connector，06:12:15Z）使控制器回 `human_decision`，未走自动批准；Luke Approve（06:27:52Z）后 humanChannel browser 在 head `3a7e675` 上合入 `832213e`（06:28:56Z），completion 收据 `~/Library/Application Support/SayHear/PRApproval/completions/pr-390.json` attempt 1。
- #391 交付 Issue 的普通自动合入与控制器 Issue 收尾：首轮 head `3c99321` 上 hourly 已派发全新独立 review（approve），控制器因 chatgpt-codex-connector 未解决 P1 thread 回 `human_decision`（转人工路由第二例）；协调者确认为真实 P2 后推送修复 `74d968f` 并在该 thread 回复（未 resolve），Luke resolve 该 thread（Luke 未 Approve）；`74d968f` 上 08:25Z hourly 派发全新独立 review（approve，zero findings），09:06Z—16:17Z 共 8 轮 hourly 见到当前 head 已接受 review 未再派发（hourly prompt 规则约束；helper 层 `already_reviewed` 拒绝仅源码／测试证明，未在真实运行观测）；协调者 submit 得 `merge_candidate` 后由 app／sayhear-pr-review-gate 以 humanChannel app 合入 `a9bd894`（16:32:08Z，无 Luke 决定），控制器收尾关闭 Issue #389，completion 收据 `~/Library/Application Support/SayHear/PRApproval/completions/pr-391.json` attempt 1。
- #389 已合入并关闭；#388 重叠行仍记部分证据，在 post-#389 helper 上重观前不算通过。
- #392 双唤醒重叠（Luke 连点两次"立即运行"）：第一轮把 worker 目录当 owner store，第二轮在共享 store 再次 reserve 成功并后台派发（派发未启动，随后合规释放）；单写入者在 store 层失效，本行记为失败，修复见 #393，合入后须真实复测。
- #394（修复 #393）真实 PR 上转人工路由第三例：首版 `858112a` 只拦已知错误形态，chatgpt-codex-connector 留 P1 thread（干净兄弟目录或误拼路径仍可分裂 owner）使控制器回 `human_decision`；协调者确认后推送 `fac1191`，在代码中 pin 定 owner store 路径并回复该 thread（未 resolve），Luke resolve（未 Approve）。`fac1191` 上 hourly 20:05Z 用共享 store、前台派发独立 review（approve，zero findings；前两次派发因 reviewer grep 工具参数错误被拦，合规释放后以自含任务第三次完成）；协调者 submit 得 `merge_candidate`，app 通道合入 `6d6c8ea`（20:26:29Z，无 Luke 决定），控制器收尾关闭 #393，completion 收据 `~/Library/Application Support/SayHear/PRApproval/completions/pr-394.json`。可信 runtime helper 已更新到 `6d6c8ea`；双唤醒重叠须在其上真实复测后才算通过。
- #395 双唤醒重叠复测（post-#393 helper `6d6c8ea`，Luke 连点两次"立即运行"）：20:36:08Z 一轮在共享 store reserve，前台派发全新独立 review（approve，zero findings），随后 attach／status／accept／release 均成功；20:37Z 另一轮读到共享 store 已有 owner，未 reserve、未派发，只写回执。协调者随后在同一 head 以共享 store 调 `pr:work reserve`（无 reReview）得 `already_reviewed`（exit 2，未写预约）；以兄弟目录作 `--state-dir` 得 `owner_store_misplaced`（exit 1，目录未被创建）。全程只有一个 reviewer，单写入者在真实运行中成立。第二轮是读 store 后主动让出，未调用 helper，故 helper 层"owner 忙"拒绝仍只有源码／测试证明。#395 的提交说明含英文关闭关键字指向已关闭的 #393，与正文 keep-open 声明冲突，控制器回 `human_decision`（`closing_set_outside_delivery`）；改以干净提交说明重提，#395 关闭不合入。

### 真实运行记录（2026-10-18 UTC 追加；现行增量，历史行原样保留）

- #398 撤回／暂停／恢复／重新批准／合入：同一 head 上真实 `Request changes` review `5560806930` 撤回既有 Approve；暂停评论 `6243785758`、恢复评论 `6243974612`。恢复后 `prepare` 返回 `paused=false`、`reviewId=None`；同 head 绿色 CI 下固定 `submit` 返回 `human_decision_required`（00:59:47Z），证明恢复不复活已撤销批准。Luke 在 `865d061` 上新的实际 Approve `5560922552`（01:21:58Z）；普通恢复评论引起的需求摘要漂移经 `scopeReconciliation unchanged` 对账（冻结 `eb40af68` →实时 `f8c5a5ae`），`submit` 合入 `4c16797`（01:25:32Z）。普通评论不需要新的 Approve。`completion` 记录 `phase: complete`、attempt 1。
- #397 main 前进后沿用原批准合入：head `91a1d50f8009da8a494ca4822f586bab3cc54b4b` 未变；原 Luke review `5560782821` 在 main `546d1b89da64c9c5e4e745b10db98a9989ef4de4` → `4c167973294ba66e99945d6194e515f6e9c487b2`（#398 合入）后保留。`prepare` 沿用原批准，覆盖需求摘要 `cbced0`。run `39086489946` 虽成功，但其 provenance 实际 checkout 旧 main `546d1b8` + head（checkout `52df8f2`），已被驳回，不作为新组合证据；仅 run `39086921689` 正确 checkout 当前 main `4c16797` + `91a1d50`，完整 CI 成功后合入 `4b2ad104cc43c87b0e1ffc42cef5ab55b7015b61`（2026-10-18T01:42:11Z）。已测组合 `6fac6f6d745c502be603b624361327b7a6bc9d01` 与实际合入的双亲与 tree（`089b1fbeb82441c6a9e081cdf242729af9bd187f`）一致，`sameTree=true`、`sameParents=true`。两份报告均为诚实 approve；仅因 main 前进未新增语义审查，diff 摘要未变。`completion` 记录 `phase: complete`、attempt 1。
- #400 红 CI 阴性验收：载体 head `b6d353a626a7cbc0036cda16b658e11fb6e2d347`，仅新增 1 个故意失败的合成断言；hosted Validate run `39083902634` 为 `failure`（1 failed／3427 passed）。Luke 在当前 head 的真实 Approve `5560861835`（00:57:28Z）经 `prepare` 绑定；诚实报告为 `awaiting_verification`，`submit` gate 为 `failure`（`review_awaiting_verification`），GitHub 回读 `merged=false`，随后关闭且未合入。机制为 approve-present + 红 CI 被拒：受信源码（`546d1b8`）仅在 `validate` 成功时认定 workflow 可信，红 CI 下 `trustedWorkflowBlobSha=null` 使 `hasHumanFinalDecision` 不成立，退回自动通路后同样拒绝。这证明未观测到不安全合入；未声称实际看到 `required_evidence_missing`，也未声称进入人工通路证据核验分支。证据见 #400 评论 `6243982041` 与 #364 评论 `6243982347`。不改代码，不为凑期待码重写 approve 报告。
- #399 真实冲突关闭未合入：head `4a082d78c5c426ad6e1a4e1f01c8a292dcd9a548`、base `546d1b89da64c9c5e4e745b10db98a9989ef4de4`，GitHub 回读 `mergeable=false`／`mergeable_state=dirty`；固定 `prepare` 返回 `pull_request_conflict`（2026-10-17T21:32:01Z），证据见 #364 评论 `6241437020`。#397 真实暂停／恢复证据见 #363 评论 `6243589043`（`paused=true` → reserve exit 2 `reason=paused` →恢复后 `paused=false`）；暂停时无在途 worker，故不记为在途取消证明。
- 固定 `status` 现行（#397 合入后回读）：安装源 `2cdf0c60defc683dc06314dece2ca7193853dd5a`，控制器 `5c454fdda28f3807e556f0c40ec7be0e91596147e6a90a0df69848d210129fbe`，`sayhear-pr-review-gate:v12`／`sayhear-pr-review-report:v5`，`serialized-merge` 生效。文档 PR 未改配置与构建；受信 helper 源 `546d1b8`；文档 PR 无需部署。
- 每小时任务现行：仍为 ACTIVE，临时观察范围为 #397，该 PR 现已合入，属待清理的事实状态；此处不声称已恢复常态，也不预写未来常态完成口径。#371 始终排除在外。
- 未关闭的缺口（2026-10-18 UTC 口径）：跨小时同一会话 stop／保留改动／re-reserve／resume 经现有 hourly 恢复仍未验证；#397／#398 均为批准后合入，不存在可用的真实缺陷载体，不能虚构缺陷历史，也不能把所有者撤回当作代码缺陷；需真实未来缺陷或 Luke 明确接受决定。现有 fixture 与 transport 测试不等于受控 PR 的 hourly 恢复证据。AC-10／AC-12 在途取消部分／AC-16 与 #368 保持开放；Luke 此前仅对三轮预算耗尽、部署示例、多 Issue 部分收尾接受 fixture＋`awaiting_verification`，跨小时恢复尚无新的接受决定。AC-03 是否有 Luke 带已知 P2 合入的真实证据，需以实际来源记录为准，否则记部分；AC-04 的伪造身份／无效批准／不可信 CI／版本替换须逐项区分 fixture 与真实，不从 #365 关闭状态推断接受任意 fixture。#363／#364／#366 是否满足各自清单需另行终审，不因既有报告写过具备条件即记为满足；父 SPEC #362 暂不满足关闭条件。
