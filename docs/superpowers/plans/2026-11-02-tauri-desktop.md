# Tauri Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox tracking.

**Goal:** 构建三端可安装客户端及 GitHub Release 下载闭环。
**Architecture:** React 静态资源由 Tauri 内嵌；Rust 受限桥接本机 sidecar 的现有 HTTP/SSE；Bun 后端继续拥有全部业务和持久化。
**Tech Stack:** 最新稳定 Tauri 2、Rust、Bun、React、GitHub Actions。
**Spec:** docs/superpowers/specs/2026-11-02-tauri-desktop-design.md

## Global Constraints
- 保留 Pi 1.5 原生接口、三包业务职责，增加 packages/desktop；无旧版兼容。
- 新 JS 依赖只用 Bun @latest 安装，Rust 使用 cargo add 解析最新稳定版；CI 锁定 bun.lock/Cargo.lock。
- 工作区 C:/Users/G16 7630/.codex/worktrees/tauri-desktop/pi-agent，分支 codex/tauri-desktop；不覆盖原项目用户改动。
- 受限连接使用 x-pi-desktop-token；前端不可传该 header。PI_DESKTOP_TOKEN 存在即桌面模式。
- ready 帧：{type:"ready",protocol:1,url:string,version:string}；stdin 控制帧 {type:"shutdown"}，EOF 也关闭。
- Rust IPC backend_request 参数 request:{path,method,headers?,body?}，返回 {status,body:string}；仅 JSON API。
- backend_subscribe 参数 {id:string,path:string,onEvent:Channel<DesktopStreamFrame>}；backend_unsubscribe 参数 {id:string}。帧 {name,data?:string,lastEventId?:string}；open/error 也用 name。
- backend_status 返回 {status:"starting"|"ready"|"failed"|"stopping",error?:string}；backend_restart 仅失败/停止后可用，启动幂等。
- 通知导航：Rust emit desktop:navigate payload {workspace:string,sessionId:string}，workspace 是实际路径，前端用现有编码规则生成 URL；只能原应用窗口。
- 不在子任务各自 git commit，所有完成验证和审查后由主代理整体验证、提交、推送（用户已要求 GitHub 分发）。

## Review Focus
- 无票据/错误票据的本地请求不得读写任何 API；IPC 不能变成任意 URL/命令代理。
- SSE 分片、多行 data、断开、取消和重启不得丢序、串会话、泄露旧账号；订阅需可回收。
- 审批/完成重放不重复通知，处理一个会话不能清除其他会话提醒。
- 正常退出及主进程异常退出必须清理工具后代进程并 wait/reap，退出不能挂住。
- 安装后无源码/node_modules/开发 .env 也能运行，图片 WASM/worker、中文路径必须验证。

### Task 1: 后端桌面宿主与认证边界
Files: backend/src/index.ts, env.ts, modules/system/desktop-host.ts, routes/desktop.middleware.ts, modules/auth/token.ts, users.ts, backend/test/desktop-host.test.ts, probes/desktop-host.ts.
Consumes: PI_DESKTOP_TOKEN、DATA_DIR、控制管道。
Produces: 受保护的既有 API、ready/退出协议、SQLite 持久化 JWT 密钥；Web 启动日志不变。
- [ ] 写并实际运行失败测试：ready、拒绝错误连接、无开发 seed、EOF/shutdown 退出、JWT 重启稳定且无 cwd .env 写入。
- [ ] 以现有启动入口闭环实现，token 校验用标准 crypto timingSafeEqual；关闭幂等并有上限。
- [ ] 跑 focused tests 及受影响 auth/restart 集成测试，审查后标记完成。

### Task 2: Tauri Rust 宿主与提醒
Files: packages/desktop/package.json, src-tauri/Cargo.toml/build.rs/tauri.conf.json/capabilities, src/{lib,sidecar,transport,attention}.rs, icons。
Consumes: Task1 ready 与受限 API；现有 /api/sessions、/api/user/events、readVersion/noticeVersion。
Produces: Global Constraints 的 IPC，桌面单实例/后台入口/完整退出、系统通知/状态图标、可测试的 SSE parser 与提醒决策。
- [ ] 先运行失败的路径限制/SSE parser/通知去重及聚合单测；启动和清理用实际子进程测试。
- [ ] 用 Tauri Channel、Rust HTTP client + cookie jar、系统凭据库；请求仅允许固定 sidecar 和 /api，禁止重定向。
- [ ] 启动/失败/重启/退出并发有单一状态；Windows Job Object 持有所有后代，Unix process group + 后代清理；掉父连接也触发收尾。
- [ ] 真正后台用户摘要订阅独立于 WebView，读取/处理清理对应通知，完成绿点和待处理优先级。
- [ ] cargo fmt/clippy/test/build 并跑真实 Windows 宿主，审查后完成。

### Task 3: 前端桌面传输与启动交互（主代理）
Files: frontend/src/lib/desktop.ts, api.ts, shared-event-source.ts, main.tsx, App.tsx, frontend/test/desktop-transport.test.ts.
Consumes: Task2 IPC/Channel；现有 APIResult 和 EventSourceTransport。
Produces: 同一页面在 Web/desktop 的 HTTP 与事件传输，启动失败可重试，通知定位。
- [ ] 先确认失败：状态等待/失败、HTTP 状态保留、关闭前异步订阅竞态、SSE error/resync、旧 Channel 回调失效。
- [ ] 只在两个公共传输入口选环境；复用现有页面和 seq/epoch，不逐个路由分叉。
- [ ] 桌面启动/崩溃状态可视反馈，使用既有控件和主题，通知定位不重复请求。
- [ ] 前端单测/类型/lint/构建和既有浏览器验收通过，审查后完成。

### Task 4: 三端构建与 GitHub Release
Files: desktop/scripts/{prepare,verify-release}.ts, root package scripts, backend/scripts/build.ts, .github/workflows/{ci,release}.yml, docs/desktop.md, .gitignore.
Consumes: src-tauri 工程与 backend/src/index.ts；sidecar 名称 pi-agent-sidecar-<Rust target>[.exe]。
Produces: bun run desktop:prepare / desktop:dev / desktop:build，四目标安装包与 SHA256 Release。
- [ ] 先确认 target 映射/版本一致性/缺失资源检查失败，修正现有 process.arch 宿主判断。
- [ ] 脚本只使用 bun、路径标准库；桌面 sidecar 不重复内嵌前端，内嵌同一 Drizzle 迁移，打包所需 WASM/worker；禁用自动读取开发 .env/bunfig。
- [ ] CI PR 只读、测试不使用真实密钥；发布按 tag 固定版本，所有目标成功才统一发布，失败可幂等重跑。
- [ ] 无证书使用明确预发布，签名 secret 仅发布阶段；README 说明安装、原生依赖及已验证边界。

### Task 5: 集成验收与最终审查
- [ ] Typecheck/lint/backend/frontend/Rust 检查和生产构建；原 Web 浏览器完整验收。
- [ ] Windows 编译版真实桌面：登录、会话、工具与图片、审批/提问/完成提醒、退出时嵌套工具清理、重启恢复。
- [ ] 独立整分支审查，修正实质问题；推送 GitHub 触发 CI，修复实际三端构建失败。
- [ ] 满足门禁后发布首个预发布并验证 Release 安装包资产可下载；明确签名/平台实测边界。
