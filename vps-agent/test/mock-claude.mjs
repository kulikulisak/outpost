#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json` for local testing.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const args = process.argv.slice(2);
const ACC = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR.split('/').slice(-2, -1)[0] : 'default';
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: `${ACC}@example.com`, subscriptionType: ACC === 'default' ? 'max' : 'pro' })); process.exit(0); }
if (args[0] === '--version') { console.log('2.1.293 (Claude Code) [mock]'); process.exit(0); }
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const sessionId = get('--resume') || '11111111-2222-3333-4444-555555555555';
const model = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }[get('--model')] || 'claude-opus-5-5';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// connect to the permission MCP server, like Claude Code would
let mcp = null, nextId = 1; const waiters = new Map();
const cfgPath = get('--mcp-config');
if (cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.rcc;
  mcp = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: mcp.stdout }).on('line', (l) => { const m = JSON.parse(l); waiters.get(m.id)?.(m); });
}
const rpc = (method, params) => new Promise((res) => { const id = nextId++; waiters.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
if (mcp) { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock' } }); }

emit({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), permissionMode: get('--permission-mode'), claude_code_version: '2.1.293' });

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') continue;
  const imgs = msg.message.content.filter((c) => c.type === 'image').length;
  const text = msg.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('') + (imgs ? `（附带 ${imgs} 张图片）` : '');
  if (text.includes('额度') && ACC === 'default') {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, session_id: sessionId });
    emit({ type: 'assistant', session_id: sessionId, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 6pm" }] } });
    emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 6pm", session_id: sessionId });
    continue;
  }
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model, content: [{ type: 'text', text: `[${ACC}] 收到：**${text.trim()}**。我先看一下 \`session.ts\`。` }] } });
  if (text.includes('改')) {
    const input = { file_path: 'src/auth/session.ts', old_string: 'createdAt', new_string: 'lastSeenAt' };
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input }] } });
    const r = await rpc('tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input, tool_use_id: 'toolu_1' } });
    const verdict = JSON.parse(r.result.content[0].text);
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: verdict.behavior === 'allow' ? 'edited' : `denied: ${verdict.message}`, is_error: verdict.behavior !== 'allow' }] } });
  }
  emit({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0.01, modelUsage: { [model]: {} } });
}
mcp?.kill();
