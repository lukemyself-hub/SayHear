# 清理版 G1 发布交接（2026-09-27）

## 已验证

- 从 `origin/main` 的 `bd1a179` 建清理分支；没有合入 `agent/issue-207` 的 24 个 G2 迭代提交。
- 原 G2 提交及 #243 原始输出/报告/哈希在远端 `codex/archive-g2-v6` 的 `cb4b4be`；41 个冻结文件的 bytes 与 SHA-256 均校验一致，见 #243 归档评论。
- `pnpm typecheck`、`pnpm build`、模块边界和 Purge Surface Registry 检查通过。
- 两个独立的临时 PostgreSQL 测试库运行 `pnpm exec vitest run --maxWorkers=2`：104 个文件、1281 个断言通过。包括迁移、G1 工作流、Full Purge、恢复防复活及 G2 准入阻断。默认并行度使本地 PostgreSQL 耗尽共享内存，限制两个 worker 后全绿。
- G2 环境开关和 manifest 留在启动环境时直接失败；生产启动核对 active G1 四角色完整 pin，任何 G2 active pin 阻断。Provider Egress 与数据库新命令准入均拒绝退场角色。

## 部署前未完成的硬门禁

1. Vercel `say-hear-web` 生产变量列表中没有 G2 开关或 G2 manifest，但 Vercel 的 production env export 把应用变量值返回为空。因此尚未获得生产数据库连接，**未核对** G2 active pin、历史命令及表内行数，也未核对当前四个 G1 pin 的实际值。不要将变量名列表当成数据库审计。
2. 新 `main` commit 尚无重新生成的 G1 F3、真实 Provider、人工裁定和 12 项发布证据，也无绑定该 commit 的 active manifest。旧 #236 commit `ca34d18` 的 manifest 不可复用。
3. 因 1–2 未完成，不能激活新 pin、部署新 manifest、烟测或回滚演练。生产现有 G1 保持原状态；七天 Internal Owner 体验在新部署成功后才开始计时。

## 下一次发布执行顺序

取得生产数据库只读访问，检查 G2 表及命令行数与所有 active pins；若发现 G2 真实数据，先处理留存与删除责任。然后在新 exact main commit 上重做 F3/Provider/人评/12 项证据，生成并验证 manifest，激活四个新 G1 pins，部署对应 commit 与 manifest，烟测和回滚演练。任一硬门失败即停止并回滚受影响阶段。成功后开始七天正常使用记录，未观察的路径据实标记。
