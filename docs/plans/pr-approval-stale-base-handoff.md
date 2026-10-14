# PR 落后 main 的 Issue 交接

Luke 要求自动审核发现 PR 落后当前 main 时，将信息写回对应 Issue，让实现 Agent 接续原 PR/分支，同步最新 main 并重新验证后送审。

- stale base 是实现 Agent 必须处理的同步任务，不是无限等待，也不是已确认代码缺陷。
- 在复用旧审核、等待旧 CI、开启新 review 前处理 stale base。prepare 只写本地包并返回需要交接，不修改 GitHub；scan 使用真实 App 评论与标签交接。
- 回读 PR Ready、同仓库 main、head/base、当前 main、引用 Issue/不关闭排除、评论暂停；状态变化或保留声明不明时停止写入。
- 只回写未排除的开放 Issue。先确认真实 App 评论，再移除 ongoing 和互斥分诊标签、恢复 ready-for-agent，并回读。多个目标逐个交接，一个失败仍处理其余，报告未完成项。
- 人工分诊标签只收到同步提醒，保留标签等待决定；完成交接后写App完成标记，同一身份后续扫描不释放Agent新认领。
- 评论绑定 PR/head/base/main 做去重，写明同步 main、处理冲突、重新跑对应新 SHA/base 的可信 CI、继续原 PR，不另建 PR。暂停仍优先；交接不等于解除人工/迁移/生产证据门禁。
- 不批准、不合入 PR、不直接同步作者分支、不发送虚假 request changes、不增加三轮失败计数。
- 状态输出保留 waiting_for_current_base，新增 handoffRequired/handedOff/currentMainSha/packetPath，避免只知道等待而不能行动。
- 同样覆盖 submit 的 stale-base 入口；head/base 与 main 已一致、只缺 merge-ref 或 CI 的情况继续等待，不要求改代码。
- 定向测试评论去重与身份、标签交接、排除/closed、暂停、最新状态变化与部分失败；独立审核、类型检查、构建安装助手。按既有A方案由Luke在终端安装；安装后以固定scan完成真实Issue交接并回读。

交接评论已有、完成标记缺失且 Issue 仅有 ongoing 时，无法可靠区分旧占用与新认领，
保留占用并报告未完成交接，等待人工核实；不盲目释放。main 再前进时，已交接后新认领
的 Agent 只收到更新提醒，ongoing 保留。标签变更函数也回读人工状态，遇到新人工标签停止。
