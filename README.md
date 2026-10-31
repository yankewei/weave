# Weave

由 AI 驱动的项目、文档与任务协作系统。当前已完成登录、工作空间成员、项目与文档版本、任务看板，以及对话生成并确认任务提案的闭环。

## 当前功能

- 邮箱密码注册、登录、退出与七天服务端会话；注册时创建工作空间。
- 工作空间内创建项目，像 Confluence 一样阅读和所见即所得地编辑文档（正文以 Markdown 存储）。
- 每次正式修改同时保存当前内容、不可变版本快照和操作记录。
- 按版本显示修改人、时间、修改方式及相邻版本的标题与正文差异。
- 恢复历史生成新版本；内容相同不增加版本。
- 乐观并发检查：过期版本返回冲突，不覆盖新内容；页面保留冲突草稿。
- 项目任务看板：待办、进行中、已完成；拖拽流转与列内排序，刷新后保留顺序。
- 任务详情支持描述、验收标准、优先级、成员负责人、评论与一级回复、搜索筛选及不可变变更历史。
- 项目首页是工作台：对话旁列出进行中与待办，下方汇总各项目进度、等我确认的提案、最近文档与变更动态。
- 项目内 AI 对话：描述要做的事，模型返回待确认的任务提案；确认后才写入看板，并在任务历史中保留提案来源。
- 任务编号 `DEV-n`、文档编号 `DOC-n`，在整个工作空间内递增。对话、评论、任务历史和文档正文里的编号会变成链接；在对话里引用编号，服务端会把对应任务或文档的内容交给模型。
- 管理员按邮箱邀请已注册成员、查看成员并移除成员；成员可以退出，空间至少保留一名管理员。
- 根据当前成员关系隔离工作空间数据。
- 文档正文可以点按钮、粘贴或拖入图片（PNG、JPEG、GIF、WebP，单张不超过 4 MB）。图片默认存到部署自带的 S3 兼容存储（compose 里是 RustFS）；管理员可以在设置里为工作空间改用自己的 S3 兼容存储。图片经 `/api/uploads/:id` 读取，每次校验工作空间成员关系。

任务提案目前只创建新任务，不会修改已有任务；修改已有任务仍需手工编辑。文档修改提案、持久化任务队列、邮箱验证与密码重置尚未实现。模型调用在请求内完成，超过 70 秒仍在执行中的记录会在下次访问时标记失败。每个注册账号创建独立工作空间，暂未提供申请加入已有空间的界面。

## 工程结构

当前运行架构为 nginx + AMPHP + Pi Durable，见 [ADR 0002](docs/adr/0002-nginx-amphp-pi-durable.md)。前端是纯客户端 SPA，所有同源 `/api` 请求均由 PHP 处理。默认 compose 不运行 legacy；其迁移脚本、测试和旧源码留待下一阶段清理。

agent 使用 SQLite 保存私有对话、输入凭据和执行检查点，读取 `CMD_API_KEY` / `CMD_MODEL`，通过 PHP 内网工具读取资料并提交待确认提案。刷新恢复执行，断线重连恢复最新快照，见 [ADR 0004](docs/adr/0004-conversation-reconnect-uses-snapshots.md)。本项目没有历史导入要求，当前契约见[对话与提案契约](docs/conversation-migration.md)，详细实施计划见[直接切换计划](docs/conversation-cutover.md)。

```text
web/                      React SPA（Vite + React Router），nginx 托管构建产物
  app/                    入口、路由与 loader（会话检查、重定向、成员校验）
  components/             页面组件与 shadcn/ui 控件
legacy/                   Next.js Route Handlers 与 lib/services，迁完后删除
api/                      AMPHP 业务 API（PHP 8.5）
agent/                    Pi Durable AI 服务（Node 24），只在内网供 api 调用
nginx/                    唯一对外入口：托管 SPA，分发 /api
migrations/               按序执行的 PostgreSQL SQL 迁移
docs/                     产品、架构和实现说明，ADR 在 docs/adr/
compose.yaml              一条命令启动全部服务
```

前端只通过同源的 `/api` 访问后端。路由 loader 先确认会话和工作空间成员身份，未登录时跳到 `/login`；交互密集的部分由组件自己请求数据。PHP 处理事务、版本检查、权限与审计；agent 只通过内网工具访问业务数据。

## UI 规范

前端使用 shadcn/ui Nova + Base UI、Tailwind v4 与 Lucide。官方 shadcn skill 已安装在 `.agents/skills/shadcn`，版本来源记录在 `skills-lock.json`。后续 UI 工作遵守 `AGENTS.md` 与 `DESIGN.md`，通过 `components.json` 读取配置。

在 `web/` 目录执行 `pnpm dlx shadcn@latest info --json` 查看项目配置；先查 `docs` 再从 `@shadcn` 添加组件。页面使用统一主题和组件变体，ESLint 禁止绕过官方控件与使用 `window.confirm`。

## 本地启动

需要 Docker。先准备环境变量：

```sh
cp .env.example .env
```

把 `.env` 里的 `POSTGRES_PASSWORD` 换成自己的本地密码，`AGENT_SERVICE_TOKEN` 用 `openssl rand -base64 32` 生成。

### 用 Docker 启动全部服务

```sh
pnpm up
```

- 应用地址：http://localhost:8080（端口由 `WEB_PORT` 决定），打开后注册账号。只有 nginx、Postgres 和 RustFS（默认图片存储，端口由 `S3_PORT` 决定）暴露在本机。
- 健康检查：http://localhost:8080/api/health，由 AMPHP 并发检查数据库和 agent，任一不可用时返回 503。
- 每次 `pnpm up` 都会先由一次性的 `migrate` 服务在容器网络内执行 `migrations/`，api 等它成功后才启动；服务运行中新增迁移文件后，执行 `pnpm db:migrate` 补跑。迁移只作用于 compose 里的数据库，不受本机 5432 端口上其他 Postgres 的影响。

停止并保留数据：

```sh
pnpm down
```

### 开发前端

后端照常用 Docker 运行，前端用 Vite 开发服务器，`/api` 会代理到 nginx（默认 http://localhost:8080，可用 `API_PROXY_TARGET` 修改）：

```sh
pnpm install
pnpm up
pnpm --filter weave-web dev      # http://localhost:5173
```

`pnpm --filter weave-legacy db:migrate` 仍可从本机迁移 `.env` 指向的数据库，例如 compose 之外的本机 Postgres。修改 `api/` 或 `agent/` 后，用 `docker compose up -d --build <服务名>` 重新构建对应服务。也可以在本机直接运行：`pnpm --filter weave-agent dev`，或 `(set -a; . ./.env; php api/bin/server.php)`（需要 PHP 8.5 及 `pcntl`、`pgsql` 扩展，先执行 `composer install --working-dir=api`）。

## 使用流程

注册并进入工作空间后，首页就是对话。写下要做的事，会创建一个项目并让 AI 拆出待确认任务。已有项目的首页是工作台：左边是这条对话，右边列出本项目的进行中与待办（可只看分给自己的），下面是工作空间里各项目的进度、最近文档和最近动态。也可以从侧栏用名称新建项目，再创建文档。编辑标题或正文并保存，右侧显示新的历史版本。选择历史版本可查看与前一版本的差异，点击恢复会把该版本的内容保存成新版本。

在工作空间顶部或侧栏打开「设置」。工作空间名称下面是成员。管理员可以邀请已经注册的邮箱；移除成员或自己退出时，此人负责的任务会改为未分配。空间里至少保留一名管理员。

项目内点击“任务看板”创建任务，拖动卡片手柄调整状态与顺序，也可以在详情面板修改状态。搜索与负责人、优先级筛选只影响展示。

在首页描述要做的事，或点一张起点卡片。AI 返回任务提案；点击确认后，这些任务进入待办，并出现在输入框上方的产出卡片里。拒绝或模型失败都不会创建任务。看板和文档页面可以从右侧打开同一条对话。

地址可以打开具体页面：`/workspaces/工作空间/settings`、`/workspaces/工作空间/projects/项目`、其后的 `/board`，以及 `/documents/文档`。`/workspaces/工作空间/browse/DEV-12` 跳到对应任务（在看板上打开详情），`/browse/DOC-3` 跳到对应文档。项目地址打开的是这条对话。刷新或把链接交给已登录的成员会打开同一页。未登录时由服务端重定向到登录页，登录后回到首页。对话不写进地址。

切换文档或离开页面会提示未保存的修改。草稿仅在当前页面内存中保留，未提供离线草稿持久化。发生版本冲突时，先复制需要保留的内容，再加载最新版本继续编辑。

## 构建与检查

```sh
pnpm check
```

根目录的 `check` 依次检查根目录文档格式、web 与 legacy（ESLint、类型检查、Vitest、Prettier 与构建）、agent（类型检查、进程测试与 Prettier）和 api（PHPStan 最高级别与 PHPUnit）。api 的测试会启动真实的 `bin/server.php`，需要本机的 Postgres 和 RustFS，先执行 `pnpm db:up`。最后的 `pnpm test:cutover` 使用真实 PHP 与 agent、临时 schema 和 SQLite、受控模型，验证输入去重、断连后继续执行、提案回写和重复确认只创建一次任务。

集成测试使用 `embedded-postgres` 创建临时的真实 PostgreSQL 17 实例，自动迁移并清理，不读取 `.env`、不访问开发数据库，也不依赖 Docker。测试覆盖权限隔离、权限撤销、并发冲突、历史恢复、无变化编辑、事务回滚、历史不可变、任务评论与回复、成员移除等。`legacy/scripts/e2e.mjs`（`pnpm --filter weave-legacy e2e`）是额外的 API 契约验证：启动生产构建并通过 HTTP 走完注册、项目、文档、任务、评论与编号定位，之后也用来验证迁到 AMPHP 的接口。

web 的构建产物位于 `web/dist`，legacy 的位于 `legacy/.next`。

## 部署

通过 compose 或等价的长期运行容器部署 nginx、PHP API、单实例 agent、PostgreSQL 与 S3 存储；不再以 Next.js/Vercel 作为当前部署入口。

设置 `.env.example` 中的数据库、`AGENT_SERVICE_TOKEN`、模型和 S3 配置。生产入口使用 HTTPS，并设置与浏览器地址一致的 `APP_ORIGIN` 和正确的 `TRUSTED_PROXY_HOPS`。必须挂载 PostgreSQL、agent SQLite 与 RustFS 持久卷；agent 不能多实例共享同一个 SQLite 文件。

发布时先备份两套数据库，再同步发布迁移 `014`、PHP、agent、SPA 和 nginx。没有旧对话需要复制，不执行导入。SQLite 应使用 backup API 或停机复制数据库与必要 WAL。新消息只存在 agent 存储，不应回退到 legacy 读取。详细步骤见[直接切换计划](docs/conversation-cutover.md)。

## 配置与边界

- 密码使用随机盐和 scrypt 派生；会话通过 HttpOnly、SameSite Cookie 传递，数据库仅保存令牌摘要。
- 登录和注册共用按来源 IP 计数的数据库限流，每 15 分钟最多 20 次。注册每次都计数；登录先占用一次额度，密码正确时退还，所以只有失败的登录会累计。来源 IP 取 `X-Forwarded-For` 中由可信代理追加的条目，客户端自己伪造的前缀不会生效。
- 写请求需要 `X-Weave-Request: 1`，浏览器 Origin 必须匹配 `APP_ORIGIN`，未启用跨域访问。
- PHP 根据 `APP_ORIGIN` 的 HTTPS 配置设置 Secure Cookie。生产反向代理、限流和注册策略仍需部署前细化；当前不提供邮箱验证、密码找回或账号管理。
- 不要把数据库密码或模型密钥写入任何 `NEXT_PUBLIC_` 变量，它们会被打进浏览器产物。
- 任务对话由 Pi Durable 调用 Command Code 的 Chat Completions，使用 agent 的 `CMD_API_KEY`，可选 `CMD_MODEL`。POST 持久接收输入后返回 202，回复通过独立 GET SSE 快照更新。浏览器关闭不会取消生成。
- 图片上传经过应用服务端：校验成员身份、按文件内容识别类型（不接受 SVG），再写入存储。没有配置 S3 的工作空间使用部署的默认存储；配置后，之后的图片写入该 S3（按路径寻址，兼容 AWS S3、Cloudflare R2、RustFS 等）。默认存储同样按当前配置读取：换了默认存储的桶，已有图片无法显示。S3 访问密钥使用 AES-256-GCM 加密保存。图片按工作空间当前的 S3 读取：更换桶或改回默认存储后，已有 S3 图片无法显示。图片在编辑器里直接显示，正文中以 `![名称](/api/uploads/…)` 保存。
- 迁移文件会记录 SHA-256 校验值；已应用的文件被修改时迁移会失败，应改为新增迁移。
- `.env`、依赖、构建和覆盖率不会提交；开源许可证见 [LICENSE](LICENSE)。

## 文档

- [决策汇总](docs/decisions.md)
- [产品与数据设计](docs/product-and-data-design.md)
- [文档闭环实现](docs/document-lifecycle.md)
- [对话与提案迁移契约](docs/conversation-migration.md)

## 许可证

本项目采用 [MIT](LICENSE) 许可证。
