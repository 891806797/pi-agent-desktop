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

只支持以上四个发行目标；完整安装包在相应原生 CI runner 上构建。交叉编译 sidecar 不等于能在当前系统构建另一系统的安装器。

Pi SDK 1.5 的 Photon WASM 随资源打包，Rust 将其复制到受控运行目录；SDK 优先 worker，compiled 布局无法加载 worker 时按其原生逻辑回退到进程内图片处理。无需附带源码、node_modules、开发配置或另一份 worker 依赖树。冒烟验证实际执行 SDK 图片缩小，不能只以“未报错”认定图片处理成功。

## CI 与发布

PR 工作流只读，不使用真实提供方与生产密钥；四个原生 runner 运行 TS/Rust 检查、打包与安装包内容冒烟。Linux 基线固定 Ubuntu 22.04。发布通过 `v*` 标签或手动指定已存在的版本标签触发；根包、桌面包、Cargo 和 Tauri 配置版本必须一致，标签必须是 `v<version>`。

所有目标构建成功后，单个发布 job 才创建草稿、上传安装包和 SHA256SUMS，最后统一发布预发布。失败不会提前发布部分平台；相同标签重跑覆盖同名资产。保留原 Gitee remote，GitHub 公开仓库用于构建与分发。

可选 macOS secrets：`APPLE_CERTIFICATE`（base64 P12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`；公证另需 `APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID`。仅配置完整凭据时使用，未配置时以无签名预发布运行，不进行交互式询问。Windows 可选 secrets：`WINDOWS_CERTIFICATE`（base64 PFX）、`WINDOWS_CERTIFICATE_PASSWORD`；发布 runner 临时导入证书并按 SHA256 签名，未配置时跳过。当前工作流始终明确标为预发布，不会自动宣称签名或公证成功。

验证命令：

```sh
bun test packages/desktop/scripts
bun run packages/desktop/scripts/verify-release.ts
bun run packages/desktop/scripts/verify-release.ts --bundle packages/desktop/src-tauri/target/<Rust-target>/release/bundle
```

安装包冒烟提取真实 sidecar 和 WASM，放入隔离中文临时目录，验证 ready 协议/版本、缺失与错误连接密钥拒绝、健康检查和 shutdown；同编译配置下验证 SDK Photon 实际图片缩小，并阻断构建机器 WASM 原路径读取。macOS 检查已生成的 `.app` 包内容；Linux 解包 `.deb`；Windows 用 `7z` 解包 NSIS。

自动检查不能代替三端真实 GUI 验收：登录、会话、工具/图片、审批和完成提醒、后台入口、退出清理与重启恢复需人工确认。CI 未运行的操作不得标为已验证。



