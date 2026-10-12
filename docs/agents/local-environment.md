# 本地环境变量

本地私有变量分成两个独立配置 profile，`.env` 和 `.env.neon` 都被 Git 忽略。
`.env.example` 是可提交的应用配置模板，不是运行时配置。

## 两套配置不能合并

- `.env` 是仓库 README 中数据库命令使用的本地应用配置 profile。
- `.env.neon` 是 Neon 数据库、测试库和本地 Provider 探针/评测使用的 profile。
- `DATABASE_URL`、`PURGE_MARKER_DATABASE_URL` 和 `DEEPSEEK_API_KEY` 会同时出现在两份
  文件中，但值不同是有意的：它们分别指向各自 profile 的目标。不要跨文件同步这些值，
  也不要因为值不同就覆盖其中一份。
- 一条命令只加载与任务目标匹配的 profile。README 中的应用/数据库命令使用 `.env`；
  Neon 测试和探针使用 `.env.neon`。确实需要混用时，逐个变量明确指定来源，并在执行
  写入或迁移前确认数据库目标。

## 常用变量

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 本地运行应用或数据库命令时使用的业务数据库 |
| `PURGE_MARKER_DATABASE_URL` | 独立的 Purge Marker 数据库；必须与 `DATABASE_URL` 分开 |
| `TEST_DATABASE_URL` | 连接系统测试或评测使用的业务测试库 |
| `TEST_PURGE_MARKER_DATABASE_URL` | 连接测试专用的 Purge Marker 库；必须与 `TEST_DATABASE_URL` 分开 |
| `DEEPSEEK_API_KEY` | 使用 DeepSeek 的本地 Provider 探针、采集或评测 |
| `OPENCODE_GO_API_KEY` | 使用 OpenCode Go 的本地 Provider 探针、采集或评测 |

运行测试或数据库操作前，先确认目标是本地/测试数据库。不要把生产数据库用于测试。

## 查找和加载

只查看变量名时，使用不会显示值的命令：

```sh
sed -n 's/=.*//' .env.neon
```

`.env.neon` 的值可能含有 shell 特殊字符，不要直接 `source`。按需将指定 profile 中的
单个变量读入当前 shell，不要打印命令展开结果；例如从 Neon profile 读取测试库：

```sh
export TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env.neon | cut -d= -f2-)"
```

需要其他变量时替换变量名和文件名，并保持 `.env` 与 `.env.neon` 的来源选择明确。只加载
当前任务所需的变量；避免 `cat` 环境文件、开启 shell xtrace（`set -x`）或将变量值写入
日志、提交、Issue 和对话。
