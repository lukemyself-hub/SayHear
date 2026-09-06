---
status: accepted
date: 2026-07-26
---

# Validated Bio Refreshes Do Not Require Approval

手动刷新表示用户请 SayHear 根据最新有效 Memory 重新理解并讲述自己，不是创建等待
发布的候选 Bio。手动、每周和 trust-boundary 重建使用相同的验证与 fenced commit
边界：新 Bio 只有在校验通过后才原子成为 current BioVersion，不需要
用户发布前预览或批准。

Profile 不提供正文编辑、多候选版本选择或连续抽卡式重写，也不引入
`awaiting_approval` 产品状态。用户认为内容不准确时，必须通过对话中的 Memory
Correction 或 Memory Forget Request 修改底层 Memory，再由 Bio 重建；Bio 正文不能
成为绕过 Memory lineage 与用户控制边界的第二写入口。

这个边界保持 Bio 是 SayHear 的可重建叙事产物，而不是用户撰写的身份声明，并
避免为一次刷新引入候选管理与审批工作流。普通生成失败仍可显示安全的旧 Bio；
trust-boundary 重建失败时旧 BioVersion 已不可用，只能保持正在更新或暂时不可用。
