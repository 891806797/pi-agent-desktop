# 顶部会话统计

按用户要求与 pi 1.4.0 TUI footer 保持统计口径一致，在顶栏右侧呈现上下文占比、输入 Token、输出 Token、缓存命中率。

- 输入/输出：SDK getSessionStats() 的累计 input/output，覆盖全部持久化条目（包括压缩前消息和摘要请求）；input 是未缓存输入，不合并 cacheRead/cacheWrite。
- 缓存命中率：最后一条 assistant 消息的 cacheRead / (input + cacheRead + cacheWrite)，与 TUI 相同。分母为零或尚无响应时未知，不能回退到上一条或改成累计比值。
- 上下文：SDK getContextUsage()，压缩后未知时保留 null，不能显示 0%。不按页面现存消息重新估算。

实现步骤：

- [x] common 定义 SessionMetrics、快照字段和 session_metrics SSE；后端 agent 模块统一读取 SDK，不新增路由或存储。
- [x] SDK 消息落盘后、模型切换、压缩结束等边界广播完整统计；微任务合并更新，避免逐 token 扫描历史或在持久化前读少一条。
- [x] store 原子应用快照及统计事件，切换会话清空旧统计；顶栏使用紧凑文字、细上下文条及可访问说明，窄屏换行不遮挡输入。
- [x] 验证 TUI 同口径累计/最近响应、压缩未知与恢复、多页同步、重复事件和切页清理；运行类型/Lint/相关测试及编译版浏览器尺寸验收。

边界：无额外费用、设置、图表或扩展 UI；不将流式未报告的 usage 伪造为实时精确计数。

结果：后端 103 项、前端 37 项测试通过，类型检查、Lint、前端构建、Windows 编译通过。真实 Chromium 验证三个页面的 Token/缓存率同步、手动压缩中多次摘要请求累计、压缩后显示“待更新”、刷新不丢统计、下一响应更新估算及窄屏布局。独立复审未发现 P1/P2。
