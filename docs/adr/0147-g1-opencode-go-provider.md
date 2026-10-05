---
status: accepted
date: 2026-10-04
supersedes: [0102]
amends: [0140, 0143]
---

# G1 使用 OpenCode Go 承载 DeepSeek V4.1 Flash

Luke 在 G1 正式开启前明确要求：当前直连 DeepSeek API 的模型调用改走 OpenCode
Go 套餐，仍使用 DeepSeek V4.1 Flash。范围是当前对话、Journal 后台角色和四个
G1 角色（`episode.build`、`reflection.daily`、`reflection.weekly`、
`narrative.validate`）；不恢复 Bio、Open Loop 或 Follow-up。

## 决定

- 新增诚实 Provider 身份 `opencode-go`，与 `openai`、`deepseek` 并列，贯穿
  Champion、Evidence、Journal 与 G1 attempt/policy 血缘。它使用固定的
  `https://opencode.ai/zen/go/v1/chat/completions` Chat Completions transport，
  模型只能是 `deepseek-v4.1-flash`；不存在 base URL 或模型的静默回退，显式错误的
  旧模型/旧 Provider 直接拒绝而不是改名。既有 OpenAI / DeepSeek Responses 与
  确定性路径保持兼容。
- `SAYHEAR_PROVIDER_ADAPTER=opencode-go` 与 `OPENCODE_GO_API_KEY` 是唯一新增
  选择入口；凭据只存在于本机/部署环境，不进入仓库、日志或冻结证据。provider
  egress 仍是同一进程内 Port（沿用既有逻辑标识
  `provider-egress.responses-api`），不新增信任边界服务或独立集成。
- G1 配置与 rollout pin 诚实版本化：Episode v6、Daily v8、Weekly v7、
  narrative.validate v6，共享 pin v15；Prompt 版本沿用当前协议修复后的
  `episode-build:eval:v4`、`reflection-daily:eval:v6`、
  `reflection-weekly:eval:v5`、`narrative-validate:eval:v4`；本块保留
  E10000/D20000/W20000/V10000 永久上限，是否放宽由后续独立 Go 全量 profile 决定。
  新迁移 `0065` 增加四条 `opencode-go-<role>-egress:g1-release:vN` policy 并放宽
  `evidence_source_snapshots.champion_provider` 允许 `opencode-go`；0062/0063/0064
  及更早迁移不可改。
- 传输会话头使用从既有可信逻辑范围派生的 SHA-256 不透明值：对话按 owner + Daily
  Session（来自既有 `interaction_turns.daily_session_id` join，不新增列），G1 按
  owner + 该角色真实的 Daily Session / week / draftRef；同一 owner/范围跨 attempt
  稳定，不同 owner/范围不同，绝不使用全局哨兵或随机回退，也不把原始 id/正文写入
  头或模型 payload。缺失可信范围时 fail closed。

## 有界例外与边界

- OpenCode Go 面向编码代理流量；SayHear 发送自己诚实稳定的 User-Agent 与不透明
  session 头，不伪装请求、不绕过限额、不自动启用额外计费或模型回退。非编码场景的
  兼容性是**实测限制**，文档不作类别性禁止，也不作为未验证的承诺。
- 官方 `https://opencode.ai/docs/go/` 的 DeepSeek Go 数据协议当前为不用于训练且
  0 天保留，有效期到 **2026-10-31**。续期按月发生且不确定，发布必须记录该期限，
  不得把续期当作已发生；不虚构远端删除或 ZDR 验证，也不缩短既有 30 天保留边界。
- 本决定取代 ADR-0102 中“Provider 仅以 Responses API 为配置”的传输限制；0102 的
  其余结论保留。ADR-0140 的可变 alias 例外继续以完整 pin、运行时快照严格比对和
  每角色 AC-M01 调用证据为前提。ADR-0143 的语义校验“advisory、不阻断发布”语义
  不变。
- OpenCode Go 返回的是同一个可变 alias `deepseek-v4.1-flash`，不是不可变的日期化
  snapshot；因此底层权重漂移**无法被检测**。本决定不主张任何“不可变权重”保证：
  pin 只固定 alias 名称、endpoint、参数和每角色 AC-M01 调用证据，运行时快照比对
  只能证明返回了同一 alias 字符串，不能证明背后的模型权重未变。任何需要排除权重
  漂移的证据必须在独立的两库全合成复跑中重新产生，而不是从既有结果继承。
- 本次仍未实现或发布，生产 G1 仍为 OFF。真实 hosted 探针、完整回归和发布由父流程
  独立执行；本仓库的离线/两库测试不构成 hosted 或生产证明。

相关来源：[架构 15-16 Provider 与本地化](../architecture/15-16-providers-and-localization.md)、
[ADR-0102](0102-deepseek-joins-openai-as-a-conversation-text-provider-in-1a1.md)、
[ADR-0140](0140-g1-deepseek-model-alias-is-pinned-evidence.md)、
[ADR-0143](0143-g1-ships-without-semantic-reflection-validation.md)、
[OpenCode Go 文档](https://opencode.ai/docs/go/)。
