# SPEC362 受控 CI 失败验收工作手册

> 本文是短期工作手册，不是新 SPEC；不定义新测试或 CI 政策，不设旁路。

## 背景与目的

- 背景为 SPEC362 / #364 / #369 下的真实受控 PR 硬检查验收。
- 目标是用一次真实 hosted 失败证明既有 PR Validate 会拒绝红分支。
- 当前阶段：准备中，尚无 GitHub CI 失败证据。
- 临时红测试是刻意放置的阴性夹具，不是发现的产品缺陷。

## 夹具说明

- `tests/spec362-controlled-ci-failure.test.ts` 故意断言失败。
- 该文件仅用于本次受控验收，随后以新提交删除，评审与合并前必须缺席。
- 不得将其当作产品回归、不得复用为长期政策、不得以此绕过检查。

## 验收步骤

1. 协调者发布 Draft 受控 PR，保持既有 PR Validate 不变。
2. 观察既有 hosted Validate 真实失败，不尝试合并，不抢修成绿。
3. 固定 prepare 只观察失败并等待，记录真实 run ID、head 与失败片段。
4. 受控 PR 在此期间保持打开，等待证据落定。
5. 以新提交删除临时红测试文件，确认该原始文件已缺席。
6. 在当前 head 上重跑可信 CI，恢复绿色基线。
7. 固定 prepare 与独立 review 都在当前 head 上执行。
8. 外部线程解决规则保持不变，仍使用既有固定启动器。

## 证据记录

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 受控 PR Validate 失败 run ID | awaiting_verification | 以 hosted 实际值为准 |
| 失败 head | awaiting_verification | 以 hosted 实际值为准 |
| 失败片段 | awaiting_verification | 摘录真实输出，不编造 |
| 临时文件已删除 | awaiting_verification | 评审合并前必须缺席 |
| 可信 CI 重绿 | awaiting_verification | 在当前 head 上重跑 |

尚未实际观察到的证据行一律保持 awaiting_verification，不编造哈希、
run ID 或审批人身份，不复制计数快照或台账。

## 未覆盖情形

- 暂停、撤回、主分支推进、冲突与跨时段验收是各自独立的剩余情形。
- 本次红夹具只证明 hosted 拒绝能力，不证明上述任一情形。

## 收尾

- 若最终无有意义文档变更留存，受控 PR 可不合并直接关闭。
- 不删除分支与历史，不重写历史。
- 本次不产生新测试或 CI 政策，不设任何 bypass。
