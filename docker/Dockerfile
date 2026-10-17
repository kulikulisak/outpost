# Outpost server: Claude Code + rcc + the phone/desktop web service + per-account VPS browsers, in one image.
# Build from the repository root:  docker build -f docker/Dockerfile -t outpost .
FROM debian:trixie-slim

ARG WITH_CJK_FONTS=0
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tmux nodejs procps tini openssh-client less ripgrep unzip jq python3 \
      tigervnc-standalone-server tigervnc-tools matchbox-window-manager websockify xclip \
      chromium fonts-dejavu-core qrencode \
 && if [ "$WITH_CJK_FONTS" = "1" ]; then apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fontconfig; fi \
 && rm -rf /var/lib/apt/lists/*

# Claude Code (native build). Copied out of $HOME so a volume mounted on /root never hides it;
# updates come from pulling a newer image (rebuilt weekly), not from the in-app updater.
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && cp -L /root/.local/bin/claude /usr/local/bin/claude \
 && rm -rf /root/.local /root/.claude /root/.claude.json /root/.cache \
 && claude --version

COPY vps-agent/rcc.mjs vps-agent/rcc-serve.mjs /opt/outpost/
COPY vps-agent/web /opt/outpost/web
COPY docker/entrypoint.sh /opt/outpost/entrypoint.sh
RUN chmod +x /opt/outpost/*.mjs /opt/outpost/entrypoint.sh \
 && printf '#!/bin/sh\nexec node /opt/outpost/rcc.mjs "$@"\n' > /usr/local/bin/rcc && chmod +x /usr/local/bin/rcc

ENV HOME=/root \
    PORT=8080 \
    RCC_SERVE_HOST=0.0.0.0 \
    RCC_TRUST_PROXY=1 \
    OUTPOST_PRINT_PAIR=1 \
    DISABLE_AUTOUPDATER=1 \
    OUTPOST_DOCKER=1

# Everything that must survive an image update lives under /root: Claude logins (~/.claude, ~/.claude.json),
# Outpost state (~/.rcc: sessions, accounts, browser profiles, paired devices) and projects (~/code).
VOLUME ["/root"]
WORKDIR /root
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS "http://127.0.0.1:${PORT}/api/ping" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/outpost/entrypoint.sh"]
