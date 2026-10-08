# Flash 生成失败调查

2026-10-01。冻结源代码 544ba555342db4565631531e1afe79fe95c72bdc；tracked source 未修改。本文是诊断记录，不是 release manifest 或成功验收证据。

用户要求继续使用 Flash，未授权 Pro 晋升。Pro 候选仅保留在独立 run 目录，没有调用、绑定 pins 或发布。

最新 key 直接从根目录 .env.neon 用 Node parseEnv 读取。余额接口 200/is_available=true；控制台 SayHear 行的掩码与本地 key 匹配，最近使用日为 10 月 1 日。敏感 Vercel 变量无法读回原值，不声称旧值已证明不同。已程序化同步最新 key 到独立验收项目 Preview，并重新部署同一冻结代码。部署 dpl_Bse9Ki483b4GoUAQNbA2HPgA3FUg，READY，https://sayhear-g1-acceptance-8054b2qa9-lukemyself.vercel.app。验收域名指向此部署，G1 仍关闭。生产没有修改。

官方当前更新日志明确 deepseek-flash 是 V4.1 Flash 的名称，旧 deepseek-v4-flash 仍接受并暂时转到同一模型。不能从 /models 不列旧名就推断旧名导致失败。

相同 key、接口、参数的并发对照：当前 Flash 与旧 Flash 名称均 200 后只有保活，45 秒超时；Pro 6.222 秒 response.completed，实际返回 model deepseek-v4-pro。Pro 仅用作排除余额、认证和全接口故障的诊断。最新 Flash 最小请求去掉所有可选参数，普通 string input 与 typed input parts 均只有保活，65 秒超时。Flash 关闭思考、100-token 上限等待 180 秒仍未收到任何 semantic event。Node 直接、Node 环境代理、curl 系统代理均无生成结果。详细无密钥记录见同目录 JSON。

独立调查 OpenCode investigator ses_f06fabafcffeutZHWo1BchZogI 已完成；独立审查 ses_f06f2358affeXEUVC0yuUkZMGr 已完成，确认改名本身未显示能修复问题。审查所用模型为本机实际配置，不将其标为其他模型。

当前结论：失败位于该账号/key 对 Flash 的生成服务路径，不是余额不足、错误读取本地 key 或单独的旧名称问题。不能仅凭单账号推断所有用户都受到服务故障，尚不能区分账号 Flash 并发/队列限制与服务端 Flash 资源问题。官方 FAQ 指出持续 keep-alive 表示等待服务器开始推理，最长等待 10 分钟。最后保留一个 canonical Flash 请求到完整窗口，禁止新增并发探测或修改运行时超时冒充修复。

托管合成命令 01a0f90d-4ace-7636-b3a3-bcf33e7f6a2a：前两次实际 Provider attempt 各 120 秒 timeout，第三条最后查询仍为 running，网页显示 stream ended without final result。不能声称三次都已完成或因此 G1 已可用；此残留需通过正常恢复扫描核对。

验收仍未通过，生产 G1 OFF。所有历史失败与原 blocked 报告保留。后续必须获得真实 Flash 完成结果、重新捕获最终四角色与 Validator/precision/Continuation、hosted 导出、完整 manifest、隔离功能/回滚，再切生产。

官方来源：
- https://api-docs.deepseek.com/updates/
- https://api-docs.deepseek.com/quick_start/pricing-details-cny/
- https://static.deepseek.com/faq/index.html?lang=zh#/question/keep-alive
- https://static.deepseek.com/faq/index.html?lang=zh#/question/rate-limits

完整等待窗口结果：2026-10-01T20:25:24.653Z，canonical deepseek-flash、low、1000-token cap，HTTP200，620016ms，714字节保活，firstEventMs=null，客户端TimeoutError。没有服务端终止事件，不能把本次客户端取消写成服务器关闭或生成完成。并发说明进一步核验：默认Flash账户并发2500，超限返回429；本次没有429，不能把并发超限当作已证实根因。最后一个Anthropic兼容接口诊断等待中，期间没有新并发请求。

后续排查：官方 Anthropic 兼容接口 /anthropic/v1/messages 同样 HTTP200、42 字节保活、45009ms 客户端超时。Chat /chat/completions 加入非私人合成 user_id、关闭思考、100-token cap，同样 HTTP200、70 字节保活、65011ms 客户端超时。没有找到可正常调用同一 Flash 模型的替代官方路径。所有诊断请求已经结束，没有后台盲重试。用户明确保持 Flash，禁止把 Pro 晋升建议当作已批准操作。准备提交官方故障反馈，需要用户明确授权；尚未发送。
