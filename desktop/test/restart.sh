#!/bin/sh
cd "$(dirname "$0")/.."
pkill -f "[e]lectron/dist/electron"; sleep 1.5
DISPLAY=${DISPLAY:-:55} setsid ./node_modules/electron/dist/electron . --no-sandbox --remote-debugging-port=9333 --user-data-dir=/tmp/rc-test-profile > /tmp/electron.log 2>&1 < /dev/null &
sleep 12
