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

export class Remote {
  ssh = new Ssh();
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
    try {
      await this.ssh.connect({
        host: cfg.host, port: cfg.port, username: cfg.username,
        ...(cfg.auth === 'key' ? { privateKey: sec.privateKey, passphrase: sec.passphrase || undefined } : { password: sec.password }),
      });
      this.webPortLocal = null; this.cdpLocal.clear(); this.servePortCache = null; this.onReconnect?.();
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
    this.setState({ state: 'idle' });
  }

  // ---------- environment ----------
  async doctor(): Promise<Doctor> {
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
    if (!this.servePortCache) { const st = await this.rccJson<MobileStatus>('serve status'); this.servePortCache = st.port || 7788; }
    return this.servePortCache;
  }
  mobileStatus = () => this.rccJson<MobileStatus>('serve status');
  /** Upload the phone app (only files that changed) and start rcc serve. */
  async mobileEnable() {
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
    await this.rcc('serve start', undefined, 30000);
    return this.mobileStatus();
  }
  async mobileDisable() { await this.rcc('serve stop'); return this.mobileStatus(); }
  mobileTailscale = () => this.rccJson<MobileStatus['tailscale'] & { step: string; detail?: string }>('serve tailscale', undefined, 360000);
  mobilePair = (base?: string) => this.rccJson<{ code: string; expiresAt: number; url: string | null; base: string | null }>(`serve pair${base ? ` --base ${q(base)}` : ''}`);
  async mobileRevoke(id: string) { await this.rcc(`serve revoke ${q(id)}`); }
  async mobileSetUrl(url: string) { await this.rcc(`serve url ${q(url)}`); }

  private async rcc(args: string, stdin?: string, timeoutMs?: number): Promise<string> {
    const r = await this.ssh.exec(`${ENV} node ~/.local/bin/rcc ${args}`, stdin, timeoutMs);
    if (r.code !== 0) {
      let msg = r.stderr.trim();
      try { msg = JSON.parse(msg).error; } catch { /* plain text */ }
      throw new Error(msg || `rcc ${args.split(' ')[0]} 失败`);
    }
    return r.stdout;
  }
  private async rccJson<T>(args: string, stdin?: string, timeoutMs?: number): Promise<T> { return JSON.parse(await this.rcc(args, stdin, timeoutMs)) as T; }

  // ---------- projects & sessions ----------
  projects = () => this.rccJson<Project[]>('projects');
  live = () => this.rccJson<LiveSession[]>('list');
  async history(id: string) {
    const raw = await this.rcc(`history ${q(id)}`, undefined, 60000);
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  async start(o: StartOptions) {
    const a = [`--cwd ${q(o.cwd)}`];
    if (o.model) a.push(`--model ${q(o.model)}`);
    if (o.effort) a.push(`--effort ${q(o.effort)}`);
    if (o.permissionMode) a.push(`--permission-mode ${q(o.permissionMode)}`);
    if (o.resume) a.push(`--resume ${q(o.resume)}`);
    if (o.worktree) a.push(`--worktree ${q(o.worktree)}`, `--base ${q(o.base || 'HEAD')}`);
    if (o.title) a.push(`--title ${q(o.title)}`);
    if (o.mkdir) a.push('--mkdir');
    if (o.account) a.push(`--account ${q(o.account)}`);
    return this.rccJson<{ sid: string; cwd: string }>(`start ${a.join(' ')}`);
  }
  async send(sid: string, text: string, files?: { local: string; name: string; mime: string }[]) {
    if (!files?.length) { await this.rcc(`send ${q(sid)}`, text); return; }
    const dir = await this.uploadDir();
    const up: { path: string; name: string; mime: string }[] = [];
    for (const f of files) {
      const rp = `${dir}/${Date.now().toString(36)}-${f.name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')}`;
      await this.ssh.putFile(f.local, rp);
      up.push({ path: rp, name: f.name, mime: f.mime });
    }
    await this.rcc(`send ${q(sid)} --json`, JSON.stringify({ text, files: up }));
  }
  async answer(sid: string, req: string, decision: string, message?: string) {
    await this.rcc(`answer ${q(sid)} ${q(req)} ${q(decision)}${message ? ' ' + q(message) : ''}`);
  }
  async interrupt(sid: string) { await this.rcc(`interrupt ${q(sid)}`); }
  async stop(sid: string) { await this.rcc(`stop ${q(sid)}`); }

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

  // ---------- login through a browser running on the VPS ----------
  authStatus = (account?: string) => this.rccJson<AuthStatus>(`login-status${account ? ` --account ${q(account)}` : ''}`);
  // ---------- per-account VPS screens ----------
  private webPortLocal: number | null = null;
  private cdpLocal = new Map<string, { remote: number; local: number }>();
  async deskOpen(account: string, o: { w?: number; h?: number; scale?: number; url?: string; login?: boolean }): Promise<DeskOpen> {
    const args = [o.login ? 'login-start' : 'desk', `--account ${q(account)}`];
    if (o.w && o.h) args.push(`--w ${Math.round(o.w)} --h ${Math.round(o.h)}`);
    if (o.scale) args.push(`--scale ${Math.round(o.scale * 100) / 100}`);
    if (o.url) args.push(`--url ${q(o.url)}`);
    const r = await this.rccJson<{ webPort: number; token: string; cdpPort: number; downloads: string; loginUrl?: string }>(args.join(' '));
    if (!this.webPortLocal) this.webPortLocal = await this.ssh.forward(r.webPort);
    const have = this.cdpLocal.get(account);
    if (!have || have.remote !== r.cdpPort) this.cdpLocal.set(account, { remote: r.cdpPort, local: await this.ssh.forward(r.cdpPort) });
    return { wsUrl: `ws://127.0.0.1:${this.webPortLocal}/websockify?token=${encodeURIComponent(r.token)}`, downloads: r.downloads, loginUrl: r.loginUrl || null };
  }
  async cdpPort(account: string) {
    const have = this.cdpLocal.get(account);
    if (have) return have.local;
    throw new Error('这个账号的 VPS 浏览器还没打开');
  }
  async deskStop(account: string) { await this.rcc(`desk-stop --account ${q(account)}`); }
  deskDownloads = (account: string) => this.rccJson<DeskDownloads>(`downloads --account ${q(account)}`);
  async uploadDir() { return (await this.rccJson<{ dir: string }>('upload-dir')).dir; }
  accounts = (usage?: boolean) => this.rccJson<{ active: string; accounts: Account[] }>(`accounts${usage ? ' --usage' : ''}`);
  accountAdd = (name: string) => this.rccJson<{ id: string }>(`account-add --name ${q(name)}`);
  async accountCmd(cmd: string, id: string, name?: string) { await this.rcc(`${cmd} ${q(id)}${name !== undefined ? ` --name ${q(name)}` : ''}`); }
  async loginCode(code?: string) { await this.rcc(`login-code${code ? ' ' + q(code) : ''}`); }
  async loginStop() { await this.rcc('login-stop'); }
  async logout(account?: string) { await this.rcc(`logout${account ? ` --account ${q(account)}` : ''}`); }
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
