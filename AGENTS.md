# Weave 前端约束

## UI 来源与设计

- 所有 UI 工作必须先阅读仓库内的 `.agents/skills/shadcn/SKILL.md`，并遵守 `DESIGN.md`。
- 在仓库根目录执行 `pnpm dlx shadcn@latest info --json` 获取真实配置。当前使用 Nova、Base UI、Tailwind v4、Lucide；不要混用 Radix 的 `asChild` 或单值 ToggleGroup API。
- 优先组合已安装的 `components/ui` 组件。新增组件前执行 `shadcn docs <component>` 并读取文档，再通过官方 `@shadcn` registry 添加。
- 不重复实现按钮、输入框、弹窗、提示、空状态、导航和加载状态。不得使用 `window.confirm`；复用 `useConfirmation` 与 AlertDialog。
- 表单使用 FieldGroup、Field、FieldLabel 和官方控件，关联 label/id。错误与禁用状态同时设置在 Field 和控件上。
- 组件 `className` 用于布局；外观优先使用组件 variant/size。禁止在页面覆盖组件颜色、字体、圆角与阴影。
- 所有颜色使用 `app/globals.css` 中的语义 token；差异使用 diff-added/diff-removed，禁止散落十六进制或具体彩色 Tailwind 类。
- 条件类使用 cn；间距使用 gap；图标来自 Lucide，Button 内用 data-icon，不手动调整图标尺寸。
- 保留键盘操作、焦点管理、移动端 Sidebar/Sheet 与 reduced-motion 支持。

## 代码与检查

- 遵守项目禁止无意义封装的要求。仅为复用逻辑、稳定领域语义或复杂约束建立抽象，不包装一两行字段转发。
- 上游组件源码由项目维护；更新先使用 CLI 的 --dry-run/--diff，保留本地中文文案与移动端订阅修正。官方组件附带的 variants 和 message scroller hooks 写在 ESLint 刷新白名单里。
- 根目录 `pnpm check` 必须通过。业务页面不得通过关闭 lint 规则绕过 shadcn 控件约束。
