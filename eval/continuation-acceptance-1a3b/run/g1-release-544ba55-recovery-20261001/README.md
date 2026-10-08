# Flash 恢复后的 G1 验收记录

冻结代码为 `544ba555342db4565631531e1afe79fe95c72bdc`。最新 key 的 `deepseek-flash` 合成请求在 954ms 内完成，返回正文 OK。此目录保存新执行的四角色、Validator、precision 和对话完整池捕获；历史失败目录保留。

四角色 4/4 完成，Validator 6/6 完成，precision 6/6 完成且无误拦截，对话确定性检查 18/18 通过。validator-completion.json 由真实捕获经完成度验证器生成，未要求人工语义裁定。

`test-reports/` 是同一冻结代码先前执行的报告副本，保留原始执行时间和上下文。本轮未重新运行这组测试。全量结果为 1411/1411；两个独立测试数据库，maxWorkers=2。

托管验收 deployment 为 `dpl_Bse9Ki483b4GoUAQNbA2HPgA3FUg`。正常 Owner 新 Action 进入真实 Workflow `wrun_01M3WSC05BHEY0DYJXEC8SDAHW`，最终因 fence 取消，不能算重新生成成功。六类导出均非空、关联明确、完成分页及解密检查。五类实际探针扫描通过，原始 Provider 错误探针按 ADR-0145 跳过。敏感探针 values 文件仅保存在私有冻结副本，不复制本目录。

当前生产仍未切换，G1 未开启。完整 release manifest 及隔离 G1 功能验收仍待完成。不能用 Provider 恢复证明生产功能已可用。
