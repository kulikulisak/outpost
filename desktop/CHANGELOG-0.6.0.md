# Outpost 0.6.0

- **Docker 镜像**：`ghcr.io/kulikulisak/outpost`，一个镜像装好 Claude Code、后台服务、手机端和远程浏览器。可以用 Zeabur 部署，持久卷挂到 `/root`，更新时拉取最新镜像即可。见 `docker/README.md`。
- **电脑端也能用网址连接**：添加服务器时选「网址（Docker / Zeabur）」，填网址和配对码就能用，不需要 SSH。聊天、审批、撤销、预览、多账号、远程浏览器、文件收发都走 HTTPS。
- 服务端：新增配对密码 `OUTPOST_PAIR_CODE`；在代理后面会识别真实 IP，防止误锁；第一次配对时自动记住公网网址，用来生成手机二维码；容器启动时会在日志里打印配对码。
- 远程浏览器加上 `--disable-dev-shm-usage`，避免在容器里崩溃。
