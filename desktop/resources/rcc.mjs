#!/usr/bin/env node
// rcc — Remote Claude Code helper. Runs on the VPS; the desktop client drives it over SSH.
// No dependencies. Node >= 18. Needs tmux, and `claude` on PATH (or RCC_CLAUDE=/path/to/claude).
//
//   rcc doctor                                   versions / login state as JSON
//   rcc start --cwd DIR [--model opus] [--effort high] [--permission-mode default]
//             [--resume CLAUDE_SESSION_ID] [--worktree NAME --base main] [--title T]
//   rcc send SID            (message text on stdin)
//   rcc tail SID [--from BYTES] [--follow]       raw JSON lines from out.jsonl, resumable by byte offset
//   rcc answer SID REQ allow|deny [message]      reply to a permission request
//   rcc interrupt SID | rcc stop SID | rcc list | rcc projects
//   rcc serve start|stop|status|pair|devices|revoke|url|tailscale   phone access (rcc-serve.mjs)
//   rcc pair                                     pairing QR for the phone app
//   (internal) rcc run SID | rcc mcp SID

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.RCC_HOME || path.join(os.homedir(), '.rcc');
const SESS = path.join(ROOT, 'sessions');
const CLAUDE = process.env.RCC_CLAUDE || 'claude';
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const die = (msg, code = 1) => { process.stderr.write(JSON.stringify({ error: msg }) + '\n'); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = (sid) => path.join(SESS, sid);
const metaPath = (sid) => path.join(dir(sid), 'meta.json');
const readMeta = (sid) => { try { return JSON.parse(fs.readFileSync(metaPath(sid), 'utf8')); } catch { die(`no such session: ${sid}`); } };
const writeMeta = (sid, patch) => {
  const m = { ...readMeta(sid), ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${metaPath(sid)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2)); fs.renameSync(tmp, metaPath(sid));
  return m;
};
const appendEvent = (sid, ev) => fs.appendFileSync(path.join(dir(sid), 'out.jsonl'), JSON.stringify({ ...ev, ts: Date.now() }) + '\n');
const tmuxName = (sid) => `rcc-${sid}`;
const tmuxAlive = (sid) => spawnSync('tmux', ['has-session', '-t', tmuxName(sid)], { stdio: 'ignore' }).status === 0;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true; else { a[key] = next; i++; }
    } else a._.push(k);
  }
  return a;
}
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };

// ---------- doctor ----------
function doctor() {
  const ver = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null; };
  const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
  out({
    node: process.version,
    tmux: ver('tmux', ['-V']),
    git: ver('git', ['--version']),
    claude: ver(CLAUDE, ['--version']),
    loggedIn: (() => { try { return !!authStatus().loggedIn; } catch { return fs.existsSync(credFile); } })(),
    xvnc: spawnSync('which', ['Xvnc']).status === 0,
    windowManager: spawnSync('which', ['matchbox-window-manager']).status === 0,
    websockify: spawnSync('which', ['websockify']).status === 0,
    chromium: ver('chromium', ['--version']) || ver('chromium-browser', ['--version']) || ver('google-chrome', ['--version']),
    rccHome: ROOT,
  });
}

// ---------- start ----------
function start(a) {
  if (!a.cwd) die('--cwd is required');
  let cwd = path.resolve(String(a.cwd).replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(cwd) && a.mkdir) fs.mkdirSync(cwd, { recursive: true });
  if (!fs.existsSync(cwd)) die(`目录不存在：${cwd}`);
  let worktree = null;
  if (a.worktree) {
    const name = String(a.worktree);
    const base = a.base ? String(a.base) : 'HEAD';
    const wtPath = path.join(path.dirname(cwd), `${path.basename(cwd)}-worktrees`, name);
    const r = spawnSync('git', ['-C', cwd, 'worktree', 'add', '-b', name, wtPath, base], { encoding: 'utf8' });
    if (r.status !== 0) die(`git worktree failed: ${(r.stderr || '').trim()}`);
    worktree = { name, base, path: wtPath, repo: cwd };
    cwd = wtPath;
  }
  const sid = crypto.randomBytes(5).toString('hex');
  fs.mkdirSync(path.join(dir(sid), 'perm'), { recursive: true });
  execFileSync('mkfifo', [path.join(dir(sid), 'in.fifo')]);
  fs.writeFileSync(path.join(dir(sid), 'out.jsonl'), '');
  const meta = {
    sid, cwd, worktree, title: a.title || null,
    model: a.model || null, effort: a.effort || null,
    permissionMode: a['permission-mode'] || 'default',
    resume: a.resume || null, claudeSessionId: a.resume || null,
    account: accId(a),
    status: 'starting', createdAt: new Date().toISOString(),
  };
  accEnsure(meta.account);
  fs.writeFileSync(metaPath(sid), JSON.stringify(meta, null, 2));
  const envs = ['HOME', 'PATH', 'RCC_HOME', 'RCC_CLAUDE', 'RCC_PERMISSION_TIMEOUT_MS'].filter((k) => process.env[k] !== undefined).map((k) => `${k}=${shq(process.env[k])}`).join(' ');
  const cmd = `env ${envs} ${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)} run ${sid} 2>>${JSON.stringify(path.join(dir(sid), 'runner.log'))}`;
  const r = spawnSync('tmux', ['new-session', '-d', '-s', tmuxName(sid), '-c', cwd, cmd], { encoding: 'utf8' });
  if (r.status !== 0) die(`tmux failed: ${(r.stderr || '').trim()}`);
  out({ sid, cwd, worktree, tmux: tmuxName(sid) });
}

// ---------- run (inside tmux) ----------
async function run(sid) {
  const m = readMeta(sid);
  const d = dir(sid);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (m.model) args.push('--model', m.model);
  if (m.effort) args.push('--effort', m.effort);
  if (m.resume) args.push('--resume', m.resume);
  args.push('--permission-mode', m.permissionMode);
  if (m.permissionMode !== 'bypassPermissions') {
    const mcpCfg = path.join(d, 'mcp.json');
    fs.writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { rcc: { command: process.execPath, args: [SELF, 'mcp', sid] } } }));
    args.push('--mcp-config', mcpCfg, '--permission-prompt-tool', 'mcp__rcc__approve');
  }
  const acc = m.account || 'default';
  const child = spawn(CLAUDE, args, { cwd: m.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...accEnv(acc), RCC_SID: sid } });
  let limited = false;
  const hitLimit = (until, type, text) => {
    if (limited) return; limited = true;
    markLimited(acc, until, type);
    writeMeta(sid, { limit: { account: acc, resetsAt: until || null, type: type || null, at: Date.now() } });
    appendEvent(sid, { type: 'rcc_limit', account: acc, resetsAt: until || null, limitType: type || null, text: text || null });
  };
  const LIMIT_RE = /usage limit|limit reached|hit your limit|rate.?limit|额度/i;
  writeMeta(sid, { status: 'running', pid: child.pid, runnerPid: process.pid, claudeArgs: args });
  appendEvent(sid, { type: 'rcc_started', args });

  // stdin: keep the FIFO open read-write so it never hits EOF between messages
  const fd = fs.openSync(path.join(d, 'in.fifo'), fs.constants.O_RDWR);
  const fifo = fs.createReadStream(null, { fd, autoClose: false });
  fifo.on('data', (buf) => { child.stdin.write(buf); writeMeta(sid, { busy: true }); });

  // stdout: append verbatim, and lift a few facts into meta
  const outFile = fs.openSync(path.join(d, 'out.jsonl'), 'a');
  let pending = '';
  child.stdout.on('data', (buf) => {
    pending += buf.toString('utf8');
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      if (!line.trim()) continue;
      fs.writeSync(outFile, line + '\n');
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init') writeMeta(sid, { claudeSessionId: ev.session_id, resolvedModel: ev.model, claudeVersion: ev.claude_code_version || null });
        else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') hitLimit(ev.rate_limit_info.resetsAt, ev.rate_limit_info.rateLimitType);
        else if (ev.type === 'assistant' && ev.error === 'rate_limit') hitLimit(null, null, textOf(ev.message?.content));
        if (ev.type === 'result' && ev.is_error && LIMIT_RE.test(String(ev.result || ''))) hitLimit(null, null, String(ev.result).slice(0, 300));
        if (ev.type === 'result') writeMeta(sid, { busy: false, lastResult: { subtype: ev.subtype, isError: !!ev.is_error, text: typeof ev.result === 'string' ? ev.result.slice(0, 500) : undefined, cost: ev.total_cost_usd, modelUsage: ev.modelUsage ? Object.keys(ev.modelUsage) : undefined, at: Date.now() } });
      } catch { /* non-JSON line, kept verbatim */ }
    }
  });
  child.stderr.on('data', (buf) => fs.appendFileSync(path.join(d, 'stderr.log'), buf));

  const finish = (code, signal) => {
    if (pending.trim()) fs.writeSync(outFile, pending + '\n');
    appendEvent(sid, { type: 'rcc_exit', code, signal });
    writeMeta(sid, { status: 'exited', exitCode: code, busy: false });
    process.exit(0);
  };
  child.on('exit', finish);
  child.on('error', (e) => { appendEvent(sid, { type: 'rcc_error', message: e.message }); finish(-1, null); });
  for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => child.kill('SIGTERM'));
}

// ---------- send ----------
function send(sid, raw, a = {}) {
  const m = readMeta(sid);
  if (m.status !== 'running' && m.status !== 'starting') die(`session not running (${m.status})`);
  // --json: {"text": "...", "files": [{"path": "/abs/on/vps", "name": "a.png", "mime": "image/png"}]}
  let text = raw, files = [];
  if (a.json) { try { const j = JSON.parse(raw); text = String(j.text || ''); files = Array.isArray(j.files) ? j.files : []; } catch { die('bad --json payload'); } }
  if (!text.trim() && !files.length) die('empty message');
  const content = [];
  const notes = [];
  for (const f of files) {
    const mime = String(f.mime || '');
    if (/^image\/(png|jpeg|gif|webp)$/.test(mime) && fs.existsSync(f.path) && fs.statSync(f.path).size < 5 * 1024 * 1024) {
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(f.path).toString('base64') } });
    } else notes.push(f.path);
  }
  let body = text;
  if (notes.length) body = `${text}${text ? '\n\n' : ''}附件（已上传到 VPS）：\n${notes.map((p) => `- ${p}`).join('\n')}`;
  if (body.trim()) content.push({ type: 'text', text: body });
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const fifo = path.join(dir(sid), 'in.fifo');
  // non-blocking open only proves the runner is attached; write blocking so big messages are not cut off
  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); }
  catch (e) { die(e.code === 'ENXIO' ? 'runner not attached to fifo' : e.message); }
  appendEvent(sid, { type: 'rcc_user', text, attachments: files.map((f) => ({ name: f.name || path.basename(f.path), mime: f.mime || '', path: f.path })) });
  const fd = fs.openSync(fifo, fs.constants.O_WRONLY);
  fs.writeSync(fd, line); fs.closeSync(fd);
  out({ ok: true });
}

// ---------- tail ----------
async function tail(sid, a) {
  readMeta(sid);
  const file = path.join(dir(sid), 'out.jsonl');
  let pos = Number(a.from || 0);
  const buf = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(file, 'r');
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n > 0) { process.stdout.write(buf.subarray(0, n)); pos += n; continue; }
    if (!a.follow) break;
    const m = readMeta(sid);
    if ((m.status === 'exited' || m.status === 'stopped') && fs.statSync(file).size <= pos) break;
    await sleep(150);
  }
  fs.closeSync(fd);
}

// ---------- permission answers ----------
function answer(sid, req, decision, message, rule) {
  readMeta(sid);
  if (!['allow', 'deny'].includes(decision)) die('decision must be allow|deny');
  if (rule && decision === 'allow') {
    // "allow for the rest of this session": TOOL or TOOL:command-prefix (Bash)
    const rf = path.join(dir(sid), 'perm', 'rules.json');
    let rules = []; try { rules = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch { /* none yet */ }
    const [tool, ...pre] = String(rule).split(':');
    rules.push({ tool, prefix: pre.join(':') || null });
    fs.writeFileSync(rf, JSON.stringify(rules));
  }
  const f = path.join(dir(sid), 'perm', `${req}.res.json`);
  fs.writeFileSync(f + '.tmp', JSON.stringify({ decision, message: message || null }));
  fs.renameSync(f + '.tmp', f);
  out({ ok: true });
}

// ---------- MCP server for --permission-prompt-tool ----------
async function mcp(sid) {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const tool = {
    name: 'approve',
    description: 'Ask the desktop user whether a tool call may run.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
  };
  const handle = async (msg) => {
    const { id, method, params } = msg;
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rcc', version: '0.1.0' } } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: [tool] } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/call') {
      const { tool_name, input = {}, tool_use_id } = params?.arguments || {};
      let rules = []; try { rules = JSON.parse(fs.readFileSync(path.join(dir(sid), 'perm', 'rules.json'), 'utf8')); } catch { /* none */ }
      if (rules.some((r) => r.tool === tool_name && (!r.prefix || String(input.command || '').trim().startsWith(r.prefix)))) {
        appendEvent(sid, { type: 'rcc_permission_auto', tool_name, input, tool_use_id });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: input }) }] } });
      }
      const req = crypto.randomBytes(4).toString('hex');
      appendEvent(sid, { type: 'rcc_permission_request', req, tool_name, input, tool_use_id });
      const resFile = path.join(dir(sid), 'perm', `${req}.res.json`);
      const deadline = Date.now() + Number(process.env.RCC_PERMISSION_TIMEOUT_MS || 30 * 60 * 1000);
      let res = null;
      while (!res && Date.now() < deadline) {
        if (fs.existsSync(resFile)) res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        else await sleep(250);
      }
      const verdict = res?.decision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: res?.message || (res ? 'User denied this action.' : 'No answer from the user in time.') };
      appendEvent(sid, { type: 'rcc_permission_result', req, behavior: verdict.behavior });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(verdict) }] } });
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  };
  let pending = '';
  process.stdin.on('data', (buf) => {
    pending += buf.toString('utf8');
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1);
      if (line) { try { handle(JSON.parse(line)); } catch { /* ignore malformed */ } }
    }
  });
}

// ---------- list / stop / interrupt ----------
function list() {
  if (!fs.existsSync(SESS)) return out([]);
  const rows = fs.readdirSync(SESS).map((sid) => {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath(sid), 'utf8'));
      if (m.status === 'running' && !tmuxAlive(sid)) m.status = 'lost';
      const size = fs.statSync(path.join(dir(sid), 'out.jsonl')).size;
      const ff = path.join(dir(sid), 'first.txt');
      if (fs.existsSync(ff)) m.firstText = fs.readFileSync(ff, 'utf8');
      else {
        const hit = readHead(path.join(dir(sid), 'out.jsonl'), 64 * 1024).split('\n').find((l) => l.includes('"rcc_user"'));
        if (hit) { try { m.firstText = String(JSON.parse(hit).text || '').slice(0, 80); fs.writeFileSync(ff, m.firstText); } catch { /* partial line */ } }
      }
      return { sid, permissionMode: m.permissionMode || 'default', firstText: m.firstText || null, lastText: m.lastResult?.text ? String(m.lastResult.text).slice(0, 120) : null, lastError: !!m.lastResult?.isError, cwd: m.cwd, title: m.title, status: m.status, busy: !!m.busy, model: m.model, resolvedModel: m.resolvedModel, effort: m.effort, claudeSessionId: m.claudeSessionId, worktree: m.worktree?.name || null, repo: m.worktree?.repo || null, account: m.account || 'default', limit: m.limit || null, resume: m.resume || null, createdAt: m.createdAt, bytes: size, updatedAt: m.updatedAt || m.createdAt };
    } catch { return null; }
  }).filter(Boolean).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  out(rows);
}
function stop(sid) {
  readMeta(sid);
  spawnSync('tmux', ['kill-session', '-t', tmuxName(sid)], { stdio: 'ignore' });
  writeMeta(sid, { status: 'stopped', busy: false });
  out({ ok: true });
}
function interrupt(sid) {
  const m = readMeta(sid);
  if (m.status !== 'running') die(`session not running (${m.status})`);
  // stream-json control request: stops the current turn, keeps the process and session alive
  const line = JSON.stringify({ type: 'control_request', request_id: crypto.randomBytes(4).toString('hex'), request: { subtype: 'interrupt' } }) + '\n';
  try { const fd = fs.openSync(path.join(dir(sid), 'in.fifo'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, line); fs.closeSync(fd); }
  catch (e) { die(e.message); }
  appendEvent(sid, { type: 'rcc_interrupt' });
  out({ ok: true });
}

// ---------- projects: read Claude Code's own history ----------
function projects() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return out([]);
  const byCwd = new Map();
  for (const enc of fs.readdirSync(CLAUDE_PROJECTS)) {
    const pdir = path.join(CLAUDE_PROJECTS, enc);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const f of fs.readdirSync(pdir).filter((x) => x.endsWith('.jsonl'))) {
      const file = path.join(pdir, f);
      const st = fs.statSync(file);
      const head = readHead(file, 256 * 1024);
      let cwd = null, title = null, branch = null, summary = null;
      for (const line of head.split('\n')) {
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'summary' && ev.summary) summary = ev.summary;
        if (!cwd && ev.cwd) cwd = ev.cwd;
        if (!branch && ev.gitBranch) branch = ev.gitBranch;
        if (!title && ev.type === 'user' && !ev.isMeta) title = textOf(ev.message?.content);
        if (cwd && title) break;
      }
      cwd = cwd || enc;
      if (!byCwd.has(cwd)) byCwd.set(cwd, { cwd, name: path.basename(cwd), exists: fs.existsSync(cwd), sessions: [] });
      byCwd.get(cwd).sessions.push({ id: f.replace(/\.jsonl$/, ''), title: (summary || title || '(无标题)').slice(0, 80), branch, updatedAt: st.mtime.toISOString(), bytes: st.size });
    }
  }
  const rows = [...byCwd.values()].map((p) => {
    p.sessions.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    p.updatedAt = p.sessions[0]?.updatedAt;
    const r = spawnSync('git', ['-C', p.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    p.gitBranch = r.status === 0 ? r.stdout.trim() : null;
    return p;
  }).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  out(rows);
}
function readHead(file, max) {
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
  fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); return buf.toString('utf8');
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return null;
}


// ---------- accounts: one Claude config dir + one browser profile per account ----------
const ACC_ROOT = path.join(ROOT, 'accounts');
const ACC_FILE = path.join(ROOT, 'accounts.json');
const SHARED = ['projects', 'CLAUDE.md', 'settings.json', 'agents', 'commands', 'skills', 'plugins'];
function accLoad() {
  let st; try { st = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch { st = null; }
  if (!st || !st.accounts) st = { active: 'default', order: ['default'], accounts: { default: { name: '默认', createdAt: new Date().toISOString() } } };
  st.order = st.order.filter((id) => st.accounts[id]);
  for (const id of Object.keys(st.accounts)) if (!st.order.includes(id)) st.order.push(id);
  if (!st.accounts[st.active]) st.active = st.order[0];
  return st;
}
function accSave(st) { fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify(st, null, 2)); fs.renameSync(ACC_FILE + '.tmp', ACC_FILE); }
const accCfg = (id) => (id === 'default' ? null : path.join(ACC_ROOT, id, 'claude'));
const accProfile = (id) => (id === 'default' ? path.join(ROOT, 'chromium') : path.join(ACC_ROOT, id, 'chromium'));
function accId(a) {
  const st = accLoad();
  const id = a && a.account ? String(a.account) : st.active;
  if (!st.accounts[id]) die(`no such account: ${id}`);
  return id;
}
function accEnsure(id) {
  const cfg = accCfg(id);
  if (!cfg) return;
  fs.mkdirSync(cfg, { recursive: true });
  const home = path.join(os.homedir(), '.claude');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  // share history, memory and settings with every account so sessions resume under any of them
  for (const n of SHARED) {
    const src = path.join(home, n), dst = path.join(cfg, n);
    if (!fs.existsSync(src)) continue;
    try { const l = fs.lstatSync(dst); if (l.isSymbolicLink()) continue; if (n === 'projects' && l.isDirectory() && !fs.readdirSync(dst).length) fs.rmdirSync(dst); else continue; } catch { /* missing */ }
    try { fs.symlinkSync(src, dst); } catch { /* ignore */ }
  }
}
const accEnv = (id) => { const c = accCfg(id); return c ? { CLAUDE_CONFIG_DIR: c } : {}; };
const accEnvStr = (id) => { const c = accCfg(id); return c ? `CLAUDE_CONFIG_DIR=${shq(c)}` : ''; };
function authStatus(id = accId()) {
  accEnsure(id);
  const r = spawnSync(CLAUDE, ['auth', 'status', '--json'], { encoding: 'utf8', env: { ...process.env, ...accEnv(id) } });
  try { return JSON.parse(r.stdout); } catch { return { loggedIn: false, raw: (r.stdout || r.stderr || '').trim() }; }
}
async function accUsage(id) {
  // best effort: the same usage endpoint Claude Code's /usage reads, with this account's own token
  const dirp = accCfg(id) || path.join(os.homedir(), '.claude');
  let tok; try { tok = JSON.parse(fs.readFileSync(path.join(dirp, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken; } catch { return null; }
  if (!tok) return null;
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pick = (w) => (w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: w.resets_at || w.resetsAt || null } : null);
    return { fiveHour: pick(j.five_hour), sevenDay: pick(j.seven_day) };
  } catch { return null; }
}
async function accounts(a) {
  const st = accLoad();
  const rows = await Promise.all(st.order.map(async (id) => {
    const s = authStatus(id);
    const acc = st.accounts[id];
    const lim = acc.limitedUntil && acc.limitedUntil * 1000 > Date.now() ? acc.limitedUntil : null;
    return {
      id, name: acc.name, active: id === st.active, loggedIn: !!s.loggedIn,
      email: s.email || s.account?.email || s.emailAddress || null,
      plan: s.subscriptionType || s.plan || s.account?.subscriptionType || null,
      org: s.orgName || s.organizationName || null,
      limitedUntil: lim, limitType: lim ? acc.limitType || null : null,
      usage: a.usage && s.loggedIn ? await accUsage(id) : null,
    };
  }));
  accSave(st);
  out({ active: st.active, accounts: rows });
}
function accountAdd(a) {
  const st = accLoad();
  const id = crypto.randomBytes(3).toString('hex');
  st.accounts[id] = { name: String(a.name || `账号 ${st.order.length + 1}`), createdAt: new Date().toISOString() };
  st.order.push(id); accSave(st); accEnsure(id);
  out({ id });
}
function accountSet(id, patch) {
  const st = accLoad();
  if (!st.accounts[id]) die(`no such account: ${id}`);
  Object.assign(st.accounts[id], patch); accSave(st); out({ ok: true });
}
function accountUse(id) { const st = accLoad(); if (!st.accounts[id]) die(`no such account: ${id}`); st.active = id; accSave(st); out({ ok: true, active: id }); }
function accountOrder(list) { const st = accLoad(); const ids = String(list || '').split(',').filter((x) => st.accounts[x]); st.order = [...ids, ...st.order.filter((x) => !ids.includes(x))]; accSave(st); out({ ok: true }); }
function accountRemove(id) {
  const st = accLoad();
  if (!st.accounts[id]) die(`no such account: ${id}`);
  if (id === 'default') die('默认账号不能删除，可以退出登录');
  try { stopScreen(id); } catch { /* ignore */ }
  delete st.accounts[id]; accSave(st);
  fs.rmSync(path.join(ACC_ROOT, id), { recursive: true, force: true });
  out({ ok: true });
}
function markLimited(id, until, type) {
  try { const st = accLoad(); if (!st.accounts[id]) return; st.accounts[id].limitedUntil = until || Math.floor(Date.now() / 1000) + 3600; st.accounts[id].limitType = type || null; accSave(st); } catch { /* ignore */ }
}

// ---------- per-account VPS screens: Xvnc + matchbox + Chromium (kiosk, CDP) behind one websockify ----------
// Each account gets its own display, so several accounts' browsers can be open at once. The client draws
// the screen itself (no noVNC page) and drives the browser through the Chrome DevTools Protocol.
const WEB_PORT = Number(process.env.RCC_NOVNC_PORT || 6099);
const TOKENS = path.join(ROOT, 'vnc-tokens');
const LOGIN_LOG = () => path.join(ROOT, 'login.log');
const dlog = (n) => path.join(ROOT, `desktop-${n}.log`);
const tcpUp = (port) => spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: 'ignore' }).status === 0;
const waitPort = (port, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (tcpUp(port)) return true; spawnSync('sleep', ['0.25']); } return tcpUp(port); };
const keep = (cmd, name) => `${cmd} >${shq(dlog(name))} 2>&1; echo "[exited $?]" >>${shq(dlog(name))}; sleep 86400`;
const logTail = (n) => { try { return fs.readFileSync(dlog(n), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return '(no log)'; } };
function accSlot(id) {
  const st = accLoad();
  if (typeof st.accounts[id].slot === 'number') return st.accounts[id].slot;
  const used = new Set(Object.values(st.accounts).map((x) => x.slot).filter((x) => typeof x === 'number'));
  let n = 0; while (used.has(n)) n++;
  st.accounts[id].slot = n; accSave(st);
  return n;
}
function deskOf(id) { const s = accSlot(id); return { display: `:${110 + s}`, vnc: 7110 + s, cdp: 9310 + s, session: `rcc-desk-${id}`, downloads: path.join(id === 'default' ? ROOT : path.join(ACC_ROOT, id), 'downloads') }; }
function ensureProxy() {
  const st = accLoad();
  fs.writeFileSync(TOKENS, Object.keys(st.accounts).map((id) => `${id}: 127.0.0.1:${deskOf(id).vnc}`).join('\n') + '\n');
  const running = spawnSync('bash', ['-c', `pgrep -af websockify | grep -- '--token-source' | grep -q ':${WEB_PORT}'`]).status === 0;
  if (running && tcpUp(WEB_PORT)) return;
  // replace any older websockify on the port (earlier versions served the noVNC page there)
  spawnSync('tmux', ['kill-session', '-t', 'rcc-desktop'], { stdio: 'ignore' });
  spawnSync('tmux', ['kill-session', '-t', 'rcc-proxy'], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', `websockify .*${WEB_PORT}`], { stdio: 'ignore' });
  spawnSync('sleep', ['0.4']);
  const ws = ['websockify', '/usr/bin/websockify'].find((c) => spawnSync('which', [c]).status === 0);
  if (!ws) die('websockify 未安装，请先在“环境”里安装依赖');
  spawnSync('tmux', ['new-session', '-d', '-s', 'rcc-proxy', keep(`websockify --token-plugin TokenFile --token-source ${shq(TOKENS)} 127.0.0.1:${WEB_PORT}`, 'proxy')]);
  if (!waitPort(WEB_PORT, 8000)) die(`画面转发没起来：${logTail('proxy')}`);
}
function ensureScreen(id, o = {}) {
  const d = deskOf(id);
  if (tcpUp(d.vnc)) return d;
  const xvnc = spawnSync('which', ['Xvnc']).status === 0;
  if (!xvnc) die('Xvnc 未安装：请在“设置 → 环境”里点“安装/修复”（新版改用 TigerVNC，画面更清晰、支持中文剪贴板）');
  spawnSync('tmux', ['kill-session', '-t', d.session], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', `^Xvnc ${d.display} `], { stdio: 'ignore' });
  const n = d.display.slice(1);
  for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  const w = Math.max(640, Math.min(7680, Number(o.w) || 1600)), h = Math.max(480, Math.min(4320, Number(o.h) || 1000));
  spawnSync('tmux', ['new-session', '-d', '-s', d.session, '-n', 'x', keep(`Xvnc ${d.display} -geometry ${w}x${h} -depth 24 -rfbport ${d.vnc} -localhost -SecurityTypes None -AcceptSetDesktopSize=1 -AlwaysShared -SendCutText=1 -AcceptCutText=1 -SendPrimary=0 -BlacklistThreshold=1000000 -BlacklistTimeout=0 -nolisten tcp`, `x-${id}`)]);
  const end = Date.now() + 8000;
  while (Date.now() < end && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) spawnSync('sleep', ['0.2']);
  const wm = spawnSync('which', ['matchbox-window-manager']).status === 0 ? 'matchbox-window-manager -use_titlebar no -use_cursor yes' : 'sleep 86400';
  spawnSync('tmux', ['new-window', '-d', '-t', d.session, '-n', 'wm', `env DISPLAY=${d.display} ${wm}`]);
  if (!waitPort(d.vnc, 8000)) die(`VPS 画面没起来：${logTail(`x-${id}`)}`);
  return d;
}
function chromeBin() {
  const c = ['chromium', 'chromium-browser', 'google-chrome'].find((x) => spawnSync('which', [x]).status === 0);
  if (!c) die('chromium 未安装');
  return c;
}
// downloads land in a per-account folder the client can list and pull back
function prepProfile(profile, downloads) {
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  const pf = path.join(profile, 'Default', 'Preferences');
  let p = {}; try { p = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { /* new */ }
  p.download = { ...(p.download || {}), default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
  p.savefile = { ...(p.savefile || {}), default_directory: downloads };
  p.profile = { ...(p.profile || {}), exit_type: 'Normal', exited_cleanly: true };
  try { fs.writeFileSync(pf, JSON.stringify(p)); } catch { /* ignore */ }
}
function browserFor(id, scale) {
  const d = deskOf(id);
  const profile = accProfile(id);
  const script = path.join(ROOT, `rcc-browser-${id}`);
  const sf = Math.max(1, Math.min(3, Number(scale) || 1));
  fs.writeFileSync(script, `#!/bin/sh\nexec ${chromeBin()} --no-sandbox --test-type --no-first-run --hide-crash-restore-bubble --disable-session-crashed-bubble --disable-features=Translate,DownloadBubble --no-default-browser-check --password-store=basic --kiosk --force-device-scale-factor=${sf} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${d.cdp} --remote-allow-origins=* --user-data-dir=${shq(profile)} "$@"\n`, { mode: 0o755 });
  // what `claude auth login` calls to open the sign-in page: open it as a tab of this account's browser
  const opener = path.join(ROOT, `rcc-open-${id}`);
  fs.writeFileSync(opener, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(SELF)} desk-open --account ${shq(id)} --url "$1"\n`, { mode: 0o755 });
  return { script, opener, profile, d, sf };
}
const deskState = (id) => path.join(ROOT, `desk-${id}.json`);
async function cdpNewTab(port, url) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; }
}
async function ensureBrowser(id, o = {}) {
  const { script, profile, d, sf } = browserFor(id, o.scale);
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(deskState(id), 'utf8')); } catch { /* none */ }
  let up = tcpUp(d.cdp);
  if (up && o.scale && !o.softScale && prev.scale && Number(prev.scale) !== sf) { stopBrowser(id); up = false; }
  if (up) { if (o.url) await cdpNewTab(d.cdp, o.url); return d; }
  prepProfile(profile, d.downloads);
  spawnSync('tmux', ['kill-window', '-t', `${d.session}:browser`], { stdio: 'ignore' });
  spawnSync('tmux', ['new-window', '-d', '-t', d.session, '-n', 'browser', `env DISPLAY=${d.display} ${shq(script)} ${shq(o.url || 'https://claude.ai/new')} >${shq(dlog(`browser-${id}`))} 2>&1`]);
  fs.writeFileSync(deskState(id), JSON.stringify({ scale: sf, cdp: d.cdp, startedAt: Date.now() }));
  if (!waitPort(d.cdp, 15000)) die(`VPS 浏览器没起来：${logTail(`browser-${id}`)}`);
  return d;
}
function stopBrowser(id) {
  const profile = accProfile(id);
  const r = spawnSync('pgrep', ['-f', `user-data-dir=${profile}`], { encoding: 'utf8' });
  const killed = [];
  for (const pid of (r.stdout || '').split('\n').filter(Boolean)) {
    if (Number(pid) === process.pid) continue;
    let cmdline = ''; try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmdline.includes(`user-data-dir=${profile}\0`) || !/chrom/i.test(cmdline.split('\0')[0])) continue;
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ }
    killed.push(Number(pid));
  }
  // wait until the old browser has really let go of its profile and port; a new one started
  // too early finds the profile locked, hands over to the dying process and vanishes with it
  const alive = () => killed.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  for (let i = 0; i < 40 && alive().length; i++) spawnSync('sleep', ['0.15']);
  for (const p of alive()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  const port = deskOf(id).cdp;
  for (let i = 0; i < 20 && tcpUp(port); i++) spawnSync('sleep', ['0.15']);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.rmSync(path.join(profile, f), { force: true }); } catch { /* none */ } }
}
function stopScreen(id) {
  stopBrowser(id);
  const d = deskOf(id);
  spawnSync('tmux', ['kill-session', '-t', d.session], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', `^Xvnc ${d.display} `], { stdio: 'ignore' });
}
const deskOut = (id, d) => ({ ok: true, account: id, webPort: WEB_PORT, token: id, cdpPort: d.cdp, downloads: d.downloads });
async function desk(a) {
  const id = accId(a);
  accEnsure(id);
  ensureProxy();
  const d = ensureScreen(id, a);
  await ensureBrowser(id, { url: a.url ? String(a.url) : null, scale: a.scale, softScale: !!a['soft-scale'] });
  out(deskOut(id, d));
}
async function deskOpen(a) {
  const id = accId(a);
  ensureProxy(); ensureScreen(id);
  await ensureBrowser(id, { url: String(a.url || 'https://claude.ai/new') });
  out({ ok: true });
}
function deskStop(a) {
  const st = accLoad();
  const ids = a.all ? Object.keys(st.accounts) : [accId(a)];
  for (const id of ids) stopScreen(id);
  if (a.all) { spawnSync('tmux', ['kill-session', '-t', 'rcc-proxy'], { stdio: 'ignore' }); spawnSync('tmux', ['kill-session', '-t', 'rcc-login'], { stdio: 'ignore' }); }
  out({ ok: true });
}
function deskList() {
  const st = accLoad();
  out({ screens: Object.keys(st.accounts).map((id) => { const d = deskOf(id); return { account: id, screen: tcpUp(d.vnc), browser: tcpUp(d.cdp) }; }) });
}
function downloads(a) {
  const d = deskOf(accId(a));
  let files = [];
  try {
    files = fs.readdirSync(d.downloads).filter((f) => !/\.(crdownload|tmp)$/.test(f) && !f.startsWith('.')).map((f) => {
      const s = fs.statSync(path.join(d.downloads, f));
      return s.isFile() ? { name: f, path: path.join(d.downloads, f), size: s.size, mtime: s.mtimeMs } : null;
    }).filter(Boolean).sort((x, y) => y.mtime - x.mtime);
  } catch { /* none yet */ }
  const partial = (() => { try { return fs.readdirSync(d.downloads).filter((f) => /\.crdownload$/.test(f)).length; } catch { return 0; } })();
  out({ dir: d.downloads, files, partial });
}
async function loginStart(a) {
  const id = accId(a);
  accEnsure(id);
  ensureProxy();
  const d = ensureScreen(id, a);
  const { opener } = browserFor(id, a.scale);
  await ensureBrowser(id, { scale: a.scale });
  fs.writeFileSync(LOGIN_LOG(), '');
  try { fs.rmSync(path.join(ROOT, 'login.code-sent')); } catch { /* none */ }
  spawnSync('tmux', ['kill-session', '-t', 'rcc-login'], { stdio: 'ignore' });
  const flags = a.console ? ' --console' : '';
  const envs = `DISPLAY=${d.display} BROWSER=${shq(opener)} HOME=${shq(os.homedir())} PATH=${shq(process.env.PATH)} ${accEnvStr(id)}`;
  spawnSync('tmux', ['new-session', '-d', '-s', 'rcc-login', `env ${envs} ${shq(CLAUDE)} auth login${flags} 2>&1 | tee -a ${shq(LOGIN_LOG())}; sleep 3600`]);
  fs.writeFileSync(path.join(ROOT, 'login.account'), id);
  // if claude could not launch the opener itself, open the sign-in page ourselves
  let url = null;
  const end = Date.now() + 10000;
  while (Date.now() < end && !(url = loginUrlFromLog())) spawnSync('sleep', ['0.3']);
  spawnSync('sleep', ['1.2']);
  if (url) {
    let pages = []; try { pages = await (await fetch(`http://127.0.0.1:${d.cdp}/json`, { signal: AbortSignal.timeout(3000) })).json(); } catch { /* ignore */ }
    if (!pages.some((p) => p.type === 'page' && /oauth|authorize|login/i.test(p.url))) await cdpNewTab(d.cdp, url);
  }
  out({ ...deskOut(id, d), loginUrl: url });
}
function loginUrlFromLog() {
  const log = fs.existsSync(LOGIN_LOG()) ? fs.readFileSync(LOGIN_LOG(), 'utf8') : '';
  return (log.match(/https:\/\/[^\s\u0007\u001b]+/) || [null])[0];
}
// the sign-in page ends on a callback page that shows a code; read it straight from the browser and submit it
async function autoCode(id) {
  const sent = path.join(ROOT, 'login.code-sent');
  if (fs.existsSync(sent)) return 'sent';
  let pages = []; try { pages = await (await fetch(`http://127.0.0.1:${deskOf(id).cdp}/json`, { signal: AbortSignal.timeout(2500) })).json(); } catch { return null; }
  for (const p of pages) {
    if (p.type !== 'page' || !/\/oauth\/code\/callback/.test(p.url || '')) continue;
    let u; try { u = new URL(p.url); } catch { continue; }
    const code = u.searchParams.get('code'), state = u.searchParams.get('state');
    if (!code) continue;
    const c = state ? `${code}#${state}` : code;
    spawnSync('tmux', ['send-keys', '-t', 'rcc-login', '-l', c]);
    spawnSync('tmux', ['send-keys', '-t', 'rcc-login', 'Enter']);
    fs.writeFileSync(sent, String(Date.now()));
    return 'sent';
  }
  return null;
}
async function loginStatus(a) {
  const log = fs.existsSync(LOGIN_LOG()) ? fs.readFileSync(LOGIN_LOG(), 'utf8') : '';
  let id; try { id = a.account ? accId(a) : (fs.readFileSync(path.join(ROOT, 'login.account'), 'utf8').trim() || accId()); } catch { id = accId(); }
  if (!accLoad().accounts[id]) id = accId();
  let st = authStatus(id);
  const code = st.loggedIn ? null : await autoCode(id);
  if (code === 'sent' && !st.loggedIn) { spawnSync('sleep', ['1']); st = authStatus(id); }
  out({ ...st, account: id, loginUrl: loginUrlFromLog(), codeSent: code === 'sent', loginLog: log.slice(-2000) });
}
function loginCode(code) {
  const c = (code || '').trim();
  if (!c || /\s/.test(c)) die('no authorization code found');
  spawnSync('tmux', ['send-keys', '-t', 'rcc-login', '-l', c]);
  spawnSync('tmux', ['send-keys', '-t', 'rcc-login', 'Enter']);
  out({ ok: true });
}
function loginStop() {
  spawnSync('tmux', ['kill-session', '-t', 'rcc-login'], { stdio: 'ignore' });
  out({ ok: true });
}
function logout(a) {
  const id = accId(a);
  spawnSync(CLAUDE, ['auth', 'logout'], { encoding: 'utf8', env: { ...process.env, ...accEnv(id) } });
  out({ ok: true });
}
function history(id) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) die('no history');
  for (const enc of fs.readdirSync(CLAUDE_PROJECTS)) {
    const f = path.join(CLAUDE_PROJECTS, enc, `${id}.jsonl`);
    if (fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f)); return; }
  }
  die(`session not found: ${id}`);
}

// ---------- main ----------
const a = parseArgs(process.argv.slice(2));
const [cmd, sid, ...rest] = a._;
fs.mkdirSync(SESS, { recursive: true });
switch (cmd) {
  case 'doctor': doctor(); break;
  case 'serve': case 'pair': {
    // phone access lives in rcc-serve.mjs next to this file
    const here = path.dirname(SELF);
    const srv = [path.join(here, 'rcc-serve.mjs'), path.join(here, 'rcc-serve')].find((f) => fs.existsSync(f));
    if (!srv) die('rcc-serve.mjs 不在 rcc 旁边；在电脑端点一次「开启手机端」或运行 vps-setup/install.sh');
    const args = cmd === 'pair' ? ['pair', '--force-qr', ...process.argv.slice(3)] : process.argv.slice(3);
    const r = spawnSync(process.execPath, [srv, ...args], { stdio: 'inherit', env: { ...process.env, RCC_BIN: SELF } });
    process.exit(r.status ?? 1);
  }
  case 'start': start(a); break;
  case 'run': await run(sid); break;
  case 'send': send(sid, readStdin(), a); break;
  case 'tail': await tail(sid, a); break;
  case 'answer': answer(sid, rest[0], rest[1], rest.slice(2).join(' '), a.rule); break;
  case 'mcp': await mcp(sid); break;
  case 'list': list(); break;
  case 'stop': stop(sid); break;
  case 'interrupt': interrupt(sid); break;
  case 'projects': projects(); break;
  case 'history': history(sid); break;
  case 'auth': out(authStatus(accId(a))); break;
  case 'accounts': await accounts(a); break;
  case 'account-add': accountAdd(a); break;
  case 'account-rename': accountSet(sid, { name: String(a.name || '') }); break;
  case 'account-clear-limit': accountSet(sid, { limitedUntil: null, limitType: null }); break;
  case 'account-use': accountUse(sid); break;
  case 'account-order': accountOrder(sid); break;
  case 'account-remove': accountRemove(sid); break;
  case 'desk': await desk(a); break;
  case 'browse': await desk(a); break;
  case 'desk-open': await deskOpen(a); break;
  case 'desk-stop': deskStop(a); break;
  case 'browser-close': deskStop(a); break;
  case 'desk-list': deskList(); break;
  case 'downloads': downloads(a); break;
  case 'upload-dir': { const u = path.join(ROOT, 'uploads', new Date().toISOString().slice(0, 10)); fs.mkdirSync(u, { recursive: true }); out({ dir: u }); break; }
  case 'logout': logout(a); break;
  case 'login-start': await loginStart(a); break;
  case 'login-status': await loginStatus(a); break;
  case 'login-code': loginCode(sid); break;
  case 'login-stop': loginStop(); break;
  default: die('usage: rcc doctor|start|send|tail|answer|interrupt|stop|list|projects');
}
