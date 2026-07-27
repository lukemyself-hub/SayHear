---
status: accepted
date: 2026-07-26
---

# Backup Window Is Verified Before Private Data Writes

在 Internal Owner 的真实私人数据首次写入前，必须核验数据库和相关存储的最长备份、
PITR 与残留窗口，并把结果纳入 retention、删除 fencing 和恢复流程。未知的备份窗口
不能被当作“以后再补”的运维细节。

Foundation / 1A.1 尚不承诺完整 Account Deletion，但必须已有 stable owner、
`data_epoch`、deletion-compatible lineage、读取 / Egress fence 与已核验 backup
window。External MVP 前还需通过完整 deletion ledger 与备份恢复防复活演练。
