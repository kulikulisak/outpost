# Outpost

Claude Code 跑在你的 VPS 上，这是它的桌面窗口。

## 首次使用

1. 打开应用，填 VPS 地址、用户名和 SSH 私钥（或密码）→ 保存并连接
2. 设置 → 环境 → 开始：自动装 Claude Code、Node.js、tmux、git、TigerVNC、Chromium
3. 设置 → Claude 账号 → 打开：窗口里出现 VPS 上的浏览器，在里面登录；页面给出授权码后，点“从 VPS 剪贴板读取”或粘贴提交
4. 返回对话，新建会话开始用

## macOS 首次打开

应用没有签名，第一次需要：右键应用 → 打开 → 打开。或者在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Outpost.app"
```

## 功能

- 侧栏按项目列出 VPS 上 `~/.claude/projects` 里的全部历史会话，点开即可接着聊（`--resume`）
- 输入框右下角切换模型（别名，由 VPS 上的 Claude Code 解析到最新版本）和思考强度
- 左下切换权限模式；“每次询问”时，改文件、跑命令前会弹出允许 / 拒绝
- 项目菜单 → 新建并行任务：建 git worktree + 新分支，独立的 Claude 进程
- 每个会话在 VPS 的 tmux 里运行，关掉应用或断网都不影响，回来自动续上
- 凭据存在系统钥匙串（macOS Keychain / Windows DPAPI）

## 开发

```bash
npm install
npm run dev          # 编译并启动
npm run dist:mac     # 打包 macOS zip（arm64 + x64）
npm run dist:win     # 打包 Windows zip
```

结构：`src/main`（SSH、钥匙串、VPS 操作）、`src/renderer`（React 界面）、`resources/rcc.mjs`（VPS 端小助手，连接时自动上传到 `~/.local/bin/rcc`）、`resources/bootstrap.sh`（环境安装脚本）。
