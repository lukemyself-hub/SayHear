---
status: accepted
date: 2026-07-26
---

# User Audio Is Not Retained Long Term

SayHear 不把正式用户原始音频作为长期产品记录。内部账号只有在逐项明确 opt-in 后，
才可以创建用于质量复核的 AudioAsset；该音频在 retention start 后 72 小时立即停止
读取，并进入物理删除与 reconciliation。

音频不能进入 Memory Retrieval、Journal 或 Profile 的长期 source。正常物理删除目标
是失效后 15 分钟内完成，独立存储 Lifecycle 只作为故障兜底，不得被描述为精确到
72 小时的物理删除保证；第三方 Provider 保留策略也必须单独核验。
