# rcc — VPS 端小助手

桌面客户端通过 SSH 调用它。单文件、零依赖，需要 Node 18+、tmux、git，以及 PATH 里的 `claude`。

## 安装

```bash
scp rcc.mjs vps:~/.local/bin/rcc && ssh vps 'chmod +x ~/.local/bin/rcc && rcc doctor'
```

## 命令（全部输出 JSON）

| 命令 | 作用 |
|---|---|
| `rcc doctor` | Node / tmux / git / Claude Code 版本，是否已登录 |
| `rcc start --cwd ~/code/app --model opus --effort high [--permission-mode default] [--resume ID] [--worktree NAME --base main] [--title T]` | 在独立 tmux 会话里启动 Claude Code，返回 `sid` |
| `echo "消息" \| rcc send SID` | 发一条用户消息 |
| `rcc tail SID --from 字节偏移 --follow` | 实时读输出；断线后用上次的偏移量继续，不丢不重 |
| `rcc answer SID REQ allow\|deny [理由]` | 回复权限询问 |
| `rcc interrupt SID` / `rcc stop SID` | 中断当前回合 / 结束会话 |
| `rcc list` | 本助手管理的会话（状态、实际模型、worktree） |
| `rcc projects` | 扫描 `~/.claude/projects`，按项目列出历史会话 |

## 输出流

`out.jsonl` 原样保存 Claude Code 的 stream-json，另加几种 `rcc_*` 事件：

- `rcc_started` / `rcc_exit` / `rcc_error`
- `rcc_user`：你发出的消息（用于回放历史）
- `rcc_permission_request` `{req, tool_name, input}` → 客户端弹窗 → `rcc answer`
- `rcc_permission_result` `{req, behavior}`

## 工作原理

- 每个会话：`~/.rcc/sessions/<sid>/`，含 `meta.json`、`out.jsonl`、`in.fifo`、`perm/`
- tmux 里的 runner 以读写模式持有 FIFO，Claude Code 的 stdin 不会意外 EOF；SSH 断开不影响任务
- 权限：runner 用 `--mcp-config` 挂上 `rcc mcp`，再用 `--permission-prompt-tool mcp__rcc__approve`，询问写进输出流，等桌面端回复（默认 30 分钟无回复则拒绝）
- `--permission-mode bypassPermissions` 时不挂权限工具

## 测试

```bash
bash test/e2e.sh   # 用 test/mock-claude.mjs 模拟 Claude Code，跑完整流程
```

## 手机服务 rcc serve

`rcc-serve.mjs` 放在 `rcc` 旁边（`~/.local/bin/rcc-serve.mjs`），手机端网页放在 `~/.rcc/mobile/web/`。

| 命令 | 作用 |
|---|---|
| `rcc serve start [--port 7788]` / `stop` / `status` | 在 tmux（rcc-serve）里运行，只监听 127.0.0.1 |
| `rcc pair` | 一次性配对码 + 二维码（10 分钟、单次） |
| `rcc serve tailscale` | 安装 / 登录 Tailscale，并用 Tailscale Serve 发布 HTTPS |
| `rcc serve url https://域名` | 自己的反向代理地址 |
| `rcc serve devices` / `revoke ID` | 已配对手机 |

数据在 `~/.rcc/mobile/`：`config.json`（端口、地址、VAPID 密钥）、`devices.json`（只存密钥的 sha256）、`push.json`（推送订阅）。
