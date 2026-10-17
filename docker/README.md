# 用 Docker / Zeabur 安装 Outpost 服务端

镜像：`ghcr.io/kulikulisak/outpost:latest`（每次发版本、以及每周一自动重建，用来更新 Claude Code）
带中文字体的版本：`ghcr.io/kulikulisak/outpost:cjk`（在 VPS 浏览器里看中文网页不会出现方块）

镜像里已经包含：Claude Code、Outpost 后台服务、手机网页端、给每个 Claude 账号用的远程浏览器（登录和网页版都在里面）。

## Zeabur（自有服务器）

1. 在 Zeabur 里把你的服务器绑定好（我的服务器 → 添加服务器）。
2. 新建项目时选这台服务器 → 添加服务 → **Docker 镜像**，填 `ghcr.io/kulikulisak/outpost:latest`。
3. **端口**：添加 `8080`，类型 HTTP。
4. **持久卷**：挂载路径填 `/root`。Claude 的登录、聊天记录、项目文件和已配对的设备都存在这里，换镜像也不会丢。
5. **环境变量**（可选，但建议设置）：
   - `OUTPOST_PAIR_CODE`：配对密码，至少 8 位，越长越好。电脑端和手机端第一次连接时填它。
   - `OUTPOST_NAME`：在客户端里显示的服务器名字。
6. 部署后到 **网络** 里点「生成域名」（`xxx.zeabur.app`），或者绑定你自己的域名。
7. 如果没有设置 `OUTPOST_PAIR_CODE`：打开服务的 **日志**，里面会有一行「Outpost 配对码：XXXX XXXX」，24 小时内有效，只能用一次。

### 连接
- **电脑端**：设置 → 服务器 → 添加服务器 → 选「网址（Docker / Zeabur）」，填网址和配对码。
- **手机**：直接用浏览器打开这个网址，输入配对码，然后「添加到主屏幕」（iPhone 要先添加到主屏幕才能收到通知）。
- 第一次连上后，在电脑端或手机上登录 Claude 账号（会在服务器上的浏览器里完成）。

### 更新
在 Zeabur 里重新部署或更新镜像就会拉取最新的 `latest`。更新时服务会重启一下，正在运行的任务会中断，聊天记录和登录都不会丢。

## 普通 Docker

```bash
docker run -d --name outpost --restart unless-stopped \
  -p 8080:8080 -v outpost-home:/root \
  -e OUTPOST_PAIR_CODE='换成你自己的长密码' \
  ghcr.io/kulikulisak/outpost:latest
docker logs outpost   # 看配对码
```
公网访问请在前面加 HTTPS（Cloudflare Tunnel、Caddy 等）；手机通知需要 HTTPS。

## 说明
- Claude 访问外网走的是你服务器自己的 IP，跟直接安装一样；域名加速只影响你的电脑和手机连到服务器这一段。
- 镜像里关闭了 Claude Code 的自动更新，版本跟着镜像走，保证每次部署都一样。
- 所有接口都要求配对后的设备钥匙；输错配对码 10 次会锁 5 分钟（按真实来源 IP 计算）。
