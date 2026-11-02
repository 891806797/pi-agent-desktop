# Tauri 桌面端设计（已由会话中的实施指令确认）

目标：复用现有 Pi 1.5、React、Bun/Elysia、SQLite，首版支持 Windows x64、macOS arm64/x64、Linux x64；GitHub 公开仓库 891806797/pi-agent-desktop 提供 Release 下载，保留 Gitee。

架构：Tauri 内嵌 frontend/dist，以稳定应用来源运行。Rust 只管理 sidecar、受限 HTTP/SSE 转发和系统能力。现有后端仍独占业务/SQLite；Web 模式继续直连原有接口。HTTP-only cookie 的桌面会话由 Rust 维护，凭据仅存系统凭据库。每次启动的 sidecar 连接凭据不暴露给页面。

生命周期：本地随机端口，ready 握手包含版本和协议；就绪前请求等待，失败明确重试。重复启动聚焦原窗口。退出先保存/abort/回收，超时强制清理整个受管进程树；Windows Job Object，Unix 进程组及后代进程收尾。父进程异常断开触发 sidecar 收尾。后台运行必须有可返回的托盘/Dock/窗口入口。

提醒：AskUserQuestion/权限审批请求系统闪烁并显示通知；AgentLoop 完成请求提醒并展示绿色完成点。使用现有用户摘要事件与 noticeVersion 聚合去重，点击定位会话，处理/阅读后清除。状态图标提供有底色的待处理标识和绿色完成标识；系统闪烁动画遵循平台能力。无系统通知权限时状态图标与应用内消息仍可用。

发布：标签触发检查、四目标构建、真实打包产物冒烟、签名/公证（配置凭据时）、SHA256、Release 草稿上传，全部目标成功后发布。无签名凭据的初版以明确标注的预发布提供，不能冒称已公证。首版不含应用内自动更新。

边界：无旧数据导入/兼容层；不内置开发账号或真实模型密钥；安装目录只读，DATA_DIR 位于 appLocalDataDir；不将任意外部页面授权为 Tauri 页面。只允许向该次 sidecar 的 /api 路径转发，不允许前端控制 host、Cookie、连接密钥或任意命令。

用户追加确认：点击窗口×关闭后继续在托盘后台运行；只有明确“退出应用”结束所有受管进程。Linux 无可用托盘时保留最小化窗口入口，不允许完全隐藏后无法返回。
