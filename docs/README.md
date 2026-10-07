# SayHear 文档地图

## TL;DR

- 每个任务先读取根目录 `AGENTS.md` 和本文件。
- 再根据任务涉及的领域定位并读取相关当前文档与 ADR；在任务范围内优先保证结论
  对齐完整，不无目标地预加载整个 `docs/`。
- `product/` 定义产品背景、承诺与当前产品规则；`architecture/` 只定义技术契约
  与系统不变量，不属于 SPEC。
- 根目录 `GLOSSARY.md` 是术语唯一真源；`docs/adr/` 解释重要决定的原因。
- 完整 SPEC 由 matt skills 发布为 GitHub Issue；`specs/` 只维护轻量索引和规则，
  当前 1A.3b SPEC 为 GitHub #193。
- `tasks/` 是短期 working spec；`archive/` 只用于追溯，默认不读取。
- 设计、开发或修改具体功能前，先检索并读取任务相关 ADR；Issue、SPEC 或文档中的
  显式链接只是最低起点，不是完整决策范围。
- 如果当前文档、ADR 与代码互相冲突，明确指出冲突，不要自行猜测或静默改产品定义。

## Status

Accepted

## 任务上下文规则

1. 每个任务先读取根目录 `AGENTS.md` 和本文件。
2. 只有不会改变功能语义、架构、数据模型、工作流、接口、用户行为或信任边界的纯机械
   修改，才可以到此开始。
3. 有 Issue 或 working spec 时，先读取任务本身及其明确链接的当前文档；这些链接只
   定义最低上下文，不保证已经列全相关决定。
4. 没有任务链接时，根据下方“按任务读取”定位相关当前文档。
5. 涉及具体功能的设计、开发或非机械修改时，先通过
   [`decisions.md`](decisions.md) 的主题索引和关键词检索相关 ADR，并在行动前读取
   所有命中项，确保方案与实施对齐已经接受的结论。
6. 不无目标地加载 `archive/`、整套产品背景、整套架构或全部 ADR；ADR 的读取范围由
   任务涉及的领域和检索结果决定，不能只以显式链接是否存在来判断。
7. 同一任务中没有变化的长文档不要重复读取。

## 权威来源边界

| 内容 | 当前权威来源 | 不应作为当前真源 |
| --- | --- | --- |
| 产品愿景、用户、价值、定位、范围、承诺和当前产品规则 | `product/` 对应主题文件 | 架构摘要、研究建议、归档 PRD |
| 专门功能 SPEC | 对应 GitHub Issue 的完整正文、评论和标签；`specs/README.md` 只作索引 | 本地重复 SPEC 正文、架构文档、产品总结、ADR 摘要 |
| 术语、名称和禁用近义词 | 根目录 `GLOSSARY.md` | 代码里的临时命名、历史文档 |
| 技术边界、数据模型、工作流和系统不变量 | `architecture/` 对应主题文件 | 研究文档、归档架构总稿 |
| 重要决定及其原因 | `adr/` 中对应 ADR | 归档架构中的旧决策摘要 |
| 当前短期任务范围 | `tasks/` 中对应 working spec 或 GitHub Issue | 路线图、历史会议记录 |
| 历史讨论、被取代方案、原始快照 | `archive/` | 任何当前实现依据 |

更具体的当前 SPEC 可以细化较高层产品描述，但不能静默改变产品定位、用户承诺或
信任边界。架构只能定义实现契约，不能重新定义产品行为。发现冲突时停止推断并报告
具体文件和结论。

## 按任务读取

### 产品与体验

文件名前缀对应原产品总稿章节范围，并按阅读顺序排序。`18-and-26` 表示该文件承载
两个不连续章节：第 18 节阶段范围与第 26 节阶段路线。

| 任务 | 读取 |
| --- | --- |
| 产品定位、愿景、项目边界 | [`product/01-04-overview.md`](product/01-04-overview.md) |
| 目标用户、JTBD、价值 | [`product/05-06-users-and-value.md`](product/05-06-users-and-value.md) |
| 核心循环、信息架构、AI 身份 | [`product/07-11-experience-and-positioning.md`](product/07-11-experience-and-positioning.md) |
| Daily Session、Journal 生成、展示或纠错 | [`product/12-13-session-and-journal.md`](product/12-13-session-and-journal.md) |
| Entity、Memory、Profile、Recall | [`product/14-memory-and-entities.md`](product/14-memory-and-entities.md) |
| 对话回应、追问、建议边界 | [`product/15-conversation-behavior.md`](product/15-conversation-behavior.md) |
| Onboarding、Web / iOS、跨端 | [`product/16-17-onboarding-and-platform.md`](product/16-17-onboarding-and-platform.md) |
| 阶段范围、路线、Internal Core / External MVP | [`product/18-and-26-scope-and-roadmap.md`](product/18-and-26-scope-and-roadmap.md) |
| 隐私承诺、删除与导出产品边界 | [`product/19-privacy-and-trust.md`](product/19-privacy-and-trust.md) |
| 商业模式、指标、成功标准、竞争 | [`product/20-23-business-and-success.md`](product/20-23-business-and-success.md) |
| 设计原则与产品风险 | [`product/24-25-design-principles-and-risks.md`](product/24-25-design-principles-and-risks.md) |

### 行为评测

| 任务 | 读取 |
| --- | --- |
| 行为契约、评测 rubric、盲评 pairwise、发布证据 | [`evaluation/01-behavior-contract-and-rubric.md`](evaluation/01-behavior-contract-and-rubric.md) |

### 专门 SPEC

当前架构文档不属于 SPEC。通过 matt skills 形成的完整 SPEC 发布到 GitHub Issue，
Issue 是唯一执行真源；[`specs/README.md`](specs/README.md) 只维护发现索引和发布
规则，不复制正文。未有对应正式 SPEC 时，产品行为读取 `product/`，实现约束读取
`architecture/`。

### 技术架构

文件名前缀对应原架构总稿章节范围，并按阅读顺序排序。例如，
`07-01-06` 表示第 7.1–7.6 节，`07-07-12` 表示第 7.7–7.12 节。

| 任务 | 读取 |
| --- | --- |
| 总体边界、技术栈、模块与依赖方向 | [`architecture/01-06-overview.md`](architecture/01-06-overview.md) |
| Session、Turn、Event、Transcript | [`architecture/07-01-06-conversation-data-model.md`](architecture/07-01-06-conversation-data-model.md) |
| Evidence、Entity、Journal、Reflection、Memory、Profile、Action 运行记录 | [`architecture/07-07-12-knowledge-data-model.md`](architecture/07-07-12-knowledge-data-model.md) |
| 在线 Turn、Agent Harness、Conversation Action、Context Compiler、检索 | [`architecture/08-10-conversation-runtime.md`](architecture/08-10-conversation-runtime.md) |
| Journal、Reflection、Memory 派生流程 | [`architecture/11-12-journal-memory-workflows.md`](architecture/11-12-journal-memory-workflows.md) |
| 幂等、outbox、并发、重试、reconciliation | [`architecture/13-durable-workflows.md`](architecture/13-durable-workflows.md) |
| Realtime、LiveKit、STT、barge-in、delivery | [`architecture/14-voice.md`](architecture/14-voice.md) |
| 模型角色、Provider Egress、Prompt、locale | [`architecture/15-16-providers-and-localization.md`](architecture/15-16-providers-and-localization.md) |
| Replay、eval dataset、隔离边界 | [`architecture/17-replay.md`](architecture/17-replay.md) |
| 权限、Action payload、音频保留、删除、数据生命周期 | [`architecture/18-20-privacy-security-lifecycle.md`](architecture/18-20-privacy-security-lifecycle.md) |
| 可观测性、部署、Schema / Workflow 演进 | [`architecture/21-23-operations-and-evolution.md`](architecture/21-23-operations-and-evolution.md) |
| Action 发布验收、测试、故障注入、交付顺序、DoD、升级门槛 | [`architecture/24-29-testing-and-delivery.md`](architecture/24-29-testing-and-delivery.md) |

领域命名任务只读取
[`../GLOSSARY.md`](../GLOSSARY.md) 的相关章节；不要把整套产品或架构
当作术语前置材料。

## 决策、任务与 Agent 操作

- ADR 索引与主题路由：[`decisions.md`](decisions.md)
- working spec 示例：[`tasks/example-working-spec.md`](tasks/example-working-spec.md)
- 领域文档使用规则：[`agents/domain.md`](agents/domain.md)
- GitHub Issue / SPEC 操作：[`agents/issue-tracker.md`](agents/issue-tracker.md)
- Issue 分诊标签：[`agents/triage-labels.md`](agents/triage-labels.md)
- 历史快照说明：[`archive/README.md`](archive/README.md)

## 文档状态

- **Draft**：正在形成，不能视为已确认需求。
- **Proposed**：已有完整方案，实施前仍需确认或验证。
- **Accepted**：当前有效的权威来源。
- **Deprecated**：仍可追溯，但不应继续用于新实现。
- **Archived**：历史材料或不可变快照，不具当前权威性。

## Open questions

- 核心架构拆分文档当前继承原 v0.1 的 `Draft for implementation` 状态，实施时仍需按
  相关 ADR 与任务验收逐项验证。

## References

- [原始产品文档 v0.1 快照](archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [原始核心架构 v0.1 快照](archive/architecture/sayhear-core-agent-architecture-v0.1.md)
