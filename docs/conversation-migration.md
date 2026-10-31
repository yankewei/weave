# 对话与提案迁移契约

本文是迁移计划第 1 阶段的交付物，描述分阶段实现的契约，不表示所有接口已经上线。浏览器对话与提案仍由 legacy 处理，agent 内部实现进度见下文。架构以 ADR 0002 为基础，私有归属遵循 ADR 0001，重连语义按 ADR 0004 修正。

## 范围与现状

本轮完成持久对话、任务提案确认闭环和 legacy 清理。保持工作台、看板与文档侧栏的当前入口；每位成员在一个项目中暂时只有一条对话，不增加对话列表、切换或标题编辑界面。多条对话与历史页属于 GitHub #6。

目前 `conversations.project_id` 唯一，`open()` 和 `view()` 只检查工作空间成员，实际仍是项目共享对话，与 ADR 0001 的目标不同。迁移不能沿用这个权限行为。

nginx 已默认把 `/api/` 交给 PHP，只剩下列 legacy 路由：

| 路由                                                  | 当前行为               | 目标行为                                   |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `GET /api/projects/:projectId/conversation`           | 返回共享对话全部消息   | 返回当前用户的私有对话、最近消息和执行状态 |
| `POST /api/projects/:projectId/conversation/messages` | 在请求内生成并返回 SSE | 持久接收输入后返回 JSON，生成与连接脱离    |
| `POST /api/proposals/:proposalId/confirm`             | 确认后返回整条对话     | 事务应用提案，只返回提案                   |
| `POST /api/proposals/:proposalId/reject`              | 拒绝后返回整条对话     | 事务拒绝提案，只返回提案                   |
| `GET /api/health/ready`                               | 检查 legacy 数据库     | PHP 检查业务数据库，不触发模型调用         |

新增 SSE 订阅、历史分页与提案读取接口。发送消息和提案处理的响应将变化，前端与 nginx 必须一起切换，不能只改代理目标。

## 数据归属与标识

| 数据                                           | 唯一事实来源        | 约束                                               |
| ---------------------------------------------- | ------------------- | -------------------------------------------------- |
| 账号、登录会话、成员、项目                     | PostgreSQL / PHP    | agent 不连接 PostgreSQL                            |
| 对话归属及 agent 对话映射                      | PostgreSQL / PHP    | 按当前成员关系和 `created_by` 鉴权                 |
| 消息正文、模型上下文、执行检查点和进行中的回复 | SQLite / agent      | 只通过 Pi Durable 公共接口写入                     |
| 输入接收凭据与 AI 执行审计                     | PostgreSQL / PHP    | 保存关联标识、输入摘要哈希与状态，不复制新消息正文 |
| 提案、条目、正式任务和任务历史                 | PostgreSQL / PHP    | agent 只能提交待确认提案                           |
| 旧消息与旧执行记录                             | PostgreSQL 迁移归档 | 验证迁移完成前不删除，不再接收新消息               |

- `conversationId`：原 PostgreSQL UUID，作为公开标识，保留提案外键。新增对话也由 PHP 创建 UUID。
- `agentConversationId`：Pi Durable 创建的内部标识；不假设它与公开 UUID 相同。映射由 agent 按公开 `conversationId` 幂等创建并持久保存，PHP 保存返回的映射。即使创建响应丢失，也不能生成第二条 agent 对话。
- `requestId`：浏览器发送前生成的 UUID；同一次发送和所有网络重试使用同一个值。去重作用域为 `(conversationId, requestId)`，跨重启有效。
- `runId`：PHP 在输入接收凭据中预分配的 UUID，供审计与提案关联。`submissionId`、工具调用 ID、Pi entry ID 是内部不透明标识，不当作 UUID 解析。
- `admissionId`：PHP 为每次接收尝试分配并持久保存的 UUID，用于封存迟到提交；正常网络重试复用，只有原 admission 已确认关闭且未提交时才分配新的值。`requestId` 和 `runId` 始终不变。
- 消息公开 `id` 保持 UUID：旧消息沿用原 ID，新用户消息的 UUID 保存在 agent 应用记录中；新 assistant 消息从不可变 Pi 对话和 entry 标识派生 UUIDv8。重连与分页不得给同一消息重新分配 ID。Pi 内部标识当前是数值，PHP 将其当作不透明标识使用，不能假设它是 UUID。

PostgreSQL 需要新增迁移，不能修改已应用的 SQL：将项目唯一约束改成 `(project_id, created_by)`，增加 agent 映射与导入状态，增加输入接收凭据。`ai_runs.trigger_message_id` 的现有非空外键只适用于旧消息；新执行应关联输入凭据，使用约束保证旧触发消息与新输入凭据恰好存在一个。保留 `change_proposals.ai_run_id` 的唯一性与任务历史外键。

## 权限

- PHP 从登录会话确定用户，不接受浏览器提交的 `userId` 或 `workspaceId` 作为授权依据。每次读取、发送、分页、订阅都检查当前成员关系及对话所有者；其他成员和管理员读取他人对话均返回 404。
- 提案摘要、条目、发起人及应用结果对当前项目成员可读，不返回消息正文。只有发起人能确认或拒绝；无权读取返回 404，成员读取后尝试处理他人提案返回 403。
- 成员被移除后，对话保留但不可见，其待确认提案按现有规则拒绝。重新加入后恢复读取自己的对话，不恢复已拒绝提案。
- 内部工具每次使用持久绑定的 `runId` 查询实际发起人、项目与当前权限。模型不能选择执行身份，也不能通过传入另一个项目 ID 或 run ID 扩大范围。
- 订阅期间至少每 15 秒重新校验登录会话、成员关系和归属；失效后关闭上下游流。工具读取、提交提案及确认始终独立校验当前权限，不能依赖连接建立时的结果。
- 提案写入和确认必须与成员移除使用一致的成员锁定顺序，避免“移除成员后又出现待确认提案”或越权应用。网络请求和模型执行期间不持有数据库事务。

## 浏览器接口

所有接口保持同源 `/api`，写请求沿用 `X-Weave-Request: 1` 和 Origin 校验。JSON 错误沿用 `{ message }`；时间使用 UTC ISO 字符串。UUID、输入字段和未知字段均做运行时校验。

### 读取当前对话

`GET /api/projects/:projectId/conversation` 返回 `{ conversation: null }`，或：

```json
{
  "conversation": {
    "id": "公开 UUID",
    "workspaceId": "工作空间 UUID",
    "projectId": "项目 UUID",
    "messages": [],
    "nextCursor": null,
    "run": null,
    "proposal": null
  }
}
```

`messages` 延续现有 `{ id, authorType, authorName, body, createdAt }`，按时间正序显示最近 50 条消息。`run` 为 null 或 `{ id, requestId, status, reply, message }`：`status` 为 `accepting`、`running`、`succeeded`、`failed`，`reply` 是完整的当前已提交回复文本，`message` 是可公开的失败说明或 null。运行中的部分回复不同时放进正式消息列表。

`proposal` 保持现有提案与条目字段。PHP 将 agent 快照与 PostgreSQL 提案组合后返回；不把两个存储的读取伪装成原子快照。提案状态可以晚于 agent 的通知，前端重新读取后收敛。agent 不可达时，对话读取返回 503，不伪装成空对话；已存在提案仍可独立读取与处理。

### 发送消息

`POST /api/projects/:projectId/conversation/messages` 接收：

```json
{ "requestId": "UUID", "body": "用户输入" }
```

正文 trim 后 1–8000 字，其他字段拒绝。首次发送可以幂等创建当前用户的项目对话，读取接口不自动创建空对话。

agent 持久接受后返回 HTTP 202：`{ conversationId, requestId, runId, status: "accepted" }`。重复请求返回同一接收凭据，即使执行已结束；当前执行结果通过读取接口恢复。同一 `requestId` 携带不同正文返回 409，不覆盖原输入。

同一对话暂不排队：不同请求在已有执行或待确认提案时返回 409。检查既在 PHP 的接收凭据中串行化，也在 agent admission 使用 `whenBusy: "reject"`；相同请求的重试先查重，再检查 busy。浏览器不得因 POST 超时就换一个 `requestId` 重发。

POST 的 15 秒传输期限只约束接收过程，不是生成期限。无论超时还是 502/503，都可能存在接收结果未知的情况，应使用同一 `requestId` 查询或重试。只有 agent 已持久接受，才能返回 `accepted`。

### 订阅与历史

`GET /api/conversations/:conversationId/events` 返回 SSE。首次及后续 `snapshot` 的 data 是 `{ conversationId, messages, nextCursor, run }`，消息字段同读取接口，最多最近 50 条。nextCursor 来自同一消息扫描，用于向前分页；不是事件回放游标。agent 只暴露 Weave 投影，隐藏原始 prompt、工具参数、内部文档、服务 token 和供应商错误。

前端按消息 ID 合并历史，按 `runId` 替换完整部分回复。`run.status` 为终态时重新读取 PHP 对话接口以获取提案，不能仅凭流文本显示“任务已创建”。PHP 的 run 另附 `syncStatus: "pending" | "complete"`，表示终态及提案结果是否完成对账；pending 时继续轮询，不可只读一次就停止。同步工作允许重试，只有确定提案保存成功或本次确实无提案，才显示 complete。重连再次发送最新快照，不发送 SSE `id`，不提供 `from` 参数或逐条重放保证。按 ADR 0004，旧 `Last-Event-ID` 被忽略。

每 15 秒发送 SSE 注释心跳；PHP 透传并关闭代理缓冲。浏览器离开页面只取消订阅，不能调用生成 abort。正常 EOF 或网络异常后先重新读取状态，执行仍在进行时按 1、2、4、8、15 秒上限退避重连；401 转登录，403/404 停止重连。鉴权失败发生在响应头发送前时返回 HTTP JSON 错误，响应头发送后关闭流，不能再改 HTTP 状态。

`GET /api/conversations/:conversationId/messages?cursor=...&limit=50` 返回 `{ messages, nextCursor }`，每页正序，游标向更早消息翻页，limit 为 1–100 的整数。第一次不带 cursor 返回最新一页；agent 捕获扫描上界，后续分页不混入新追加消息。游标是不透明、绑定对话和扫描顺序的令牌；错误、跨对话或跨扫描游标返回 400。这里的游标与 SSE 无关。

### 读取和处理提案

- `GET /api/proposals/:proposalId` 返回 `{ proposal }`，包含现有字段以及 `initiator: { id, name }`、`createdAt`、`resolvedAt`；不附带对话。用于项目成员查看任务来源。
- `POST /api/proposals/:proposalId/confirm`、`reject` 返回相同 `{ proposal }`。同一决定重复调用返回当前结果，相反决定返回 409。
- 确认对提案加行锁，在一个事务内创建任务、任务历史、条目关联并更新状态，失败全部回滚；重试不得重复分配任务编号或写入历史。重复请求的授权检查不能省略。
- 提案与条目沿用现有限制：summary 1–4000 字，1–8 个条目，title 1–200 字，description 和 acceptanceCriteria 各最多 20000 字，priority 为 low/normal/high。不接受负责人、状态、任意对象更新或 SQL；新任务固定 todo、未分配。

## PHP 与 agent 的内网接口

agent 所有路由（包括健康检查）都校验 `Authorization: Bearer AGENT_SERVICE_TOKEN`，不开放公网端口。PHP 固定调用配置中的 agent 地址，禁止跟随重定向。下面路径是内部契约，不由 nginx 暴露。

创建对话接收 `{ workspaceId, projectId, ownerId, importing }`，归属 UUID 一经绑定不可更换；importing 默认为 false，仅导入模式允许设为 true。输入接收正文为 `{ requestId, runId, admissionId, body, authorName }`，身份始终来自已绑定归属，authorName 只用于展示。封存 admission 接口接收 `{ requestId, runId }`，与已接收记录不一致返回 409；返回 `{ status: "closed" }` 或原接收凭据。接收凭据包含 conversationId、requestId、runId、submissionId 和 status: accepted。

导入标记只控制历史初始化，不是归属的一部分：已经封存的导入对话，在正常模式下用 importing: false 重试创建会返回原映射，不能重开导入或改归属。

| agent 接口                                                         | 用途                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `PUT /conversations/:conversationId`                               | 幂等创建映射，返回同一 `agentConversationId`；归属绑定不一致返回 409                 |
| `POST /conversations/:conversationId/inputs`                       | 接收 PHP 已绑定的 `requestId`、`runId`、`admissionId` 和正文，持久提交后返回接收凭据 |
| `GET /conversations/:conversationId/inputs/:requestId`             | 查询接收状态；不存在返回 404，用于处理响应丢失                                       |
| `PUT /conversations/:conversationId/admissions/:admissionId/close` | 持久封存未接收的 admission；已接收则返回原接收凭据，不撤销正在执行的输入             |
| `GET /conversations/:conversationId`                               | 获取 Weave 最新快照                                                                  |
| `GET /conversations/:conversationId/messages`                      | 使用受限 cursor/limit 查询可显示消息                                                 |
| `GET /conversations/:conversationId/events`                        | `watch()` 投影为 SSE 快照与心跳                                                      |
| `PUT /conversations/:conversationId/import`                        | 停写期间幂等导入历史，正常服务模式不可用                                             |
| `PUT /conversations/:conversationId/import/complete`               | 按消息总数和有序内容哈希核验并封存导入，不允许再追加历史                             |

agent 调 PHP 的 `/internal/agent/runs/:runId/` 路由：`GET context` 读取项目名称、最多各 40 条任务与文档摘要；`POST references` 按编号读取参考内容；`POST proposal` 提交待确认提案；`PUT outcome` 幂等同步终态、模型标识和经清理的错误说明。终态通知相同内容重试成功，不同终态拒绝，不得回退到 running。使用服务 token，独立于浏览器 cookie 与 CSRF 校验；nginx 显式拒绝 `/internal/`，只在容器网络可访问。模型不持有 token 或直接调用任意 URL。

模型供应商延续 Command Code 的 OpenAI-compatible 接口与现有 `CMD_API_KEY`、`CMD_MODEL` 配置，密钥从 legacy 移到 agent 环境变量，PHP 与前端不持有模型密钥。agent 未配置密钥时输入接收返回 503；健康检查不调用模型，也不能把模型配置缺失当作已接受生成。agent 只安装项目资料读取与提案提交工具，不安装 shell、文件写入或任意网络访问工具。

`references` 在执行所属工作空间内查询，保留跨项目编号引用能力；每次最多 6 条，单篇文档正文最多 12000 字。引用按不可信资料处理，不进入系统指令，未知或无权访问的编号只返回不可访问结果。

提交提案按 `runId` 唯一：PHP 比较规范化内容，相同内容重试返回同一提案，不同内容返回 409。先检查已有结果再拒绝执行已结束的请求，否则“提交已成功但响应丢失”的工具重试会失败。身份和当前成员权限始终先检查。

## 跨存储失败与恢复

不尝试在 PostgreSQL 与 SQLite 之间实现分布式事务，也不以 HTTP 响应成功代替持久接受。

1. PHP 在短事务内校验权限，串行检查同一对话的 busy/pending，创建 `accepting` 接收凭据和稳定 `runId`，记录规范化输入哈希；相同 requestId 复用原记录。
2. 事务提交后调用 agent，agent 将 run 与输入绑定并持久提交，再返回接收凭据。不能在数据库行锁里等待 agent。
3. PHP 更新映射与接收状态后返回 202。步骤 2 或 3 响应丢失时，通过 agent 的 requestId 查询找回同一 submission，再修复 PostgreSQL 凭据。
4. `accepting` 不能仅按超时标记为生成失败。恢复逻辑先查 agent；查询不可达时保留未知状态并返回 503。确定未接收时可将 admission 关闭，允许后续新请求，但旧 requestId 的后续重试仍须与新 admission 串行竞争，不允许迟到的旧请求绕过 busy 检查。
5. agent 的模型任务与提案工具都可在重启后再次执行。提案提交的稳定幂等键和 PostgreSQL 唯一约束兜住业务副作用；不得声称供应商模型调用恰好一次。
6. 工具提交提案成功但 agent 尚未持久记录结果时重启，重试返回原提案。确认仅依赖 PostgreSQL，即使 agent 停机也能处理已有提案。
7. agent 必须持久保存执行完成后的 PHP 审计同步工作，并重试直到成功；不能用进程内 fire-and-forget 回调更新 `ai_runs`。读取时可对账修复，但不能作为唯一恢复机制。不再使用旧的 70 秒自动失败规则。

读取也会修复 accepting 凭据：已接收时补上 submissionId；未查到时，只有 admission 的 15 秒接收窗口已过才能请求持久封存。过了时间本身不代表失败，agent 不可达或尚未确认封存时仍保持未知状态。重开一个已封存的未接收请求，会更新 admission 时间，并继续复用原 requestId / runId。

步骤 4 的迟到提交必须在实现中通过每次 admission 的持久 fencing 标识解决：PHP 关闭 admission 前让 agent 持久封存该标识，封存后的 inputs 拒绝接受；无法封存时保持 accepting，不开放第二个 admission。单纯“查到 404 再清 busy”存在竞态，不满足本契约。

## 旧数据导入与切换

迁移通过 PHP 的专用 CLI 和 agent 内网导入接口完成，不给 agent 增加数据库凭据。先在临时库和临时 SQLite 演练，再处理实际数据。

1. 先上线独立实现与新增数据库迁移，保持 nginx 的对话和提案仍指向 legacy。兼容迁移不得提前移除 legacy 所依赖的项目唯一约束；约束转换和私有归属切换放进停写窗口。
2. 停止全部 legacy 对话生成和提案写入，等待已有生成完成；无法完成的旧运行明确记为失败，不在 Pi Durable 重新执行。提案确认和拒绝也需停写，其他业务可继续使用。
3. 在停写后备份 PostgreSQL，并用 SQLite backup API 或停 agent 后复制数据库及必要 WAL；不能只复制运行中的 `.sqlite` 主文件。记录代码版本、迁移版本和导入批次。
4. 按 ADR 0001，将每条旧共享对话整体归 `created_by`，保留所有旧消息；其他发起人的待确认提案改为 rejected，已应用任务与历史不变。不复制整条旧讨论给每位参与者。
5. PHP 按 `(created_at, id)` 导出消息、作者、时间和旧 run 关联。agent 以不触发模型的历史写入导入，保存原消息 UUID 和实际作者元数据；模型上下文保留 user/assistant 角色。导入不能调用普通 input 去重新生成旧问题。
6. 每个批次接收 `{ batchId, offset, messages }`，最多 100 条；messages 包含旧 UUID、authorType、authorName、body、createdAt，顺序严格按 `(createdAt, id)`。以 `(conversationId, batchId, 内容哈希)` 去重，同批次同内容可重试，不同内容拒绝；offset 必须等于已导入数量，重复 UUID 拒绝。持久保存导入进度，完成前禁止该对话新输入。通过 Pi Durable 公共 Session/entry 写入接口实现，不直接插入其内部 SQLite 表。
   完成接口接收 `{ count, digest }`。digest 为有序消息的链式 SHA-256：初值是 64 个零，每条消息先按 `id, authorType, authorName, body, createdAt` 的字段顺序 JSON 序列化，再计算 `SHA256(上一摘要 + LF + 序列化消息)`（LF 是一个换行字节，不是反斜线和 n）。编码采用 UTF-8、紧凑 JSON，不转义斜线、中文和 Unicode 行分隔符；字符串中的换行等控制字符仍使用 JSON 转义。UUID 使用小写，时间为三位毫秒的 UTC ISO 字符串。数量、摘要均匹配才能封存；同一完成请求可重复执行。导入模式只允许导入和读取，不能接收新输入；切回正常模式后，仅已封存的导入对话能接收新输入，导入接口不可用。
7. 核验对话及消息数量、顺序、正文哈希、原 ID 和作者映射；核验提案与 run 的外键、任务来源和每个所有者的访问矩阵。全部完成后标记已导入，切换项目唯一约束。
8. 同一次发布切换前端响应契约及 nginx 对话、提案路由，关闭导入接口，再恢复写入。必须验证成员撤销、提案来源、刷新和重连。
9. 切换前可恢复原代理与备份回滚；切换并产生新数据后，不允许简单切回 legacy，因为新消息只存在 SQLite 且已承诺私有。此时先停写，保留两套存储备份并修复或设计反向迁移，不能丢弃新消息或恢复共享读取。

旧 PostgreSQL `messages` 与 `ai_runs` 先保留归档及外键，不随删除 legacy 目录一起删除。未来清理另加迁移，确认所有来源关联可追溯后再进行。

## 分阶段交付与验收

| 阶段 | 交付                                      | 必须通过的验收                                                                                         |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | 本契约与 ADR 0004                         | 数据归属、幂等、权限、重连和迁移失败路径明确                                                           |
| 2    | agent 内部接口、SQLite 持久对话与导入能力 | requestId 重试不重复；同 ID 不同内容拒绝；杀进程后恢复；watch 重连返回快照；无模型调用的导入可重复运行 |
| 3    | PHP 提案、内部工具与数据库兼容迁移        | 权限和字段校验；工具重试只保存一份提案；并发确认只创建一次；失败回滚；确认不依赖 agent                 |
| 4    | PHP 接收凭据、私有对话与 SSE 转发         | 接收前后崩溃和迟到请求恢复；断连只取消订阅；慢连接不阻塞其他请求；成员撤销关闭流                       |
| 5    | 前端适配、导入 CLI 与 nginx 切换          | 旧数据演练和权限矩阵；断网重连、刷新、重复发送、待确认提案和任务来源通过真实 HTTP 验证                 |
| 6    | legacy 移除、检查与部署文档               | 不运行 legacy 完成核心闭环；根目录 `pnpm check`；两套数据库备份恢复演练                                |

每阶段保持现有路由可用，尚未接通的接口不在 nginx 上提前切换。agent 测试使用临时 SQLite 和可控模型/工具替身覆盖重启及故障窗口，不依赖真实模型密钥。PHP 测试延用真实进程、临时 PostgreSQL schema，新增可控 agent fixture；最终再验证真实 nginx 链路的 SSE 缓冲和断连行为。

删除 legacy 前必须迁走 `scripts/migrate.mjs`、HTTP 契约验证脚本和仍有价值的业务测试，更新 compose 的 migrate 镜像、根目录脚本、CI 与锁文件。不能因删除目录而丢掉迁移或测试能力。

## 实现进度

- 第 1 阶段：契约与 ADR 已完成，[review 及修复](reviews/conversation-migration-stage-1.md)已记录。
- 第 2 阶段：agent 内部接口、持久输入接收、恢复、SSE 快照、历史导入与分页已实现，[code review 及修复](reviews/conversation-migration-stage-2.md)已记录。通过 `pnpm --filter weave-agent test` 运行真实进程集成测试；不需要 PostgreSQL 或真实模型密钥。
- 第 3 阶段：PHP 提案读取/确认/拒绝、内部资料读取与提案提交、agent 业务工具及兼容数据库迁移已实现，[code review 及修复](reviews/conversation-migration-stage-3.md)已记录。迁移 `011` 保留 legacy 的项目唯一约束和旧触发消息写法；新执行使用 `conversation_inputs` 关联。内部工具只接受新持久输入的执行，旧 legacy 执行不可调用。
- 第 4 阶段：PHP 对话读取、持久接收协调、历史分页与 SSE 转发已实现；agent 使用持久任务回写终态，PHP 返回 syncStatus 表示对账完成与否。[code review 及修复](reviews/conversation-migration-stage-4.md)已记录。新增迁移 `012` 保存同步时间，`013` 保存每次接收尝试的恢复窗口；仍保留 legacy 的项目唯一约束，未切换浏览器流量。
- 第 5–6 阶段：尚未实现。需要在停写导入后原子切换项目唯一约束、前端契约和 nginx 路由，再清理 legacy。

agent 默认 `AGENT_MODE=serve`，导入时需要独占 SQLite 卷并以 `AGENT_MODE=import` 启动。导入模式不执行已挂起任务，也不发起模型请求。必须先停止正常 agent，再启动导入实例，导入并封存完成后退出导入实例，最后启动正常 agent。不能让两个实例同时打开同一存储；本阶段提供内网导入接口，实际 PostgreSQL 导出 CLI 在第 5 阶段实现。

agent 设置 `AGENT_API_URL` 为实际 PHP 内网监听的 http(s) origin 后启用三个业务工具；compose 已配置为 `http://api:8080`。不配置时只讨论需求。服务端只安装项目摘要读取、编号引用读取和待确认提案提交，不安装 shell 或任意网络工具。`AGENT_API_URL` 不能指向 nginx 的公开入口，nginx 会拒绝内部路径。
