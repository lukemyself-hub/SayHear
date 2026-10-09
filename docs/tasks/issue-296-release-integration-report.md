# #296 发布整合报告：近期背景 schema 扩展准入与 promotion 记录

Status: implementation + isolated deterministic acceptance complete. Production
enable/promotion is **not** performed here. Post-launch experience observation
is **pending** normal use by Luke.

本文件区分四类证据：代码交付、隔离确定性验收、实际生产启用、上线后体验观察。
任何未实际执行的项都标为未执行/待办，不写成通过。

## 1. 代码交付

### 1.1 versioned hash-pinned frozen-prefix schema-extension matcher

新增 `packages/application/src/schema-extension.ts`：

- `ONE_A_3B_G1_SCHEMA_EXTENSION_REGISTRY_VERSION = "1a3b-g1-schema-extensions:v1"`。
- `matchFrozenPrefixSchemaContract({ expected, applied, extensions })`，纯同步函数：
  - `applied` 长度必须 `>= expected`；
  - `applied[0..n)` 必须与冻结前缀逐条按 `name` 与 SHA-256 完全一致，顺序不可变；
  - 前缀之后的每一行必须是同一 store 的已注册扩展，按 `name` **canonical code-unit**
    顺序排列（不用 locale-sensitive 的 `localeCompare`，避免与 SQL `ORDER BY` 在
    非 C collation 下不一致），`name` 与 SHA-256 均一致；
  - 已注册但迁移文件尚未落地的条目允许（pending landing），不因“未应用”失败；
  - 未注册、哈希漂移、乱序、前缀缺失/乱序均 fail closed；
  - 扩展列表为空时行为与原来的全等比较完全一致。
- 注册扩展（`ONE_A_3B_G1_SCHEMA_EXTENSIONS`，顺序 0068 → 0069 → 0070）：
  - business `0068_recent_conversation_context_refs.sql`
    sha256 `8984556a9578c2badc662e361df62bf8607b326b9075208346d1d5f63765015d`
  - business `0069_recent_context_request_timezone.sql`
    sha256 `45b9f606ad28c62e99826e635b83b8d9a16ec032a2073f14bbbb02382f9cf42b`
  - business `0070_recent_context_governance.sql`
    sha256 `3468342de597d7c5151586f11bc1c2baaa454c71b0ae3ea78bf9e91542ad72f7`
  - purge-marker：无扩展（保持精确全等）。

**为什么 0068 也必须注册**：accepted release line（origin/main `503e9aa`）最后一条迁移是
`0067_g1_opencode_go_conversation_text_egress_policy.sql`；0068/0069/0070 都相对 accepted
manifest 是 extra。若只注册 0069/0070，首次应用 0068 的部署会在 0068 处 fail closed。

**registry version 与 fingerprint 的关系（披露）**：
`ONE_A_3B_G1_SCHEMA_EXTENSION_REGISTRY_VERSION` 有意不进入 manifest 的
`releaseIdentityFingerprint`/`fingerprint`。因此 `verifyOneA3bG1ReleaseManifest` 的
manifest 内容校验**无法检测注册表漂移**；注册表漂移由本票的 CI guard 与运行时 matcher
覆盖，而不是由 manifest 指纹覆盖。

两个真实契约检查点改为使用该 matcher，错误消息保持不变：

- `packages/data/src/postgres-model-role-command-repository.ts`（`assertG1SchemaContract`，
  business store）；
- `packages/data/src/postgres-purge-marker-repository.ts`（`assertSchemaContract`，
  purge-marker store）。

未改动任何历史 manifest、pins、evidence、已提交迁移（0068/0069/0070 字节未变），
未 rebind 任何 G1 角色（无 prompt/schema/参数变化）。

### 1.2 CI guard（文件哈希 + protected-surface DDL 拒绝表）

新增 `scripts/check-schema-extensions.ts`：

- 文件哈希检查：已落地的注册扩展文件 SHA-256 必须等于注册值；文件缺失记为
  `pending`，不算失败（支持“兼容部署先于迁移部署”）。
- protected-surface DDL 拒绝表：`generation_commands`、`model_role_*`、
  `provider_egress_*`、`workflow_commands`、`owner_purge_orders`、
  `owner_purge_receipts`、`owner_purge_operational_metadata`、`purge_markers`、
  `schema_migrations`。对这些表只允许“新增可空列”或“建索引”；任何
  DROP/TRUNCATE/DELETE/UPDATE/INSERT/RENAME 一律失败。新增列还必须真正可空：除字面
  `NOT NULL` 外，`PRIMARY KEY` 与 `GENERATED ... AS IDENTITY` 这类隐含 NOT NULL 的形式
  也被拒绝。索引必须通过 `ON <relation>` 命中受保护表才按“附加索引”放行；仅在语句
  其他位置（如索引名）出现受保护表名的一律 fail closed。
- **精确范围**：本保证只覆盖已注册的扩展文件，且只覆盖显式命名了拒绝表清单中关系的
  语句。未注册的迁移文件不在此 guard 内检查，而由运行时 schema-contract matcher 在
  G1 admission fail closed。
- 无数据库、无网络、无 secret。

接入固定基线：

- `package.json`：新增 `check:schema-extensions`，并加入 `validate` 组合。
- `.github/workflows/pr-validate.yml`：新增对应步骤（workflow 测试要求 validate 的
  每个步骤都出现）。
- `scripts/daily-release-validation.ts`：`FIXED_PR_CI_BASELINE` 与 `RELEASE_CHECKS`
  新增 `baseline:check-schema-extensions`（daily release 的固定基线现在 7 项）。
- `tsconfig.g1-tools.json`：纳入新脚本类型检查。

### 1.3 测试

- `packages/application/src/schema-extension.test.ts`：matcher 语义（前缀、空扩展
  全等、预注册 pending、未注册/漂移/乱序 fail closed、注册表格式、canonical code-unit
  排序、purge-marker 名称不得进入 business）。
- `tests/check-schema-extensions.test.ts`：DDL 拒绝表与文件哈希 guard（注入 IO）：
  隐含 NOT NULL 形式、索引 `ON` 目标、仅命名不命中、新增 ledger 表、marker store 的
  pending/哈希漂移。
- `tests/system/g1-opencode-go-schema.system.test.ts`：真实业务库上 frozen prefix +
  已注册扩展被 admit；全等基线；未注册额外行、前缀哈希漂移 fail closed。
- `tests/system/g1-purge-restore-drill.system.test.ts`：真实双库（business +
  purge-marker）：purge 清除 owner-scoped 的 `recent_conversation_context` 引用与
  `compiled_contexts`，内容只留无正文墓碑、不复活；content-free 且无 `user_id` 的
  `recent_context_policies` 治理身份保留；purge-marker 契约全等，未注册迁移 fail
  closed。

## 2. 隔离确定性验收

环境：Node 24.18.0；`TEST_DATABASE_URL=postgresql://127.0.0.1:55492/sayhear_292_business`；
`TEST_PURGE_MARKER_DATABASE_URL=postgresql://127.0.0.1:55492/sayhear_292_purge_marker`。

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| schema-extension guard | `pnpm check:schema-extensions` | exit 0；`3 verified, 0 pending`（0068/0069/0070 哈希匹配） |
| 两测试库就绪 | `pnpm ci:verify-test-databases` | exit 0；两库独立 |
| 定向双库 system | `pnpm exec vitest run tests/system/g1-opencode-go-schema.system.test.ts tests/system/g1-purge-restore-drill.system.test.ts` | exit 0；2 files / 13 tests passed / 0 skipped |
| 确定性跨日矩阵 | `pnpm exec vitest run packages/application/src/recent-context.test.ts tests/system/context-inspector-retrieval.system.test.ts` | exit 0；2 files / 32 tests passed / 0 skipped |
| effective-config / promotion | `pnpm exec vitest run tests/effective-runtime-config-gate.test.ts tests/g1-promotion-config-report.test.ts tests/runtime-config.test.ts tests/one-a-3b-release.test.ts` | exit 0；4 files / 80 tests passed |
| 新开关 effective-config / operator | `pnpm exec vitest run tests/effective-runtime-config-route.test.ts tests/operator-recent-context-handler.test.ts` | exit 0；2 files / 9 tests passed |
| 固定基线一致性 | `pnpm exec vitest run tests/daily-release-validation.test.ts` | exit 0；38 tests passed |
| 全量 | `pnpm validate` | **exit 0**；157 files / 2003 tests passed / 0 failed / 0 skipped |
| system suite 断言 | `pnpm exec tsx scripts/ci/assert-system-suites-ran.ts artifacts/vitest-report.json` | exit 0；`system suites 40/40 executed; system tests 456; skipped 0` |

- 跨日/语言/日期/DST/长日/多经历/异步失败/明确用户控制/owner/revision/epoch/Purge/
  竞态/旧格式/HMAC/读取降级/Inspector 的覆盖由上述 system 矩阵与 `pnpm validate`
  全量执行承载；无跳过项。
- 生产不执行 Purge/备份恢复演练；验收资产全为合成内容。

## 3. 实际生产启用（未执行，待 operator）

**关键未知**：本 checkout 无法读取生产 G1 开关状态（content-free endpoint 早前返回
401，无凭据）。生产 G1 是否打开**必须由 operator 实测**，绝不假设为关。实际的
production promotion 与 recent-context 首次启用需要 Luke/operator 凭据，不在本票
范围内执行。

### 3.1 两段式部署（promotion record）

**前置事实（operator 必须自证）**：accepted manifest 的 `schema.migrations` 最后一条
必须由 operator 从生产部署的 manifest env（`SAYHEAR_1A_3B_G1_RELEASE_MANIFEST`）读出并
核对；本报告以 origin/main `503e9aa` 的 `0067_g1_opencode_go_conversation_text_egress_policy.sql`
作为 accepted line 的末条迁移，因此 0068/0069/0070 都是相对该前缀的注册扩展。不得用本
报告的假设替代部署现场读取。

**兼容构建如何产出**：从当前 main（0067 line）临时拉一个分支，只携带 matcher +
registry + guard（0068/0069/0070 三个 registry entry 已登记，但迁移文件不包含）。
在该分支上 `pnpm check:schema-extensions` 必须打印 `3 pending`（三个文件都不存在）。
部署该兼容构建并确认 G1 仍可用（历史 accepted manifest 前缀 + 无 extra 即可准入）。
然后再部署 feature 分支（含三个迁移文件）。

**step 1 的条件性**：若 step 0 由 operator 实测确认生产 G1 为 **OFF**，则单次部署
（直接部署 feature 分支）可接受，且必须如实记录“单次部署”。但**任何情况下都不得把
“G1 关着”当作机制**：兼容 matcher 是唯一保证 G1 打开时安全的机制。

```json
{
  "record": "issue-296-recent-context-schema-admission",
  "acceptedLineLastMigration": "0067_g1_opencode_go_conversation_text_egress_policy.sql",
  "registeredExtensions": [
    { "store": "business", "name": "0068_recent_conversation_context_refs.sql", "sha256": "8984556a9578c2badc662e361df62bf8607b326b9075208346d1d5f63765015d" },
    { "store": "business", "name": "0069_recent_context_request_timezone.sql", "sha256": "45b9f606ad28c62e99826e635b83b8d9a16ec032a2073f14bbbb02382f9cf42b" },
    { "store": "business", "name": "0070_recent_context_governance.sql", "sha256": "3468342de597d7c5151586f11bc1c2baaa454c71b0ae3ea78bf9e91542ad72f7" }
  ],
  "registryVersion": "1a3b-g1-schema-extensions:v1",
  "registryVersionInsideManifestFingerprint": false,
  "g1RoleRebind": false,
  "steps": [
    {
      "order": 0,
      "actor": "operator",
      "action": "verify",
      "detail": "从生产 manifest env 读 accepted manifest 的 schema.migrations 末条与 G1 开关状态、部署 SHA、effective config；记录 deploy identity。不得假设开关为关。"
    },
    {
      "order": 1,
      "actor": "operator",
      "action": "deploy-compatibility (conditional)",
      "detail": "若 G1 为 ON：从 0067 main line 拉临时兼容分支，只带 matcher+registry+guard，`pnpm check:schema-extensions` 必须为 3 pending；部署并确认 G1 仍可用。若 operator 实测 G1 为 OFF：可直接单次部署 feature 分支，但需如实记录且不得把 G1-off 当机制。"
    },
    {
      "order": 2,
      "actor": "operator",
      "action": "deploy-migrations",
      "detail": "部署本 feature 分支（含 0068/0069/0070）。生产 Vercel 构建运行 db:migrate 应用迁移，运行中的兼容 matcher 按注册扩展准入新行。若第 1 步先跑，则避免旧代码对新增行的全等失败窗口。"
    },
    {
      "order": 3,
      "actor": "operator",
      "action": "enable-recent-context",
      "detail": "GET /api/internal/operator/recent-context 读取 content-free effective state；以 Internal Owner 会话 POST {\"action\":\"enable\"} 插入全新不可变版本。"
    }
  ],
  "rollback": [
    "POST /api/internal/operator/recent-context {\"action\":\"disable\"} 撤销 active 版本；在飞选择在下一 fence fail closed。",
    "需要时回退到兼容构建；保留已应用迁移与 recent_context_policies 行，不删除、不改写。",
    "不编辑已提交迁移，不复活 revoked 版本，不重绑未变 G1 角色。"
  ],
  "operatorVerification": {
    "g1SwitchState": "unknown-until-operator-read",
    "acceptedManifestLastMigration": "must-be-read-from-deployed-manifest-env",
    "endpoint401Observed": true
  }
}
```

### 3.2 首次启用/关闭的具体 operator 调用

- 读取：`GET /api/internal/operator/recent-context`（Internal Owner 会话）。
- 启用：`POST /api/internal/operator/recent-context`，body `{"action":"enable"}`；
  成功返回 `outcome: "enabled"` 与新 effective state。
- 关闭：`POST /api/internal/operator/recent-context`，body `{"action":"disable"}`；
  返回 `outcome` 与有效状态。关闭后原对话路径可用，控制记录/治理版本不丢失。
- 认证/能力与 Full Purge operator surface 一致（单一 Internal Owner 身份）。
- **真实响应码**：未认证 `401`；已认证但非 Internal Owner `403`；非法 action / 非法
  JSON / 客户端传入 `user_id`/`owner_id` 参数 `400`；对已启用路径重复 `enable` `409`
  （`error: "already_enabled"`）；非 GET/POST `405`（`Allow: GET, POST`）。

### 3.3 凭据限制

- 本环境无生产凭据；用户给定的 content-free endpoint 早前返回 401。
- 因此生产 G1 开关状态、deployment id、实际 promotion 均**未验证**，需 operator
  执行并回填。不得以本报告冒充生产启用证据。

### 3.4 本票不走的 release 路径（披露，F1）

`scripts/verify-1a3b-g1-evidence.ts` 仍会从**当前工作树**的迁移文件重算 AC-D01 release
identity（`buildG1ReleaseIdentityFingerprint` 于 :411，比较于 :458）；
`scripts/generate-1a3b-g1-source-docs.ts` 也会把 hosted schema 指纹与当前树迁移 pin 比较
（`inspectSchema` 约 :547-558）。本票**不修改**它们：G1 配置未变、本票不执行任何
activation，这些命令不在本次 release path 上。

风险说明：若 operator 用早于 0068–0070 的 evidence 运行
`pnpm release:g1:verify` / `pnpm release:g1:activate`，重算出的 identity 不会与已记录的
identity 一致（当前树含 0068–0070）。operator 可用
`pnpm release:g1:verify --manifest <path>` 检查该不一致。解决该不一致属于版本化/完整
G1 release 流程的职责，**不属于本票**；本票不重算、不重写、不覆盖任何 accepted
manifest/evidence/pin，也不放宽任何 gate。

## 4. 上线后体验观察（待确认）

- 未进行第二层真实 Provider 回复人评、blind pairwise、自然度阈值或模型自评。
- 延迟/token 限制尚未测量，标为待观察。
- 私人聊天不复制为正式测试/评测/框架样本。
- Luke 在正常聊天中验收体验；未观察效果明确待正常使用确认。
