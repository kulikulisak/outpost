// Everything that happens on the VPS goes through here: connect, install, the rcc helper,
// live session streams, and the browser login.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Ssh } from './ssh';
import { secrets, servers } from './store';
import type { MobileStatus, Account, AuthStatus, DeskDownloads, DeskOpen, ConnState, Doctor, LiveSession, Project, StartOptions } from '../shared/types';

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ENV = 'export PATH="$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin:$PATH";';
const resDir = () => app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(app.getAppPath(), 'resources');
const resource = (n: string) => fs.readFileSync(path.join(resDir(), n));

type Emit = (channel: string, data: unknown) => void;

interface Sub { offset: number; stop?: () => void; active: boolean; pending: string; queue: any[]; timer?: NodeJS.Timeout }

/** A server reached through its web address (Docker / Zeabur): every call goes to rcc serve over HTTPS. */
export class WebLink {
  constructor(public base: string, public token: string) { this.base = base.replace(/\/+$/, ''); }
  get wsBase() { return this.base.replace(/^http/, 'ws'); }
  async req(p: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const r = await fetch(this.base + p, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(init.timeoutMs ?? 90000) });
    if (r.status === 401) throw new Error('这台电脑的配对已失效，请在服务器设置里重新配对');
    if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error || m; } catch { /* not json */ } throw new Error(m); }
    return r;
  }
  async json<T>(p: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const r = await this.req(p, body === undefined ? { timeoutMs } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs });
    return r.json() as Promise<T>;
  }
  async rcc(argv: string[], stdin?: string, timeoutMs = 60000): Promise<string> {
    return (await this.json<{ stdout: string }>('/api/rcc', { argv, stdin, timeout: timeoutMs }, timeoutMs + 5000)).stdout;
  }
  static async pair(base: string, code: string, name: string): Promise<{ token: string; server?: string }> {
    const r = await fetch(base.replace(/\/+$/, '') + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(20000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `配对失败（${r.status}）`);
    return j;
  }
}

export class Remote {
  ssh = new Ssh();
  web: WebLink | null = null;
  state: ConnState = { state: 'idle' };
  private subs = new Map<string, Sub>();
  onReconnect?: () => void;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private emit: Emit) {
    this.ssh.on('lost', (msg: string) => {
      const id = 'serverId' in this.state ? this.state.serverId : '';
      this.setState({ state: 'error', serverId: id, message: `连接断开：${msg}，正在重连…` });
      this.scheduleReconnect(id);
    });
  }

  private setState(s: ConnState) { this.state = s; this.emit('conn', s); }

  private scheduleReconnect(id: string) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(id).catch(() => this.scheduleReconnect(id)), 3000);
  }

  async connect(id: string): Promise<ConnState> {
    clearTimeout(this.reconnectTimer);
    const cfg = servers.list().find((s) => s.id === id);
    if (!cfg) throw new Error('找不到这台服务器');
    const sec = secrets.get(id) || {};
    this.setState({ state: 'connecting', serverId: id });
    if (cfg.kind === 'url') {
      try {
        if (!sec.token) throw new Error('这台服务器还没配对');
        this.ssh.close();
        this.web = new WebLink(cfg.url || '', sec.token);
        this.cdpLocal.clear(); this.onReconnect?.();
        const t0 = Date.now();
        await this.web.json('/api/me');
        this.setState({ state: 'connected', serverId: id, latencyMs: Date.now() - t0 });
        for (const [sid, sub] of this.subs) if (sub.active) this.openStream(sid, sub);
        return this.state;
      } catch (e: any) {
        const msg = /fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(String(e?.message)) ? `连不上 ${cfg.url}：检查网址和网络` : String(e?.message || e);
        this.setState({ state: 'error', serverId: id, message: msg });
        throw new Error(msg);
      }
    }
    this.web = null;
    try {
      await this.ssh.connect({
        host: cfg.host, port: cfg.port, username: cfg.username,
        ...(cfg.auth === 'key' ? { privateKey: sec.privateKey, passphrase: sec.passphrase || undefined } : { password: sec.password }),
      });
      this.webPortLocal = null; this.cdpLocal.clear(); this.servePortCache = null; this.previewLocal = null; this.onReconnect?.();
      const t0 = Date.now();
      await this.ssh.exec('true');
      this.setState({ state: 'connected', serverId: id, latencyMs: Date.now() - t0 });
      await this.ensureAgent().catch(() => { /* node may be missing until the installer runs */ });
      // resume any streams the renderer was watching before the drop
      for (const [sid, sub] of this.subs) if (sub.active) this.openStream(sid, sub);
      return this.state;
    } catch (e: any) {
      this.setState({ state: 'error', serverId: id, message: friendlySshError(e) });
      throw new Error(friendlySshError(e));
    }
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    for (const s of this.subs.values()) s.stop?.();
    this.subs.clear();
    this.ssh.close();
    this.web = null;
    this.setState({ state: 'idle' });
  }

  // ---------- environment ----------
  async doctor(): Promise<Doctor> {
    if (this.web) return JSON.parse(await this.web.rcc(['doctor'], undefined, 30000));
    const script = `${ENV}
v() { command -v "$1" >/dev/null 2>&1 && "$@" 2>&1 | head -1 || echo; }
echo "node=$(v node --version)"
echo "tmux=$(v tmux -V)"
echo "git=$(v git --version)"
echo "claude=$(v claude --version)"
echo "auth=$(command -v claude >/dev/null && claude auth status --json 2>/dev/null | tr -d '\\n')"
echo "chromium=$(v chromium --version || true)$( [ -z "$(command -v chromium)" ] && v chromium-browser --version)"
echo "xvnc=$(command -v Xvnc >/dev/null && echo 1)"
echo "wm=$(command -v matchbox-window-manager >/dev/null && echo 1)"
echo "websockify=$(command -v websockify >/dev/null && echo 1)"`;
    const r = await this.ssh.exec('bash -s', script, 30000);
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
    let loggedIn = false;
    try { loggedIn = !!JSON.parse(kv.auth || '{}').loggedIn; } catch { /* ignore */ }
    return { node: kv.node || null, tmux: kv.tmux || null, git: kv.git || null, claude: kv.claude || null, loggedIn, chromium: kv.chromium || null, xvnc: kv.xvnc === '1', windowManager: kv.wm === '1', websockify: kv.websockify === '1' };
  }

  async install(opts: { cjkFonts?: boolean }) {
    if (this.web) { this.emit('env-log', { type: 'done', ok: true, msg: 'Docker 镜像里已经装好了，更新请在 Zeabur 里拉取最新镜像' }); return { ok: true }; }
    const script = resource('bootstrap.sh').toString('utf8');
    const env = opts.cjkFonts ? 'WITH_CJK_FONTS=1 ' : '';
    let pending = '';
    let ok = false;
    await new Promise<void>((resolve, reject) => {
      this.ssh.stream(`${ENV} env ${env}bash -s`,
        (b) => {
          pending += b.toString('utf8');
          let i;
          while ((i = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1);
            if (!line) continue;
            let ev: any; try { ev = JSON.parse(line); } catch { ev = { type: 'raw', msg: line }; }
            if (ev.type === 'done') ok = !!ev.ok;
            this.emit('env-log', ev);
          }
        },
        () => resolve(),
        (s) => this.emit('env-log', { type: 'stderr', msg: s.trim() }),
        script,
      ).catch(reject);
    });
    await this.ensureAgent();
    return { ok };
  }

  async ensureAgent() {
    if (this.web) return;
    const local = resource('rcc.mjs');
    const hash = crypto.createHash('sha256').update(local).digest('hex');
    const r = await this.ssh.exec(`${ENV} command -v node >/dev/null || echo NO_NODE; mkdir -p ~/.local/bin; sha256sum ~/.local/bin/rcc 2>/dev/null | cut -d' ' -f1`);
    if (r.stdout.includes('NO_NODE')) throw new Error('VPS 上还没有 Node.js，请先在“环境”里安装');
    if (r.stdout.trim() !== hash) {
      const home = (await this.ssh.exec('printf %s "$HOME"')).stdout.trim();
      await this.ssh.upload(local, `${home}/.local/bin/rcc`, 0o755);
    }
    // the phone server lives next to rcc
    const srv = resource('rcc-serve.mjs');
    const sh = crypto.createHash('sha256').update(srv).digest('hex');
    const r2 = await this.ssh.exec('sha256sum ~/.local/bin/rcc-serve.mjs 2>/dev/null | cut -d" " -f1');
    if (r2.stdout.trim() !== sh) {
      const home = (await this.ssh.exec('printf %s "$HOME"')).stdout.trim();
      await this.ssh.upload(srv, `${home}/.local/bin/rcc-serve.mjs`, 0o755);
    }
  }

  // ---------- phone access (rcc serve) ----------
  private servePortCache: number | null = null;
  async servePort() {
    if (!this.servePortCache) { const st = await this.rccJson<MobileStatus>(['serve', 'status']); this.servePortCache = st.port || 7788; }
    return this.servePortCache;
  }
  mobileStatus = () => this.rccJson<MobileStatus>(['serve', 'status']);
  /** Upload the phone app (only files that changed) and start rcc serve. */
  async mobileEnable() {
    if (this.web) return this.mobileStatus(); // the container already serves the phone app
    const root = path.join(resDir(), 'mobile-web');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(root, p)); } };
    walk(root);
    const home = (await this.ssh.exec('printf %s "$HOME"')).stdout.trim();
    const dest = `${home}/.rcc/mobile/web`;
    const have = (await this.ssh.exec(`mkdir -p ${q(dest)}/assets && cd ${q(dest)} && find . -type f -exec sha256sum {} + 2>/dev/null`)).stdout;
    const remote = new Map(have.split('\n').filter(Boolean).map((l) => { const [h, f] = l.split(/\s+/); return [f.replace(/^\.\//, ''), h]; }));
    for (const f of files) {
      const buf = fs.readFileSync(path.join(root, f));
      if (remote.get(f.split(path.sep).join('/')) === crypto.createHash('sha256').update(buf).digest('hex')) continue;
      await this.ssh.upload(buf, `${dest}/${f.split(path.sep).join('/')}`, 0o644);
    }
    // drop old hashed bundles
    const keep = new Set(files.map((f) => f.split(path.sep).join('/')));
    const stale = [...remote.keys()].filter((f) => f.startsWith('assets/') && !keep.has(f));
    if (stale.length) await this.ssh.exec(`cd ${q(dest)} && rm -f ${stale.map(q).join(' ')}`);
    await this.rcc(['serve', 'start'], undefined, 30000);
    return this.mobileStatus();
  }
  async mobileDisable() {
    if (this.web) throw new Error('网址连接时手机端由服务器本身提供，不能在这里关闭');
    await this.rcc(['serve', 'stop']); return this.mobileStatus(); }
  mobileTailscale = () => { if (this.web) throw new Error('网址连接时不需要 Tailscale'); return this.rccJson<MobileStatus['tailscale'] & { step: string; detail?: string }>(['serve', 'tailscale'], undefined, 360000); };
  mobilePair = (base?: string) => this.rccJson<{ code: string; expiresAt: number; url: string | null; base: string | null }>(['serve', 'pair', ...(base ? ['--base', base] : [])]);
  async mobileRevoke(id: string) { await this.rcc(['serve', 'revoke', id]); }
  async mobileSetUrl(url: string) { await this.rcc(['serve', 'url', url]); }

  private async rcc(argv: string[], stdin?: string, timeoutMs?: number): Promise<string> {
    if (this.web) return this.web.rcc(argv, stdin, timeoutMs);
    const r = await this.ssh.exec(`${ENV} node ~/.local/bin/rcc ${argv.map(q).join(' ')}`, stdin, timeoutMs);
    if (r.code !== 0) {
      let msg = r.stderr.trim();
      try { msg = JSON.parse(msg).error; } catch { /* plain text */ }
      throw new Error(msg || `rcc ${argv[0]} 失败`);
    }
    return r.stdout;
  }
  private async rccJson<T>(argv: string[], stdin?: string, timeoutMs?: number): Promise<T> { return JSON.parse(await this.rcc(argv, stdin, timeoutMs)) as T; }

  // ---------- projects & sessions ----------
  projects = () => this.rccJson<Project[]>(['projects']);
  live = () => this.rccJson<LiveSession[]>(['list']);
  async history(id: string) {
    const raw = await this.rcc(['history', id], undefined, 60000);
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  async start(o: StartOptions) {
    const a = ['start', '--cwd', o.cwd];
    if (o.model) a.push('--model', o.model);
    if (o.effort) a.push('--effort', o.effort);
    if (o.permissionMode) a.push('--permission-mode', o.permissionMode);
    if (o.resume) a.push('--resume', o.resume);
    if (o.worktree) a.push('--worktree', o.worktree, '--base', o.base || 'HEAD');
    if (o.title) a.push('--title', o.title);
    if (o.mkdir) a.push('--mkdir');
    if (o.account) a.push('--account', o.account);
    if (o.simple) a.push('--simple');
    if (o.browser === false) a.push('--no-browser');
    return this.rccJson<{ sid: string; cwd: string }>(a);
  }
  async send(sid: string, text: string, files?: { local: string; name: string; mime: string }[]) {
    if (!files?.length) { await this.rcc(['send', sid], text); return; }
    if (this.web) {
      // same path as the phone: the server strips photo metadata and stores the files
      const enc = files.map((f) => ({ name: f.name, mime: f.mime, data: fs.readFileSync(f.local).toString('base64') }));
      await this.web.json('/api/send', { sid, text, files: enc }, 180000);
      return;
    }
    const dir = await this.uploadDir();
    const up: { path: string; name: string; mime: string }[] = [];
    for (const f of files) {
      const rp = `${dir}/${Date.now().toString(36)}-${f.name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')}`;
      await this.ssh.putFile(f.local, rp);
      up.push({ path: rp, name: f.name, mime: f.mime });
    }
    await this.rcc(['send', sid, '--json'], JSON.stringify({ text, files: up }));
  }
  async answer(sid: string, req: string, decision: string, message?: string, answers?: Record<string, string>) {
    await this.rcc(['answer', sid, req, decision, ...(message ? [message] : []), ...(answers ? ['--answers', JSON.stringify(answers)] : [])]);
  }
  async interrupt(sid: string) { await this.rcc(['interrupt', sid]); }
  async stop(sid: string) { await this.rcc(['stop', sid]); }
  async restore(sid: string, ckpt: string) { await this.rcc(['restore', sid, ckpt]); }
  private previewLocal: { remote: number; local: number } | null = null;
  /** URL on this computer that shows the session's project folder (via an ssh tunnel to rcc's preview server). */
  async previewUrl(sid: string, page = '') {
    const enc = page.split('/').map(encodeURIComponent).join('/');
    if (this.web) return `${this.web.base}${(await this.web.json<{ url: string }>('/api/preview', { sid })).url}${enc}`;
    const r = await this.rccJson<{ port: number; base: string }>(['preview', sid]);
    if (!this.previewLocal || this.previewLocal.remote !== r.port) this.previewLocal = { remote: r.port, local: await this.ssh.forward(r.port) };
    return `http://127.0.0.1:${this.previewLocal.local}${r.base}${enc}`;
  }

  // ---------- live output, resumable by byte offset ----------
  subscribe(sid: string) {
    let sub = this.subs.get(sid);
    if (sub?.active) return;
    sub = { offset: 0, active: true, pending: '', queue: [] };
    this.subs.set(sid, sub);
    this.openStream(sid, sub);
  }
  unsubscribe(sid: string) {
    const sub = this.subs.get(sid);
    if (!sub) return;
    sub.active = false; sub.stop?.();
    this.subs.delete(sid);
  }
  private async openStream(sid: string, sub: Sub) {
    sub.stop?.();
    sub.pending = '';
    if (this.web) return this.openWebStream(sid, sub, this.web);
    try {
      sub.stop = await this.ssh.stream(`${ENV} node ~/.local/bin/rcc tail ${q(sid)} --from ${sub.offset} --follow`,
        (b) => {
          sub.pending += b.toString('utf8');
          let i;
          while ((i = sub.pending.indexOf('\n')) >= 0) {
            const line = sub.pending.slice(0, i); sub.pending = sub.pending.slice(i + 1);
            sub.offset += Buffer.byteLength(line, 'utf8') + 1;
            if (!line.trim()) continue;
            try { sub.queue.push(JSON.parse(line)); } catch { /* skip */ }
          }
          if (!sub.timer) sub.timer = setTimeout(() => {
            sub.timer = undefined;
            const events = sub.queue.splice(0);
            if (events.length) this.emit('session-events', { sid, events });
          }, 40);
        },
        () => { /* closed: session ended, or the connection dropped (reconnect re-opens) */ },
      );
    } catch { /* not connected; reconnect will retry */ }
  }

  /** Server-sent events from rcc serve (the phone's stream), reconnecting from the last offset. */
  private openWebStream(sid: string, sub: Sub, web: WebLink) {
    const ctl = new AbortController();
    let stopped = false;
    sub.stop = () => { stopped = true; ctl.abort(); };
    const run = async () => {
      while (!stopped && sub.active && this.web === web) {
        try {
          const r = await fetch(`${web.base}/api/events?sid=${encodeURIComponent(sid)}&from=${sub.offset}`, { headers: { Authorization: `Bearer ${web.token}`, Accept: 'text/event-stream' }, signal: ctl.signal });
          if (r.status === 404) return; // session gone
          if (!r.ok || !r.body) throw new Error(String(r.status));
          const dec = new TextDecoder();
          let buf = '';
          for await (const chunk of r.body as any) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (!data) continue;
              try {
                const m = JSON.parse(data) as { offset: number; events: any[] };
                sub.offset = m.offset;
                if (m.events?.length) this.emit('session-events', { sid, events: m.events });
              } catch { /* partial */ }
            }
          }
        } catch { if (stopped) return; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    };
    run();
  }

  // ---------- login through a browser running on the VPS ----------
  authStatus = (account?: string) => this.rccJson<AuthStatus>(['login-status', ...(account ? ['--account', account] : [])]);
  // ---------- per-account VPS screens ----------
  private webPortLocal: number | null = null;
  private cdpLocal = new Map<string, { remote: number; local: number }>();
  async deskOpen(account: string, o: { w?: number; h?: number; scale?: number; url?: string; login?: boolean }): Promise<DeskOpen> {
    const args = [o.login ? 'login-start' : 'desk', '--account', account];
    if (o.w && o.h) args.push('--w', String(Math.round(o.w)), '--h', String(Math.round(o.h)));
    if (o.scale) args.push('--scale', String(Math.round(o.scale * 100) / 100));
    if (o.url) args.push('--url', o.url);
    const r = await this.rccJson<{ webPort: number; token: string; cdpPort: number; downloads: string; loginUrl?: string }>(args);
    if (this.web) {
      this.cdpLocal.set(account, { remote: r.cdpPort, local: 0 });
      return { wsUrl: `${this.web.wsBase}/vnc?t=${encodeURIComponent(this.web.token)}&account=${encodeURIComponent(account)}`, downloads: r.downloads, loginUrl: r.loginUrl || null };
    }
    if (!this.webPortLocal) this.webPortLocal = await this.ssh.forward(r.webPort);
    const have = this.cdpLocal.get(account);
    if (!have || have.remote !== r.cdpPort) this.cdpLocal.set(account, { remote: r.cdpPort, local: await this.ssh.forward(r.cdpPort) });
    return { wsUrl: `ws://127.0.0.1:${this.webPortLocal}/websockify?token=${encodeURIComponent(r.token)}`, downloads: r.downloads, loginUrl: r.loginUrl || null };
  }
  /** Where the account's browser DevTools answer: an ssh tunnel on this computer, or rcc serve's /cdp proxy. */
  async cdpBase(account: string): Promise<{ http: string; ws: string }> {
    const have = this.cdpLocal.get(account);
    if (!have) throw new Error('这个账号的 VPS 浏览器还没打开');
    if (this.web) { const p = `/cdp/${encodeURIComponent(this.web.token)}/${encodeURIComponent(account)}`; return { http: this.web.base + p, ws: this.web.wsBase + p }; }
    return { http: `http://127.0.0.1:${have.local}`, ws: `ws://127.0.0.1:${have.local}` };
  }
  async deskStop(account: string) { await this.rcc(['desk-stop', '--account', account]); }
  deskDownloads = (account: string) => this.rccJson<DeskDownloads>(['downloads', '--account', account]);
  /** small JSON helpers on the server (link cards, @files, /commands, memory, schedules) */
  async x(argv: string[], stdin?: string) {
    const ok = ['unfurl', 'files', 'commands', 'memory', 'finfo', 'sched-list', 'sched-put', 'sched-remove', 'sched-run'];
    if (!ok.includes(argv[0])) throw new Error(`not allowed: ${argv[0]}`);
    return JSON.parse(await this.rcc(argv, stdin, 30000));
  }
  /** a dev server Claude started on the server (localhost:PORT), as a URL this computer can open */
  private portFwd = new Map<number, number>();
  async previewPortUrl(port: number, p = '/') {
    if (this.web) return `${this.web.base}${(await this.web.json<{ url: string }>('/api/preview', { port, path: p })).url}`;
    let local = this.portFwd.get(port);
    if (!local) { local = await this.ssh.forward(port); this.portFwd.set(port, local); }
    return `http://127.0.0.1:${local}${p.startsWith('/') ? p : '/' + p}`;
  }
  async uploadDir() { return (await this.rccJson<{ dir: string }>(['upload-dir'])).dir; }
  /** Copy a local file to the server (attachments for the VPS browser). */
  async putFile(local: string, remotePath: string) {
    if (this.web) { await this.web.req(`/api/file?path=${encodeURIComponent(remotePath)}`, { method: 'PUT', body: fs.readFileSync(local), timeoutMs: 600000 }); return; }
    await this.ssh.putFile(local, remotePath);
  }
  /** Copy a server file to this computer (downloads from the VPS browser). */
  async getFile(remotePath: string, local: string) {
    if (this.web) { const r = await this.web.req(`/api/file?path=${encodeURIComponent(remotePath)}`, { timeoutMs: 600000 }); fs.writeFileSync(local, Buffer.from(await r.arrayBuffer())); return; }
    await this.ssh.getFile(remotePath, local);
  }
  accounts = (usage?: boolean) => this.rccJson<{ active: string; accounts: Account[] }>(['accounts', ...(usage ? ['--usage'] : [])]);
  accountAdd = (name: string) => this.rccJson<{ id: string }>(['account-add', '--name', name]);
  async accountCmd(cmd: string, id: string, name?: string) { await this.rcc([cmd, id, ...(name !== undefined ? ['--name', name] : [])]); }
  async loginCode(code?: string) { await this.rcc(['login-code', ...(code ? [code] : [])]); }
  async loginStop() { await this.rcc(['login-stop']); }
  async logout(account?: string) { await this.rcc(['logout', ...(account ? ['--account', account] : [])]); }
}

function friendlySshError(e: any): string {
  const m = String(e?.message || e);
  if (/authentication methods failed/i.test(m)) return '认证失败：密钥或密码不对';
  if (/ECONNREFUSED/.test(m)) return '连接被拒绝：检查端口和防火墙';
  if (/ETIMEDOUT|Timed out/i.test(m)) return '连接超时：检查 IP 和网络';
  if (/ENOTFOUND/.test(m)) return '找不到主机：检查地址';
  if (/passphrase/i.test(m)) return '私钥需要密码短语';
  return m;
}
