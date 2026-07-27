---
status: accepted
date: 2026-07-26
---

# Model Promotion Is Developer-Judged

Phase 1 不建设独立 Model Promotion Gate、统一强制阈值或额外审批工作流。开发过程中
完成与 role 相称的评测后，只要开发者判断 Challenger 效果更好，就可以人工发布新的
Model Routing Policy，将它设为 Champion 或 eligible fallback。

用户可感知 role 可以重点比较中英文、code-switching、被理解感、人格一致性与信任
边界；结构化 role 可以重点比较标注准确率、typed lineage 与领域不变量。这些是帮助
开发判断的评测方法，不是需要提前固化为运行时 Gate 的产品逻辑。

模型替换不强制先运行 Private Replay。Synthetic、匿名化或另行授权数据的 Initial
Replay 可以直接支撑开发判断；只有开发者实际选择正式领域中的真实私人 source 做
Replay 时，才触发既有 Private Replay 隔离、显式 source / Provider 选择、TTL 与删除
传播边界。
