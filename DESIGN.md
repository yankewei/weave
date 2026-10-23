# Weave UI 设计约束

## 基础

项目使用官方 shadcn/ui Nova 样式，底层为 Base UI，CSS 使用 Tailwind v4，图标为 Lucide。配置入口为 `components.json`。UI 源码位于 `components/ui`，别名使用 `@/`。

以 AI 对话推动项目为主线：讨论需求 → 预览提案 → 用户确认 → 正式文档与任务。内容编辑、差异和历史为这条主线服务，不能把产品首页做成普通文档工具。沿用 Nova 的中性主题、控件高度、圆角、边框与焦点反馈，不在页面另建一套视觉皮肤。

## Token

所有全局主题变量集中在 `app/globals.css`，由 `@theme inline` 映射为 Tailwind 工具类。

| 用途           | Token                                  |
| -------------- | -------------------------------------- |
| 页面与正文     | background / foreground                |
| 次要表面与说明 | muted / muted-foreground               |
| 主操作         | primary / primary-foreground           |
| 卡片与浮层     | card、popover 及对应 foreground        |
| 边界与焦点     | border / input / ring                  |
| 错误           | destructive                            |
| 项目导航       | sidebar 系列                           |
| 差异新增       | diff-added / diff-added-foreground     |
| 差异删除       | diff-removed / diff-removed-foreground |

差异色只表达内容的增加与删除，不用作品牌装饰。亮色与暗色均在主题中定义，页面不写单独的 dark 颜色覆盖。正文使用本地打包的 Geist Variable 与中文系统字体回退。字号和字重沿用官方组件；自有标题使用有限的 text-sm/text-lg/text-3xl 层级。

## 页面结构

- 登录：首页明确 AI 驱动的项目协作定位、提案与确认边界及实际接入状态；说明区与表单卡片；小屏纵向排列。CardHeader 表达任务，CardContent 放 FieldGroup，CardFooter 放主要操作。
- 工作空间：项目首页是工作台，内容区按页面滚动。顶部是问候与概况（等我确认的提案数、本项目进行中的任务数）。下面左侧是项目对话，放在 Card 里，宽屏占剩余宽度、高度不超过一屏；没有消息时是大输入框和三张可直接发送的起点卡片，有消息后记录在上、输入框在下，已确认的任务显示为产出卡片，可打开看板。对话右侧固定 20rem，用两张 Card 列出本项目的进行中与待办，ToggleGroup 切换全部或只看我的，只读，修改仍在看板；确认或拒绝提案后立即刷新。小屏时任务列在对话下方。再往下是整个工作空间的概况：项目卡片（各状态任务数、文档数、我待确认的提案数）、最近文档和最近动态（任务与文档的变更历史），无数据时用 Empty。没有项目时，首页是大输入框，第一句话创建项目并开始这次对话。顶部固定高度工具栏、左侧 Sidebar 同时展示 AI 与项目文档导航。顶部和侧栏「设置」打开 `/workspaces/工作空间/settings`。这一页分成两组，标题分别是工作空间名称和当前账号名称。工作空间一组用 Card 管理成员和这个工作空间的存储：成员列出姓名、邮箱和角色，管理员邀请已注册邮箱，移除和退出前用 AlertDialog 确认。存储可以保存工作空间自己的配置，或改用当前管理员账号上的个人存储；改掉已有的工作空间密钥前用 AlertDialog 确认。账号一组用 Card 保存当前账号的服务地址、区域、桶、可选目录和访问密钥。密钥保存后不再显示。地址可以打开工作空间、设置、项目、任务看板和文档。看板和文档页可以从右侧打开同一条对话，宽度不超过 24rem，缩小后保留悬浮按钮，回复流式出现，不写进地址。文档提案未接入时，起点卡片只承诺拆出待确认任务，不能伪造已写入的文档。
- 看板：占满内容区剩余高度。三个固定状态列宽屏均分、列内滚动，小屏横向滚动。列头显示数量和新建。任务卡片使用 Card，只放编号、标题、描述或验收、优先级和负责人；详情使用 Sheet + FieldGroup。优先级用 ToggleGroup 筛选。提供独立拖拽手柄与详情状态选择，保存失败保留原状态，版本冲突保留草稿。
- 文档：编辑与版本历史在宽屏并列；不足 1280px 时历史在编辑区下方。小屏导航由 Sidebar 自带 Sheet 展开。
- 创建项目或文档：Dialog 内完成一个任务，必须提供 Title 与 Description；执行期间禁用重复操作。
- 恢复、放弃草稿与退出：AlertDialog 说明影响，取消不会发出修改请求。

## 组件映射

| 场景                 | 必须优先使用                                                      |
| -------------------- | ----------------------------------------------------------------- |
| 操作                 | Button 内置 variant、size，异步时 Spinner + disabled              |
| 表单                 | FieldGroup → Field → FieldLabel + Input / Textarea / NativeSelect |
| 导航                 | SidebarGroup → SidebarMenu → SidebarMenuItem → SidebarMenuButton  |
| 历史版本选择         | 单选 ToggleGroup，Base UI 数组 value                              |
| 确认                 | AlertDialog / useConfirmation                                     |
| 创建对象             | Dialog + FieldGroup                                               |
| 错误、冲突、保存结果 | Alert；保存结果使用 role=status                                   |
| 首次使用与无数据     | Empty 完整组合                                                    |
| 版本号与格式         | Badge                                                             |
| 分隔与加载           | Separator / Skeleton / Spinner                                    |

## 禁止事项

- 禁止原生 window.confirm 和业务页面直接使用 button/input/textarea/select，ESLint 会阻止这些写法。
- 禁止给每个页面另建按钮、卡片、提示的 CSS 皮肤。
- 禁止使用字符代替图标、用颜色作为唯一的差异标识、隐藏移动端全部导航。
- 禁止为满足设计而丢弃草稿、跳过版本检查或把失败显示为保存成功。

## 本地上游差异

官方组件仅做必要的中文可访问文案调整；移动断点 hook 使用 useSyncExternalStore 订阅 matchMedia，兼容严格 React lint。刷新规则只对白名单中的官方 variants 与 useSidebar 导出例外，其他检查仍然启用。
