# SPEC362 受控 CI 失败验收工作手册

> 本文是短期工作手册，只记录本次清理与已观测证据；不定义新测试或 CI 政策。

## 范围

- 本次是已授权阴性探针的清理：以普通删除移除临时红夹具，不是产品缺陷修复。
- 最终只保留文档差异，无需部署。

## 已观测 hosted 证据（2026-10-17）

- 受控对象为 PR397：[PR #397](https://github.com/lukemyself-hub/SayHear/pull/397)，清理前 head `be97b991dee7b1009cf5e3cd5cbd2015c766d40e`，base `546d1b89da64c9c5e4e745b10db98a9989ef4de4`。
- hosted PR Validate 两次真实失败，且仅由临时红测试导致：
  - Draft：[run 39070530311](https://github.com/lukemyself-hub/SayHear/actions/runs/39070530311)，completed failure；
  - Ready：[run 39071045693](https://github.com/lukemyself-hub/SayHear/actions/runs/39071045693)，completed failure。
- 除临时红测试外其余 3427 项通过；失败期间 GitHub head 未变化。这是 GitHub 层红检查的观测，不是控制器已批准 CI。
- Draft 固定 prepare 返回 `skipped`；标题含显式 hold 时返回 `held_for_human`。去掉 Draft 与标题 hold 后，固定 prepare 在 CI 已失败的状态下实际返回 `review_required` 并生成审核包；生成审核包不代表 CI 通过，也不证明 submit 的 CI 硬拦截已执行。
- 独立阴性探针评审 `ses_eb433d30cffeD5I774UuQQtdVS` 返回 COMMENT，无 P0–P2 探针缺陷，也无语义 Approve，不能复用为清理后 head 的批准。
- 控制器 submit veto 未被实际行使（因无语义 Approve），保持 `awaiting_verification`。

## 冲突路由对照（PR399，与 PR397 分开）

- [PR #399](https://github.com/lukemyself-hub/SayHear/pull/399) head `4a082d78c5c426ad6e1a4e1f01c8a292dcd9a548`（基于 `6d6c8ea`）与 main `546d1b8` 冲突：GitHub `mergeable=false` / dirty，固定 prepare 于 `2026-10-17T21:32:01Z` 报 `pull_request_conflict` 且 `handoffRequired=true`。
- PR399 已关闭未合并，`mergeCommit=null`，见[关闭评论](https://github.com/lukemyself-hub/SayHear/pull/399#issuecomment-6241431490)。
- 这只证明文档冲突路由实际走通，不代表“人工批准后冲突”端到端已验证。

## 本地清理事实（2026-10-17 工作树实测）

- `tests/spec362-controlled-ci-failure.test.ts` 已删除，本地已验证该文件缺席。
- 本 PR 不产生父子 Issue 交付或关闭。

## 仍待验证

| 项目 | 状态 |
| --- | --- |
| PR397 清理后 head 重跑可信 CI 转绿 | awaiting_verification，以实际 run 为准 |
| 清理后 head 的全新评审 | awaiting_verification，不可复用探针评审 |
| 实际暂停／撤回 | awaiting_verification |
| 已批准 head 上的 main 前进组合验证 | awaiting_verification |
| 跨小时恢复 | awaiting_verification |

未实际观测到的行不编造新 SHA、成功 run 或批准人身份。
