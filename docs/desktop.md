# Pi Agent 桌面客户端

桌面版复用现有 React 页面与 Bun 后端；Tauri 负责窗口、受限 API 转发、凭据与进程生命周期。业务数据使用 SQLite，保存在系统的应用本地数据目录；安装目录可以只读。不导入旧数据，不包含真实模型密钥或开发账号，不提供自动更新。

## 安装

在 [GitHub Releases](https://github.com/891806797/pi-agent-desktop/releases) 选择对应平台：

| 平台 | CPU | 安装包 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe` / MSI |
| macOS | Apple Silicon | arm64 `.dmg` |
| macOS | Intel | x64 `.dmg` |
| Linux | x64 | `.deb` / `.AppImage`，Ubuntu 22.04 或更新 |

下载后按 Release 中的 `SHA256SUMS` 核对 SHA256。初版以预发布形式提供；没有证书时不保证 Windows 签名或 macOS 公证，系统可能提示来源未验证。Windows 需要 WebView2（安装器按 Tauri 配置安装）；Linux 需要 WebKitGTK 4.1 和 Ayatana AppIndicator。首次使用按界面创建账户、配置自己的模型提供方。

## 窗口与提醒

点击窗口的关闭按钮后，智能体继续在后台运行。Windows/macOS 隐藏到托盘或 Dock；Windows 创建托盘失败时、以及 Linux 上保留最小化窗口入口，避免无法返回。托盘、应用菜单中的“退出应用”才会保存状态并关闭后端及受管工具进程；启动第二个客户端会回到已有窗口。

待审批或待回答时显示琥珀色状态、请求系统注意并发送通知；运行完成后显示绿色完成点。点击提醒回到对应会话，阅读或处理后更新状态。系统通知受通知权限和勿扰设置控制，操作系统通知中心保留的历史通知不会随应用内已读状态自动删除。

托盘使用带状态颜色的 Pi 图标；Windows 任务栏使用状态覆盖图标。macOS Dock 使用系统徽标文字“待处理／完成”，徽标颜色由系统控制；Linux 任务栏徽标支持取决于桌面环境。

进程重启恢复持久化历史与中断状态，不复活旧的 Promise、模型请求或审批计时；执行结果未知的工具不会自动重放，需要用户确认后继续。

Windows 使用 Job Object 管理工具进程；Unix 桌面版通过 Pi 公开的 `BashOperations` 托管 shell 进程组，保留后台命令直到自然结束或退出应用。空进程组及时回收，避免每条命令累积闲置 shell；工具定义、审批和输出处理继续复用 Pi。Web 版的执行方式保持原样。

## 本地开发与构建

需要 Bun 1.4.2、Rust stable 和 [Tauri 原生构建依赖](https://v2.tauri.app/start/prerequisites/)。Windows 使用 MSVC Build Tools；macOS 使用 Xcode Command Line Tools；Ubuntu 22.04 安装：

```sh
sudo apt-get install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
bun install --frozen-lockfile
bun run desktop:dev
bun run desktop:build
```

`desktop:prepare` 只编译 sidecar、准备 Photon WASM；`desktop:build` 的 Tauri hook 构建前端并准备 sidecar。CI 先 `desktop:prepare --frontend` 供 Rust 检查使用，再 `desktop:build --prepared` 复用同一次准备结果，避免重复编译；`--prepared` 只适用于已在同一 checkout 完成准备的构建。桌面 sidecar 从相同后端入口编译，内嵌同一组 Drizzle 迁移，不重复内嵌前端。桌面 Bun 编译产物禁用自动读取 `.env` 和 `bunfig.toml`；Web 编译版保留从工作目录读取用户配置的行为。脚本通过参数数组启动命令，并使用路径标准库，支持带空格和中文的路径。

指定目标：

```sh
bun run desktop:prepare --target x86_64-pc-windows-msvc
bun run desktop:prepare --target aarch64-apple-darwin
bun run desktop:prepare --target x86_64-apple-darwin
bun run desktop:prepare --target x86_64-unknown-linux-gnu
```

只支持以上四个发行目标；完整安装包需要对应操作系统的原生构建环境。交叉编译 sidecar 不等于能在当前系统构建另一系统的安装器。

Pi SDK 1.5 的 Photon WASM 随资源打包，Rust 将其复制到受控运行目录；SDK 优先 worker，compiled 布局无法加载 worker 时按其原生逻辑回退到进程内图片处理。无需附带源码、node_modules、开发配置或另一份 worker 依赖树。冒烟验证实际执行 SDK 图片缩小，不能只以“未报错”认定图片处理成功。

## 本地发布与可选工作流

默认本地构建，在 GitHub Releases 手动创建版本并上传已验证的安装包和 `SHA256SUMS`。根包、桌面包、Cargo 和 Tauri 配置版本必须一致，标签必须是 `v<version>`。没有在相应平台完成构建和验收的安装包不能标为已支持下载。

仓库中的 Actions 配置只保留手动触发，不会因推送、PR 或标签运行；当前仓库的 Desktop CI 还在 GitHub 侧停用，避免产生自动化用量。公开仓库的标准 runner 计算免费，但 Actions 产物存储有独立额度；没有明确启用意愿前，不开通付费、不提高预算，也不自动重新启用工作流。

如以后明确启用：四个原生 runner 运行 TS/Rust 检查、打包与安装包内容冒烟，不使用真实模型密钥；Linux 基线固定 Ubuntu 22.04。手动发布必须指定已有版本标签，所有目标成功后才创建草稿、上传安装包和 SHA256SUMS，最后统一发布预发布；相同标签重跑覆盖同名资产。保留原 Gitee remote，GitHub 公开仓库用于源码和安装包分发。

可选 macOS secrets：`APPLE_CERTIFICATE`（base64 P12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`；公证另需 `APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID`。仅配置完整凭据时使用，未配置时以无签名预发布运行，不进行交互式询问。Windows 可选 secrets：`WINDOWS_CERTIFICATE`（base64 PFX）、`WINDOWS_CERTIFICATE_PASSWORD`；发布 runner 临时导入证书并按 SHA256 签名，未配置时跳过。当前工作流始终明确标为预发布，不会自动宣称签名或公证成功。

验证命令：

```sh
bun test packages/desktop/scripts
bun run packages/desktop/scripts/verify-release.ts
bun run packages/desktop/scripts/verify-release.ts --bundle packages/desktop/src-tauri/target/<Rust-target>/release/bundle
```

安装包冒烟提取真实 sidecar 和 WASM，放入隔离中文临时目录，验证 ready 协议/版本、缺失与错误连接密钥拒绝、健康检查和 shutdown；同编译配置下验证 SDK Photon 实际图片缩小，并阻断构建机器 WASM 原路径读取。macOS 检查已生成的 `.app` 包内容；Linux 解包 `.deb`；Windows 优先用 `7z` 解包 NSIS，无 `7z` 时使用 `msiexec /a /qn` 对 MSI 管理解包，不安装到系统。

自动检查不能代替三端真实 GUI 验收：登录、会话、工具/图片、审批和完成提醒、后台入口、退出清理与重启恢复需人工确认。CI 未运行的操作不得标为已验证。
