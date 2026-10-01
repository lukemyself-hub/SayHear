---
status: accepted
date: 2026-10-01
amends: [0144]
---

# G1 恢复上线跳过 raw Provider error 探针

Luke 明确要求：跳过刚讨论的原始 Provider 错误探针检查，完成生产部署并开启 G1。此次恢复上线不增加受控 Provider 故障入口。

仅豁免 `raw_provider_error` 探针。证据必须明确记录该项 `skipped`、批准人 Luke、决定 ADR-0145 和本次 G1 恢复上线范围；原始值必须为 null，不能填入随机字符串或把该检查写成 passed。

其余五类探针继续使用实际执行中的值并扫描完整相关字段。Workflow、outbox、receipts、logs、traces、真实受控失败记录仍需非空、关联明确、完整分页和解密。缺失导出、真实泄漏、未知豁免和越过其他安全门禁仍然失败。

本决定不豁免 ADR-0143 保留的发布身份、角色 pins、Provider 完成度、确定性校验、Data Epoch、血缘、Full Purge/恢复演练及回滚能力。生产不执行 Full Purge。生产 promotion ledger 和发布记录必须披露这个验收缺口，不能宣称六类探针全通过。
