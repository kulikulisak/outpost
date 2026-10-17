#!/bin/bash
# Container start: prepare the persistent home, then run the web service in the foreground.
set -e
mkdir -p /root/code /root/.rcc /root/.local/bin
chmod 700 /root/.rcc
# old sessions' tmux processes died with the previous container; rcc notices that on its own
[ -f /root/.gitconfig ] || git config --global init.defaultBranch main
echo "Outpost $(node /opt/outpost/rcc-serve.mjs status 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p') · $(claude --version 2>/dev/null)"
# Node 20 (Debian) needs the flag for the browser-control websocket; newer Node ignores it
exec node --experimental-websocket /opt/outpost/rcc-serve.mjs run --port "${PORT:-8080}"
