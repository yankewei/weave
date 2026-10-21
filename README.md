# Weave

由 AI 驱动的项目、文档与任务协作系统。当前已完成登录、工作空间成员、项目与文档版本、任务看板，以及对话生成并确认任务提案的闭环。

## 当前功能

- 邮箱密码注册、登录、退出与七天服务端会话；注册时创建工作空间。
- 工作空间内创建项目、创建和编辑 Markdown 文档。
- 每次正式修改同时保存当前内容、不可变版本快照和操作记录。
- 按版本显示修改人、时间、修改方式及相邻版本的标题与正文差异。
- 恢复历史生成新版本；内容相同不增加版本。
- 乐观并发检查：过期版本返回冲突，不覆盖新内容；页面保留冲突草稿。
- 项目任务看板：待办、进行中、已完成；拖拽流转与列内排序，刷新后保留顺序。
- 任务详情支持描述、验收标准、优先级、成员负责人、评论与一级回复、搜索筛选及不可变变更历史。
- 项目内 AI 对话：描述要做的事，模型返回待确认的任务提案；确认后才写入看板，并在任务历史中保留提案来源。
- 管理员按邮箱邀请已注册成员、查看成员并移除成员；成员可以退出，空间至少保留一名管理员。
- 根据当前成员关系隔离工作空间数据。
- 文档正文可以点按钮、粘贴或拖入图片（PNG、JPEG、GIF、WebP，单张不超过 4 MB）。图片默认存到私有的 Vercel Blob；管理员可以在设置里为工作空间改用自己的 S3 兼容存储。图片经 `/api/uploads/:id` 读取，每次校验工作空间成员关系。

任务提案目前只创建新任务，不会修改已有任务；修改已有任务仍需手工编辑。文档修改提案、持久化任务队列、邮箱验证与密码重置尚未实现。模型调用在请求内完成，超过 70 秒仍在执行中的记录会在下次访问时标记失败。每个注册账号创建独立工作空间，暂未提供申请加入已有空间的界面。

## 工程结构

应用是一个 Next.js App Router 全栈项目，页面、接口与数据访问在同一个部署单元内。

```text
app/                      App Router：页面与 /api Route Handlers
  api/                    与页面同源的 HTTP 接口
  workspaces/             工作空间、项目、看板、文档与设置
  login/                  登录与注册
components/               页面组件与 shadcn/ui 控件
  ui/                     shadcn 基础控件
lib/
  contracts.ts            Zod 输入输出契约与共享类型
  services/               事务、权限与 SQL（文档、任务、评论、成员、对话）
  auth.ts                 会话、密码与限流
  db.ts                   node-postgres 连接池
migrations/               按序执行的 PostgreSQL SQL 迁移
scripts/                  迁移与端到端验证脚本
docs/                     产品、架构和实现说明
```

服务端渲染的页面直接读取会话与工作空间；交互密集的部分是客户端组件，通过同源的 `/api` 调用 Route Handlers。数据结构与写入规则仍然只有一套：Route Handler 调用 `lib/services`，事务、版本检查、权限与审计都在服务层完成。

## UI 规范

前端使用 shadcn/ui Nova + Base UI、Tailwind v4 与 Lucide。官方 shadcn skill 已安装在 `.agents/skills/shadcn`，版本来源记录在 `skills-lock.json`。后续 UI 工作遵守 `AGENTS.md` 与 `DESIGN.md`，通过 `components.json` 读取配置。

在仓库根目录执行 `pnpm dlx shadcn@latest info --json` 查看项目配置；先查 `docs` 再从 `@shadcn` 添加组件。页面使用统一主题和组件变体，ESLint 禁止绕过官方控件与使用 `window.confirm`。

## 本地启动

使用 Node.js 24 和 pnpm 11，具体版本见根目录 `package.json`。

```sh
pnpm install
cp .env.example .env
```

将 `.env` 中的 `POSTGRES_PASSWORD` 替换为自己的本地密码，再执行：

```sh
pnpm db:up
pnpm db:migrate
pnpm dev
```

- 应用地址：http://127.0.0.1:3000，打开后注册账号。
- 存活检查：http://127.0.0.1:3000/api/health；就绪检查：http://127.0.0.1:3000/api/health/ready，数据库不可用时返回 503。
- 数据库使用 PostgreSQL 17。首次启动及更新迁移文件后，需要显式运行 `pnpm db:migrate`；应用不会自动修改数据库结构。
- 若数据库尚未健康，等待后重试迁移命令。
- 可配置 `DATABASE_URL` 替代 `POSTGRES_*` 连接配置；Compose 仍使用 `POSTGRES_*`。
- `APP_ORIGIN` 应与浏览器访问地址一致，默认为 `http://127.0.0.1:3000`，不要混用 `localhost`。
- 页面与接口同源，开发时不需要额外的代理配置。

停止本地数据库并保留数据：

```sh
pnpm db:down
```

## 使用流程

注册并进入工作空间后，首页就是对话。写下要做的事，会创建一个项目并让 AI 拆出待确认任务。已有项目的首页同样是这条对话。也可以从侧栏用名称新建项目，再创建文档。编辑标题或正文并保存，右侧显示新的历史版本。选择历史版本可查看与前一版本的差异，点击恢复会把该版本的内容保存成新版本。

在工作空间顶部或侧栏打开「设置」。工作空间名称下面是成员。管理员可以邀请已经注册的邮箱；移除成员或自己退出时，此人负责的任务会改为未分配。空间里至少保留一名管理员。

项目内点击“任务看板”创建任务，拖动卡片手柄调整状态与顺序，也可以在详情面板修改状态。搜索与负责人、优先级筛选只影响展示。

在首页描述要做的事，或点一张起点卡片。AI 返回任务提案；点击确认后，这些任务进入待办，并出现在输入框上方的产出卡片里。拒绝或模型失败都不会创建任务。看板和文档页面可以从右侧打开同一条对话。

地址可以打开具体页面：`/workspaces/工作空间/settings`、`/workspaces/工作空间/projects/项目`、其后的 `/board`，以及 `/documents/文档`。项目地址打开的是这条对话。刷新或把链接交给已登录的成员会打开同一页。未登录时由服务端重定向到登录页，登录后回到首页。对话不写进地址。

切换文档或离开页面会提示未保存的修改。草稿仅在当前页面内存中保留，未提供离线草稿持久化。发生版本冲突时，先复制需要保留的内容，再加载最新版本继续编辑。

## 构建与检查

```sh
pnpm check
pnpm start
```

`check` 包含 ESLint、类型检查、Vitest、Prettier 与构建。`pnpm start` 启动已经构建的生产服务。

集成测试使用 `embedded-postgres` 创建临时的真实 PostgreSQL 17 实例，自动迁移并清理，不读取 `.env`、不访问开发数据库，也不依赖 Docker。测试覆盖权限隔离、权限撤销、并发冲突、历史恢复、无变化编辑、事务回滚、历史不可变、任务评论与回复、成员移除等。`scripts/e2e.mjs` 是额外的浏览器级验证：启动生产构建并通过 HTTP 走完注册、项目、文档、任务、评论与页面渲染。

构建产物位于 `.next`。

## 部署

应用可以直接部署到 Vercel：导入仓库即可，Next.js 会被自动识别，无需 `vercel.json`。需要的环境变量：

| 变量                     | 说明                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | 托管 PostgreSQL 连接串，建议使用带 pooler 的地址（Neon、Supabase 等）                                          |
| `DATABASE_POOL_MAX`      | 每个实例的连接上限，Serverless 环境建议 2–3                                                                    |
| `APP_ORIGIN`             | 站点地址，例如 `https://weave.example.com`，必须与浏览器地址完全一致                                           |
| `CMD_API_KEY`            | Command Code 服务端密钥                                                                                        |
| `CMD_MODEL`              | 可选，默认 `deepseek/deepseek-v4.1-flash`                                                                      |
| `BLOB_READ_WRITE_TOKEN`  | 默认图片存储使用的私有 Vercel Blob；在 Vercel 关联 Blob 存储后自动注入                                         |
| `STORAGE_ENCRYPTION_KEY` | 32 字节 base64 密钥，加密工作空间的 S3 访问密钥：`openssl rand -base64 32`                                     |
| `TRUSTED_PROXY_HOPS`     | 可选，默认 1。应用前面会追加 `X-Forwarded-For` 的代理层数，用于识别登录限流的客户端地址；CDN 加 nginx 时设为 2 |

数据库结构与数据不在构建流程里改动：部署后需要针对生产库执行一次 `DATABASE_URL=... pnpm db:migrate:remote`。首次部署前请确认数据库允许来自 Vercel 的连接，并按实例数收紧连接上限。

## 配置与边界

- 密码使用随机盐和 scrypt 派生；会话通过 HttpOnly、SameSite Cookie 传递，数据库仅保存令牌摘要。
- 登录和注册共用按来源 IP 计数的数据库限流，每 15 分钟最多 20 次。注册每次都计数；登录先占用一次额度，密码正确时退还，所以只有失败的登录会累计。来源 IP 取 `X-Forwarded-For` 中由可信代理追加的条目，客户端自己伪造的前缀不会生效。
- 写请求需要 `X-Weave-Request: 1`，浏览器 Origin 必须匹配 `APP_ORIGIN`，未启用跨域访问。
- `NODE_ENV=production` 时 Cookie 使用 Secure，需通过 HTTPS 访问。生产反向代理、限流和注册策略仍需部署前细化；当前不提供邮箱验证、密码找回或账号管理。
- 不要把数据库密码或模型密钥写入任何 `NEXT_PUBLIC_` 变量，它们会被打进浏览器产物。
- 任务对话通过 Vercel AI SDK（`ai` 与 `@ai-sdk/openai-compatible`）调用 Command Code 的 Chat Completions，使用服务端 `CMD_API_KEY`，可选 `CMD_MODEL`。回复以服务器发送事件流式返回。
- 图片上传经过应用服务端：校验成员身份、按文件内容识别类型（不接受 SVG），再写入存储。没有配置 S3 的工作空间使用私有 Vercel Blob；配置后，之后的图片写入该 S3（按路径寻址，兼容 AWS S3、Cloudflare R2、MinIO 等）。S3 访问密钥使用 AES-256-GCM 加密保存。图片按工作空间当前的 S3 读取：更换桶或改回默认存储后，已有 S3 图片无法显示。文档目前只编辑 Markdown 源码，图片以 `![名称](/api/uploads/…)` 链接插入，渲染预览尚未实现。
- 迁移文件会记录 SHA-256 校验值；已应用的文件被修改时迁移会失败，应改为新增迁移。
- `.env`、依赖、构建和覆盖率不会提交；开源许可证见 [LICENSE](LICENSE)。

## 文档

- [决策汇总](docs/decisions.md)
- [产品与数据设计](docs/product-and-data-design.md)
- [文档闭环实现](docs/document-lifecycle.md)

## 许可证

本项目采用 [MIT](LICENSE) 许可证。
