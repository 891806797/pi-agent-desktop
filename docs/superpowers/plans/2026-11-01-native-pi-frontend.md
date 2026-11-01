# pi Web 前端直接契约重构

> 执行方式：superpowers:executing-plans，完成后独立整体验证。

**目标：** 保留现有视觉和有效功能，删除 gzh 业务兼容负担，让组件直接消费 common 的 pi Web 契约。

**范围：** 前端类型、聊天/工具/审批渲染、输入与对应测试；按用户后续要求对照 pi TUI 并使用 ui-ux-pro-max 优化正向交互。补齐用户图片投影、length 终态和已支持原生命令，保留 SDK 执行、会话事务、五分钟超时语义；不新增账号、子代理、人设或回滚功能。

**结构：** pi SDK → 后端投影/common → store → UI。前端局部类型仅保留实际使用的动作接口和编辑器附件，不再复制消息/提问/审批协议。

## 已定位的旧结构

- `lib/agent-types.ts`：第二套消息、审批、人设、子代理、回滚接口。
- `hooks/useChatAgentApi.ts`：mapMessage/mapApproval 及 persona、rewind、checkpoint 等占位。
- `ChatMessageList.tsx`：Task/Agent/团队活动渲染、XML 特判与没有后端实现的回滚按钮。
- `chat-input/PromptInput.tsx`：人设弹窗/状态/键盘逻辑及旧命令别名假设。
- `stores/chat.ts`：没有生产者的子代理状态。
- `tool-results/gzh/`：五个 gzh 专用文件；结果路由及 XML 解析也包含旧框架协议。

## 实施与验证

- [x] 建立直接 common 消费的渲染验证：模型文本/用户 XML 原文不被隐藏，工具状态、压缩摘要、审批 payload 和 deadline 保留。
- [x] 精简前端动作接口和输入：删除人设/回滚/子代理占位，保留会话坐标与发送守卫。
- [x] 消息与工具直接渲染 common.ChatMessage/AssistantBlock，删除旧 XML、Task 和 gzh 工具专属协议。
- [x] 审批直接使用 PendingRequest 与 allow/deny/answer/cancel，保留多题、备注、必答与超时展示；删除布尔动作转换。
- [x] 对照 TUI 补 length 提示、工具详情/图片/原文参数、空白页命令和单次用量；图片 MIME 与实际格式一致。
- [x] 工具输出保留换行/缩进，长结果完整滚动；审批完整内容可查看，错误与说明保留换行。为折叠提供键盘和状态语义，窄屏导航不挤占输入区，跨断点释放模态层。
- [x] 执行前端/后端测试、类型检查、Lint、构建和编译版三标签页浏览器验收；独立复审并同步架构说明。

边界重点：普通文本看起来像旧 XML 标签时仍完整显示；SDK 工具名保持原值且特化结果正确选中；同页首条创建和切页旧回调仍安全；超时/并发审批不因移除映射层改变语义。删除前基线已保存在系统临时目录 `pi-agent-native-ui-baseline-20261101`，不触碰开发数据与 Provider 配置。

结果：后端 101 项、前端 34 项测试通过，typecheck、Biome、Vite、Windows 编译及真实 Chromium 验收通过；独立复审未发现未修复的 P1/P2。本轮删除 12 个旧适配或多余转发文件。TUI 对照、验证边界和未实现能力见 `docs/pi-tui-web-coverage.md`。
