# 后端拆为 AMPHP 业务 API 与 Pi Durable AI 服务

Weave 由 Next.js 全栈改为四个服务，用一个 docker compose 启动：nginx 作为唯一入口，托管 React（Vite SPA）静态文件并把 `/api/` 转给 PHP；PHP 基于 AMPHP，是唯一的后端入口，也是唯一连接 Postgres 的服务；Node 服务包装 Pi Durable，只在内网开放，负责 AI 对话的执行、持久化和输出订阅。选 PHP 和 AMPHP 是有意的尝试，不是现有 TS 后端出了问题。

职责边界：PHP 决定“是谁、能不能做、最终写什么”，agent 决定“AI 怎么跑、怎么推流”。

- 身份：登录会话由 PHP 管理（HttpOnly cookie）。PHP 校验身份和对话归属（见 ADR 0001）后才调用 agent。agent 只认 PHP 的服务 token。
- 生成与连接无关：发消息时，PHP 把输入转给 agent，agent 用 `submit()` 持久化接收后立即返回，生成作为 harness 里的持久任务运行。`requestId` 由前端生成，重试不会重复提交。
- 流式：浏览器向 PHP 订阅 SSE，PHP 向 agent 订阅 SSE（底层是 `watch()`），然后逐块透传。浏览器断开时，PHP 取消上游请求，只停止订阅，生成继续。重连恢复最新已提交快照，更早的历史通过分页接口读取。原先设想的 `Last-Event-ID` / `from` 补发不受当前 Pi Durable 支持，已由 [ADR 0004](0004-conversation-reconnect-uses-snapshots.md) 修正。PHP 不缓冲、不保存流的任何状态。
- 业务数据：agent 的工具只通过 PHP 内部接口读取文档和任务、提交提案，不直接连 Postgres。提案由 PHP 保存为待确认，用户确认后由 PHP 写入正式内容。

## Considered Options

- 保留 Next.js 全栈：最省事，但不符合尝试 PHP 的目的。前端只剩客户端代码后，Next 的服务端渲染和文件路由也用不上了。
- 先迁后端再拆前端：少一个过渡容器，但前端和后端同时在变，出了问题不好定位。
- Tempest 框架：写法现代，但只支持同步请求模型，PDO 调用会阻塞 AMPHP 的事件循环，两者不能一起用。
- neuron-ai（纯 PHP 实现 AI）：后端只剩一种语言，提案确认有 Workflow Interrupt 现成可用。没选的原因是想用 Pi Durable 的单步 checkpoint 和断线续传。
- 浏览器经 nginx 直连 agent（nginx `auth_request` 向 PHP 确认身份）：少一跳，但 agent 要暴露给网关并信任请求头。PHP 基于 AMPHP 时扛得住长连接转发，续传只需透传游标，所以让 PHP 作为唯一入口。
- PHP 签发短期 token，由 agent 验签：浏览器的 `EventSource` 不能设置请求头，还要处理续签。

## Consequences

- 后端有 PHP 和 Node 两种语言，`pnpm check` 要拆成 web、api、agent 各自的检查。
- 前后端不再共享 zod 契约，需要另找方式同步类型（OpenAPI 生成或手写）。
- PHP 的流式转发必须写对：背压、超时、浏览器断开时取消上游，任何阻塞调用都会卡住所有连接。
- Pi Durable 还是 experimental，API 可能变动。服务端采用官方内置的 SQLite 后端，对话数据存 SQLite 卷，和 Postgres 分开备份；一份存储只能由一个进程驱动，agent 只能单实例运行。当前锁定 1.4.0，官方还提供 memory、JSONL、浏览器 IndexedDB 和 Cloudflare Durable Object 存储。
- 迁移顺序是先拆前端，再换后端。第一步把页面改成 Vite + React Router 的 SPA，交给 nginx 托管，原来服务端页面里的会话检查、重定向和成员校验改到路由 loader 里，通过 HTTP 调用。原 Next 应用移到 `legacy/`，只保留 `/api` Route Handlers。之后前后端之间只剩 `/api/*` 这一层契约，nginx 每改一条路由，接口就从 `legacy` 切到 PHP，前端不用动。全部迁完后删除 `legacy/`。过渡期多一个容器。
