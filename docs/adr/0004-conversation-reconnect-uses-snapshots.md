# 对话重连恢复最新快照，不重放逐条流事件

修正 ADR 0002 对 Pi Durable 续传能力的描述。采用当前锁定的 `@earendil-works/pi-durable` 1.4.0，通过 SQLite 保存对话和执行检查点；浏览器重连 SSE 时恢复最新已提交状态，不承诺逐条补发断线期间的 token 或工具事件。

核对依据是 [v1.4.0 的 Watching a Conversation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#watching-a-conversation)：`watch()` 在连接时提供当前视图，不重放历史；慢订阅超过 100 个待发送帧时会合并成最新完整视图。它没有 ADR 0002 假设的 `from` 游标接口。持久化状态与可回放事件日志是不同的能力。

## Decision

- agent 把已提交视图投影成 Weave 对话快照，通过 SSE 的 `snapshot` 事件发送。每次连接先发当前快照，后续事件也可替换当前快照；前端不通过拼接 token 恢复回复。
- 不发送 SSE `id`，不把 `Last-Event-ID` 转成 Pi Durable 参数。重连带来的旧 `Last-Event-ID` 不影响快照恢复。历史分页游标只用于消息列表，与 SSE 无关。
- 浏览器断开只释放订阅，生成继续；agent 进程重启后打开原 SQLite 并恢复任务。恢复中的模型请求可能重试，因此模型调用本身不保证恰好一次。
- 消息、执行状态和提案保存结果按稳定标识合并。前端只有在重新读取 PHP 中的提案状态后，才显示待确认或已应用；assistant 文本不作为业务写入凭据。
- PHP 不缓存流、不保存流游标，也不重新生成 SSE 内容，只校验身份和归属后透传 agent 流。提案状态通过 PHP 的业务接口读取。

## Considered Options

- 在 SQLite 额外建立可回放事件日志：能够逐条续传，但需要处理提交原子性、事件保留、游标失效和快照压缩。当前界面只需要恢复消息与进行中的回复，没有这项需求。
- 直接转发 Chord operations：与 Pi Durable 视图和内部文档结构耦合，前端还需要处理完整视图替换。由 agent 投影成应用快照更容易稳定对外契约。
- 只在生成完成后读取结果：省去 SSE，但失去生成中的反馈。

## Consequences

- 断线期间的中间动画不会重播，已提交的回复和最终结果仍能恢复。晚加入的浏览器和慢连接使用同一套快照逻辑。
- 快照只包含最近一页可显示消息与当前执行，不能把完整历史放进每一帧；更早消息单独分页读取。
- 仍使用官方支持的 SQLite 后端。官方建议长期运行的 agent 使用 SQLite；JSONL 会把完整历史保留在内存。SQLite 默认 WAL + `synchronous = NORMAL` 可承受进程崩溃，但主机故障或断电可能丢失最新提交，部署需持久卷和一致性备份。
- 一个 SQLite 存储只允许一个 agent 进程拥有；禁止滚动发布时新旧进程同时打开同一个文件。
- 本决定替代 ADR 0002 中 `Last-Event-ID` / `from` 补发流事件的描述。接口和迁移步骤见[对话与提案迁移契约](../conversation-migration.md)。
