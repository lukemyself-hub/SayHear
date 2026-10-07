# SayHear 切换 OpenCode Go Flash

Luke 在 G1 正式开启前要求将当前直连 DeepSeek API 的模型调用改成 OpenCode Go 套餐，保留 DeepSeek V4.1 Flash。包括当前使用 DeepSeek 的对话、Journal 和四个 G1 角色，不恢复 Bio、Open Loop 或 Follow-up。生产当前 G1 OFF；此变更合并进本次最终冻结、验收与发布。

## 已核验

官方说明 https://opencode.ai/docs/go/ 的模型 ID 为 deepseek-v4.1-flash，endpoint 为 https://opencode.ai/zen/go/v1/chat/completions。现有 Responses 客户端需新增 Chat Completions transport，不能仅替换 base URL。无私人内容的直接 SSE 探针正常结束，model deepseek-v4.1-flash，input56/output17/reasoning11/total73，cached0，耗时1359ms。原 API 报告不充当 Go 验收证据。

Go 文档用途面向编码代理。SayHear 如实提供自己的 User-Agent，稳定且不暴露原始用户信息的 x-opencode-session，不伪装请求、不绕过限额、不自动改模型或启用额外计费。Zero data retention 文档只确认当前 DeepSeek 协议有效到2026-10-31，发布需记录期限，不能把续期当作已发生。新 Provider 数据处理方是明确授权变更的一部分，保留既有 egress、epoch、Purge 和 Recovery 门禁。

## 实施和验收

先由 OpenCode 只读定位完整接线范围，再串行委派 transport 和集成修改并独立 Review。父代理只负责凭据在本机内存的最小实际探针、差异检查、系统验证、冻结和发布。Worker 不读凭据或私有数据。新身份、参数、Prompt、policy、role配置和pins诚实版本化，用forward migration，不改既有迁移。

Chat SSE 必须区分 text 与 reasoning，重组 Function calls，拒绝截断、不完整、错误和 snapshot 不匹配；usage 缺失保留 unknown，不能算为0。正常结束、tool calls、分页/UTF8/chunk、取消/超时、401/403/429和用量需测试。禁用工具时不得发送或接收未授权工具。

全部当前 DeepSeek 调用可经 Go 后，再使用独立两库、全合成输入，四角色临时100000输出上限，运行真实 Episode→三次Daily+Validator→Weekly+Validator→current提交，并核对wire、attempt和只读报告。完整任务用量和失败成本分开；据实选择永久预算，随后重新冻结、组装受影响发布证据、隔离 hosted 演练，最后生产先OFF回退目标→新pins→manifest开关→同版本ON部署与实际烟测。

不得通过新Provider重试此前自动审批拒绝的私人外发探针，不绕过生产identity读取拒绝，生产不执行Full Purge。此次变更尚未实现或发布，G1仍OFF。

## Transport 验证结果

新 Go transport 使用固定官方 Chat endpoint、真实 SayHear User-Agent 和显式 opaque session。已经覆盖 SSE 正文与推理分离、工具碎片、截断/不完整/超时/取消、结束标记立即释放连接，以及成功和失败的用量回调。既有 visibleReplyRequired 函数保留恰好一次后续调用，正文先于提议返回。两次调用的用量只有各字段全部已知时才相加，否则保留 null。Go 截断原因如实记为 length，Direct Responses 的 max_output_tokens 不变。

OpenCode 独立审查两次 CLEAR。父代理最后重跑 3 文件76测试全部通过；仓库规定的 pnpm typecheck，包括全部workspace和G1 tools，全部通过。实际调用新 adapter，使用全合成请求，两个HTTP200、同Go endpoint/model/session/low effort、第二次未提供工具，先正文后提议再完成，callback恰好一次。用量input533/output222/reasoning159/cache0/total755。报告 `/private/tmp/g1-opencode-go-adapter-live.json`，源码adapter SHA-256 `6fdb9514fd135d0f7a589af21075b9eebe973d185c548db03092f0995a1e52ba`。属于当前dirty源码诊断证明，不是冻结发布证据。

普通直接endpoint协议测试另外使用700token，连接测试73token，分别保留；不能将三次探针与完整G1任务混为一份成本或完成证明。公开集成改造由OpenCode进行，state `/private/tmp/g1-opencode-go-integration-state`。最终角色接线、Go完整100000上限任务、预算分析与最终冻结发布均待完成。

## 2026-10-04 21:06 PDT

公开接线的父代理全量回归通过，121文件1536测试，独立两库、maxWorkers2、69.95秒。完整typecheck、模块边界、Purge124表130索引通过。不是完整Go任务或hosted证明。离线合成响应另复现了通用Go客户端接受错误返回模型的漏洞，G1上层已拦截但Journal/对话尚未；OpenCode继续同一会话修复首次snapshot检查、Evidence传输元数据与modelpayload分离、Go缺失DailySession拒绝。完成后独立Review及完整Go100000上限任务仍待执行。生产G1仍OFF。

父代理纯合成高上限兼容探针完成：Go 请求 max_tokens100000、HTTP200、实际model deepseek-v4.1-flash、stop与DONE、1623ms、input56/output17/reasoning11/cache0/total73。报告 `/private/tmp/g1-opencode-go-cap-check-20261004.json`。只证明服务接受该上限，不是高耗用压力测试、完整G1、冻结或hosted证据。与之前73连接/700工具wire/755adapter三次成本分别保存，不重复算作完整任务成本。
