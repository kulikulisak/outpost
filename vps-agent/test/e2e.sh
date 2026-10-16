#!/usr/bin/env bash
# End-to-end test of rcc against the mock claude. Uses a throwaway HOME.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RCC="node $HERE/../rcc.mjs"
export HOME="$(mktemp -d)"
export RCC_CLAUDE="$HERE/mock-claude.mjs"
chmod +x "$RCC_CLAUDE"
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }

# a git repo to work in
mkdir -p "$HOME/code/blog-api" && cd "$HOME/code/blog-api"
git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

$RCC doctor | grep -q '"claude":"2.1.293' && pass doctor || fail doctor

# 1. start + init event lifts real session id / model into meta
SID=$($RCC start --cwd "$HOME/code/blog-api" --model opus --effort high | node -pe 'JSON.parse(require("fs").readFileSync(0)).sid')
for i in $(seq 50); do $RCC list | grep -q '"resolvedModel":"claude-opus-5-5"' && break; sleep 0.1; done
$RCC list | grep -q '"resolvedModel":"claude-opus-5-5"' && pass "start, model resolved" || fail start

# 2. send + result
echo "你好" | $RCC send "$SID" >/dev/null
for i in $(seq 50); do $RCC tail "$SID" | grep -q '"type":"result"' && break; sleep 0.1; done
$RCC tail "$SID" | grep -q '收到：\*\*你好' && pass "send / reply" || fail send

# 3. resumable tail: remember byte offset, then read only what's new
OFF=$($RCC tail "$SID" | wc -c)
echo "第二条" | $RCC send "$SID" >/dev/null
sleep 0.5
NEW=$($RCC tail "$SID" --from "$OFF")
echo "$NEW" | grep -q '第二条' && ! echo "$NEW" | grep -q '你好' && pass "tail --from offset" || fail tail

# 4. permission round-trip: deny first, then allow
echo "帮我改一下" | $RCC send "$SID" >/dev/null
for i in $(seq 50); do REQ=$($RCC tail "$SID" | grep rcc_permission_request | tail -1 | node -pe 'JSON.parse(require("fs").readFileSync(0)).req' 2>/dev/null) && [ -n "$REQ" ] && break; sleep 0.1; done
[ -n "${REQ:-}" ] && pass "permission request surfaced ($REQ)" || fail "no permission request"
$RCC answer "$SID" "$REQ" deny "先别改" >/dev/null
sleep 0.6
$RCC tail "$SID" | grep -q 'denied: 先别改' && pass "deny reaches claude" || fail deny

OFF=$($RCC tail "$SID" | wc -c)
echo "再改一次" | $RCC send "$SID" >/dev/null
for i in $(seq 50); do REQ2=$($RCC tail "$SID" --from "$OFF" | grep rcc_permission_request | node -pe 'JSON.parse(require("fs").readFileSync(0)).req' 2>/dev/null) && [ -n "$REQ2" ] && break; sleep 0.1; done
$RCC answer "$SID" "$REQ2" allow >/dev/null
sleep 0.6
$RCC tail "$SID" --from "$OFF" | grep -q '"content":"edited"' && pass "allow reaches claude" || fail allow

# 5. follow mode exits cleanly when the session stops
( $RCC tail "$SID" --follow > "$HOME/follow.out" ) & FPID=$!
sleep 0.3; $RCC stop "$SID" >/dev/null
for i in $(seq 30); do kill -0 $FPID 2>/dev/null || break; sleep 0.1; done
kill -0 $FPID 2>/dev/null && fail "follow did not exit" || pass "stop + follow exits"

# 6. worktree task in its own tmux session
WSID=$($RCC start --cwd "$HOME/code/blog-api" --worktree fix-login --base main | node -pe 'JSON.parse(require("fs").readFileSync(0)).sid')
[ -d "$HOME/code/blog-api-worktrees/fix-login" ] && git -C "$HOME/code/blog-api-worktrees/fix-login" rev-parse --abbrev-ref HEAD | grep -q fix-login && pass "worktree created on branch fix-login" || fail worktree
$RCC list | grep -q '"worktree":"fix-login"' && pass "list shows worktree task" || fail "list worktree"
$RCC stop "$WSID" >/dev/null

# 7. resume passes the Claude session id through
RSID=$($RCC start --cwd "$HOME/code/blog-api" --resume abc-123 | node -pe 'JSON.parse(require("fs").readFileSync(0)).sid')
for i in $(seq 50); do $RCC list | grep -q '"claudeSessionId":"abc-123"' && break; sleep 0.1; done
$RCC list | grep -q '"claudeSessionId":"abc-123"' && pass "resume" || fail resume
$RCC stop "$RSID" >/dev/null

# 8. projects scan from ~/.claude/projects
mkdir -p "$HOME/.claude/projects/-root-code-blog-api"
printf '%s\n' '{"type":"user","cwd":"'"$HOME"'/code/blog-api","gitBranch":"main","message":{"role":"user","content":"修复登录超时"}}' > "$HOME/.claude/projects/-root-code-blog-api/aaaa.jsonl"
$RCC projects | grep -q '"title":"修复登录超时"' && pass "projects scan" || fail projects

echo "ALL PASSED"
