# pi TUI 到 Web 的对接评审

本轮以 `prompt.md` 的多人 Web 协作为验收范围，逐项对照本地 `参考项目/pi-1.4.0` 的 TUI、SDK 与 RPC 实现。目标是复用 pi 的执行语义，用 Web 控件表达，而不是继续模拟 Claude Agent SDK 的消息协议。此表区分已闭环的产品能力和尚未实现的 TUI 能力，不代表完整 TUI 扩展兼容。

## 正向流程与职责

1. 用户从 URL 指定的项目/会话进入；后端校验属主与工作区，创建或恢复对应 SDK 实例。
2. 页面先获取同一序号下的消息、审批、队列与配置快照，再接收后续 SSE。切页只切连接和渲染状态，后台运行继续。
3. 用户发送文字、文件引用或图片。SDK 接受后清理该份草稿；失败保留。发送模式默认 followUp 排队，也可切换为 steer 直接发送；停止按钮独立控制中断。
4. SDK 的文字、思考、工具参数与结果投影到 common；store 累积同一契约，组件直接展示，不再经过 mapMessage/mapApproval 或工具别名转换。
5. 工具权限与提问统一由服务端挂起并计时。一页结算后广播所有页；返回会话从快照恢复剩余请求及原截止时间。
6. 完成、错误、中断、输出长度限制均产生明确终态；刷新后的历史与实时展示保持同类内容。

后端只负责执行、授权、身份、快照和事件；前端负责交互及展示。前端折叠状态属于页面，SDK 队列、消息和挂起请求属于会话。不会为了对齐终端交互另建一套 Agent 执行状态机。

## TUI 元素对照

| pi TUI 行为/元素 | Web 表达与当前状态 | 对照依据 |
| --- | --- | --- |
| 用户消息、图片输入 | 原文气泡保留换行；用户图片实时与历史都保留。图片 MIME 从实际 Data URL 恢复，不把 JPEG/WebP/GIF 标成 PNG | `interactive/components/user-message.ts`；Web `dom.ts`、`history.ts`、`UserBubble` |
| 助手文本和思考的顺序 | 直接按 common blocks 顺序渲染；助手正文使用 Markdown，思考可折叠，流式阶段可跟随 | `interactive/components/assistant-message.ts`；Web `ContentBlockView` |
| 工具参数持续更新 | 保留原始工具名与流式参数文本；未完成 JSON 也能展开查看，不等待完整解析 | `interactive/components/tool-execution.ts` 的 updateArgs；Web `ToolCallBlock` |
| 工具部分输出和最终输出 | 同一块由 partial 更新至 final；普通文本使用 pre 保留换行/缩进，JSON 对象可格式化，长结果渐进展开并完整滚动，不再把源文本当 Markdown | `tool-execution.ts` 的 updateResult；Web `ToolResultRenderer`、`Foldable` |
| 工具图片、diff 和结构详情 | 图片独立显示；SDK details 中的 diff 或其他结构化详情按需展开；没有假定工具前缀/XML 元数据 | `tool-execution.ts`；Web `ToolCallBlock` |
| 错误、中断、输出截断 | 助手消息显示原因和 length 提示，未完成工具退出运行态；错误和系统文本保留换行 | `assistant-message.ts` 的 stopReason；Web `AssistantBubble`、store、history |
| 自动压缩与手动压缩 | 进行中有状态；成功显示摘要及已知 token，失败/取消不显示成功分隔线；`/compact` 走 SDK compact | `InteractiveMode.handleEvent` 的 compaction 分支；Web translator、service、`CompactionDivider` |
| 自动重试与摘要重试 | 投影重试过程和最终错误，避免将重试误判成完成；当前界面以运行状态及文字反馈表达，没有单独重试时间轴 | `InteractiveMode.handleEvent` 的 retry 分支；Web translator、store |
| 输入队列、steer/followUp | 思考强度右侧选择排队/直接，默认 followUp；待发送卡片贴合输入框上沿，每项仅直接发送和删除。直接发送走 steer，不重复列为待发任务，失败后保留未消费输入操作入口；切入发生在 SDK 允许的边界 | TUI pendingMessages、SDK queue_update；Web `QueueBar`、PromptInput、queue-operations |
| 停止 | 中止当前运行并结算挂起交互；停止后发送保留其他队列项和附件 | SDK abort；Web queue-dispatch 测试 |
| 模型、思考强度 | 模型身份仅取每用户 models.json 声明，按 JSON 顺序，未选择默认首项；显示 provider · modelId，无模型时明确提示。空白页与活会话都可选，思考档位取 SDK 原生能力，reasoning 由人工配置；选择存 SQLite，重开回填，首条发送先应用最新选择，已发出的请求不变 | TUI model/thinking selector；Web model-config、model.service、default-settings、session mutation |
| 运行模式、工具授权 | pi 无内置四档模式，Web 通过 tool_call 扩展实施；不伪造为 SDK 原生 mode。审批等待期间切模式也重新检查 | SDK extensions/types.ts ToolCallEvent；Web ext-run-mode-gate |
| select/confirm/input | 以共享审批 dock 展示，取消、中断、超时和多页结算统一处理 | ExtensionUIContext、官方 RPC createExtensionUIContext；Web ui-context |
| notify/status/working/widget | 类型化通知、按 key 替换和删除的状态/文字块、输入区上/下位置、working 文案及可见性；快照可恢复，文本保留换行、去除终端控制码，容量有上限 | ExtensionUIContext、InteractiveMode；Web SessionUI、ExtensionPanel |
| editor | 独立长文本模态框，各页草稿独立，一页提交/取消全页关闭；重启无法恢复旧调用栈时明确中断而非假装续栈 | ExtensionUIContext.editor；Web SessionUI、ApprovalManager、PermissionRequest |
| 会话选择与整理 | 侧栏搜索名称/首条摘要、分页、SDK 重命名、归档和删除；多页同步，空会话重启可打开，删除失败可重试 | SDK SessionManager；Web SessionCatalog、SidebarPanel |
| 后台运行与失败恢复 | 跨项目摘要、待处理与未读；持久化失败说明和允许动作，显式继续/重试/放弃，actionId 防重复接受 | SDK AgentSession + 既有恢复检查点；Web SessionRecovery、UserEventHub、RecoveryNotice |
| AskUserQuestion | 由白名单 ask_user_question 工具提供 Web 多题卡片，支持选项、补充和必答；五分钟每题默认“请自主决策”。它不是 pi 内置的 Claude 同名工具 | Web ext-ask-question、approval-manager、PermissionRequest |
| `/` 命令补全 | 空白页和活会话均提供已接入的 `/new`、`/compact`；会话建立后聚合真实 prompt/skill/扩展命令。选择仅插入草稿，保留补参数机会；不展示无实现的 Claude 命令别名 | TUI autocomplete、SDK getCommands；common BUILTIN_SLASH_COMMANDS、Web commands.ts |
| 新建、恢复和项目切换 | 侧栏和 URL 替代终端选择器；项目切换选首条可见会话，无会话时首条发送创建并选中；`/new` 保留同项目新草稿，不终止后台任务，过期创建或导航响应不能抢回页面 | TUI new/session selector；Web ChatPage、SessionConnection、sendToSession |
| 文件引用和附件 | `@` 与文件菜单选择当前项目文件；服务端验证路径边界。文字附件/图片按现有编辑器流程发送 | TUI autocomplete/editor；Web PromptInput、modules/system |
| Footer 的基本状态与用量 | 顶栏显示上下文占比、会话累计未缓存输入/输出 Token、最近一次助手响应的缓存命中率；与 TUI 相同。统计取 SDK 全部条目及 getContextUsage，不对压缩后的页面消息求和；消息下仍标注本次响应 | TUI footer.ts；Web session-metrics、SessionMetricsBar、ChatPage |
| 键盘及窄屏 | 折叠控件为有 aria-expanded 的按钮，支持 Enter 和可见焦点；窄屏用模态导航，跨桌面断点自动关闭以释放遮罩和焦点 | Web ui-ux-pro-max 交互检查与浏览器验收 |

表中 pi 源码路径相对 `参考项目/pi-1.4.0/packages/coding-agent/src/modes/`，SDK 核心定义位于该项目 `packages/coding-agent/src/core/`。Web 源码以仓库中的实际符号为准。

## 未实现及明确边界

- 任意扩展 UI 宿主仍不完整：声明式 notify、setStatus、文字 widget、editor 已接入；getEditorText 涉及各页独立草稿，尚未定义单一全局编辑器。磁盘扩展保持禁用，不能据此宣称任意 pi 扩展可直接使用。
- 任意终端 Component factory、自定义 header/footer/editor、终端输入钩子、ANSI/终端图片协议不能直接在浏览器执行；需要对应 Web 扩展协议，当前没有提供。
- 自定义显示消息已有历史与实时文本投影（含重启恢复提示），按消息身份去重；尚不支持扩展自定义 renderer，不能据此认定任意扩展 UI 已兼容。
- TUI 的树形分支/fork/rewind、分享/导出、终端 `!`/`!!` Shell 快捷入口、OAuth 交互和完整设置菜单未移植。Web 只展示已实现命令；模型 Provider 配置走现有设置 API。
- 上下文占比已使用 TUI 同源估算，压缩后未知时显示“待更新”；顶部累计 Token 包含压缩等请求。跨压缩/分支的会话累计费用和 cache warm 状态尚未呈现，消息下“本次响应”仍只表示该次 token。
- 单实例已支持 SQLite 检查点恢复：模型轮次重新请求，审批/Ask 重建原身份和剩余期限；停机时间计入五分钟。已完成工具不重跑，未知副作用暂停确认后继续。旧网络连接和 Promise 不复活；不支持多实例协同运行。

这些边界不会用空按钮、人设/子代理占位或伪回滚掩盖。它们不是本轮已完成的功能；若将范围扩大为完整 TUI/扩展兼容，需要分别补齐协议与验收。

## 本轮验证

- 后端 149 项、前端 54 项测试通过。在既有恢复、审批、同文异图和渲染验证上，增加目录管理、删除失败/重启清理、幂等恢复与崩溃窗口、暂停队列及扩展声明式展示验证。详细证据见 `docs/superpowers/plans/2026-11-01-agent-foundation-progress.md`。
- 三包 typecheck、Biome、Drizzle 迁移检查、Vite 构建、Windows 单文件编译通过。Vite 仍提示主 JS 大于 500 kB，当前约 896 kB（gzip 279 kB），未扩大为拆包优化。
- 编译版真实 Chromium 验收：登录、三标签页共享事件、后台审批重放、权限及提问强制重启恢复原卡片、任一页结算全页清卡、思考中切页、发送模式、队列直接发送/删除和同步、命令、工具换行及完整尾部、键盘展开、390px 导航、顶部统计、压缩与刷新；新增管理操作跨页同步及失败重启后显式继续。隔离扩展夹具验证两页 editor 提交/取消、独立草稿、换行和刷新快照。
- 浏览器与 HTTP 测试只使用临时工作区和本机模拟 Provider，不读取开发凭据；五分钟规则由可控时钟测试，不在浏览器实际等待五分钟。未验证外部 Provider 或非 Windows 可执行文件。
