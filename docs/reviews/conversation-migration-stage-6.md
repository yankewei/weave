# 第 6 阶段 code review

范围：删除 legacy 源码与依赖、迁走迁移执行器和 HTTP 契约验证、清理旧消息结构，以及保持检查链路完整。

## 已完成

- 迁移执行器从 `legacy/scripts/migrate.mjs` 迁到独立工作空间包 `migrate/`，行为保持不变：按文件名排序、事务加 advisory lock、记录 SHA-256 校验值。compose 的 `migrate` 服务改用 `migrate/Dockerfile`。
- HTTP 契约验证从 `legacy/scripts/e2e.mjs` 迁到 `api/tests/e2e.mjs`，通过新的 `api/tests/fixtures/e2e.php` 启动真实 `bin/server.php` 和临时 schema；覆盖注册、项目、文档版本、任务、评论、编号定位与会话退出。根脚本 `pnpm test:e2e` 已接入 `pnpm check`。
- 删除 `legacy/` 全部源码、构建配置和依赖；`pnpm-workspace.yaml` 移除 legacy 与 `embedded-postgres` 构建白名单，锁文件随之更新。
- 新增迁移 `015`：删除旧 `messages` 表和 `ai_runs.trigger_message_id`，保留历史 `ai_runs` 供提案与任务追溯。
- 从 PHP 测试移除只能由 legacy 产生的消息种子和旧执行兼容用例；同项目私有归属、提案隔离和事务回滚等覆盖保留。
- 更新 README、`.env.example`、`AGENTS.md` 和对话契约，移除 legacy、Vercel、`NEXT_PUBLIC_` 等过期说明；部署清单加入迁移 `015`。

## 验证

- `pnpm check`：文档格式、web（lint、类型检查、24 项 Vitest、Prettier、构建）、agent（类型检查、10 项进程测试、Prettier）、PHPStan、51 项 PHPUnit、`pnpm test:cutover` 和 `pnpm test:e2e` 全部通过。
- `pnpm test:e2e` 也可单独运行，真实 PHP 进程与临时 schema 下完整通过。
- 迁移 `015` 在临时 schema 上由测试套件执行；未对实际数据库执行迁移或线上切流。

## 仍需部署前完成

- 对实际 PostgreSQL 与 agent SQLite 做一致备份，并演练恢复。
- 发布时同时执行迁移 `014`、`015`、PHP、agent、SPA 与 nginx。
