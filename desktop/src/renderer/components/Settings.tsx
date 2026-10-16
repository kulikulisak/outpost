import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rc } from '../api';
import { Dropdown, I, Modal, QuotaAvatar, confirmDialog, resetText } from './ui';
import { ServerForm } from './ServerForm';
import { EFFORTS, MODELS, PERMS, prettyModel } from '../options';
import type { MobileStatus, RelayStatus, Account, AuthStatus, ConnState, Doctor, Prefs, ServerConfig, UpdateInfo } from '../../shared/types';

export type Page = 'server' | 'env' | 'account' | 'model' | 'phone' | 'look';
const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'server', label: '服务器', icon: I.server() },
  { id: 'env', label: '环境', icon: I.wrench() },
  { id: 'account', label: 'Claude 账号', icon: I.user() },
  { id: 'model', label: '模型与对话', icon: I.chat() },
  { id: 'phone', label: '手机', icon: I.phone() },
  { id: 'look', label: '外观', icon: I.sun() },
];

const Row = ({ t, sub, children }: { t: ReactNode; sub?: ReactNode; children?: ReactNode }) => (
  <div className="row"><div className="l"><b>{t}</b>{sub && <span>{sub}</span>}</div>{children}</div>
);
const Status = ({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) => (
  <div className="st"><span className={`sdot ${ok ? 'ok' : warn ? 'warn' : 'err'}`} />{children}</div>
);

export function SettingsNav({ page, setPage, onBack, serverName, dot }: { page: Page; setPage(p: Page): void; onBack(): void; serverName: string; dot: string }) {
  return (
    <aside className="side">
      <div className="titlespace drag" />
      <button className="back" onClick={onBack}>{I.back()} 返回对话</button>
      {NAV.map((n) => <button key={n.id} className={`nav ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}>{n.icon}{n.label}</button>)}
      <div style={{ flex: 1 }} />
      <div className="foot"><span className="srv"><span className={`sdot ${dot}`} /><span>{serverName}</span></span><span style={{ fontSize: 12, color: 'var(--faint)', paddingRight: 6 }}>v{__APP_VERSION__}</span></div>
    </aside>
  );
}

export function SettingsPage(p: {
  page: Page; conn: ConnState; servers: ServerConfig[]; prefs: Prefs; doctor: Doctor | null; auth: AuthStatus | null;
  resolved: Record<string, string>;
  reloadServers(): void; setPrefs(p: Partial<Prefs>): void; refreshDoctor(): Promise<void>;
  accounts: Account[]; refreshAccounts(usage?: boolean): Promise<void>;
  onLogin(a: Account): void; onBrowse(a: Account): void; onAddAccount(): void; onUseAccount(id: string): void;
}) {
  return (
    <div className="main">
      <div className="top drag" style={{ borderBottom: 'none' }} />
      <div className="pg" style={{ paddingTop: 0 }}>
        <div className="pc">
          {p.page === 'server' && <ServerPage {...p} />}
          {p.page === 'env' && <EnvPage {...p} />}
          {p.page === 'account' && <AccountPage {...p} />}
          {p.page === 'model' && <ModelPage {...p} />}
          {p.page === 'look' && <LookPage {...p} />}
          {p.page === 'phone' && <PhonePage conn={p.conn} />}
        </div>
      </div>
    </div>
  );
}

function ServerPage({ conn, servers, reloadServers }: Parameters<typeof SettingsPage>[0]) {
  const [edit, setEdit] = useState<ServerConfig | 'new' | null>(null);
  const [err, setErr] = useState('');
  const connectedId = conn.state !== 'idle' ? conn.serverId : null;
  return <>
    <h2>服务器</h2>
    <div className="sub">通过 SSH 连接，凭据保存在系统钥匙串。</div>
    <div className="grp"><div className="list">
      {servers.map((s) => {
        const mine = connectedId === s.id;
        return (
          <Row key={s.id} t={s.name} sub={`${s.username}@${s.host} · 端口 ${s.port}`}>
            {mine && conn.state === 'connected' && <Status ok>已连接{conn.latencyMs ? ` · ${conn.latencyMs} ms` : ''}</Status>}
            {mine && conn.state === 'connecting' && <Status warn>连接中…</Status>}
            {mine && conn.state === 'error' && <Status>{conn.message}</Status>}
            {!(mine && conn.state === 'connected') && <button className="btn" onClick={() => { setErr(''); rc.conn.connect(s.id).catch((e) => setErr(e.message)); }}>连接</button>}
            <button className="btn" onClick={() => setEdit(s)}>编辑</button>
          </Row>
        );
      })}
    </div></div>
    {err && <div className="err-text">{err}</div>}
    <div className="grp" style={{ display: 'flex', gap: 8 }}>
      <button className="btn" onClick={() => setEdit('new')}>＋ 添加服务器</button>
      {connectedId && <button className="btn" onClick={() => rc.conn.disconnect()}>断开</button>}
    </div>
    {edit && (
      <Modal onClose={() => setEdit(null)}>
        <h3>{edit === 'new' ? '添加服务器' : '编辑服务器'}</h3>
        <ServerForm initial={edit === 'new' ? undefined : edit} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); reloadServers(); }} />
        {edit !== 'new' && <button className="btn danger" style={{ marginTop: -34 }} onClick={async () => { await rc.servers.remove(edit.id); setEdit(null); reloadServers(); }}>删除</button>}
      </Modal>
    )}
  </>;
}

function EnvPage({ conn, doctor, refreshDoctor }: Parameters<typeof SettingsPage>[0]) {
  const [running, setRunning] = useState(false);
  const [cjk, setCjk] = useState(false);
  const [log, setLog] = useState<any[]>([]);
  const [checked, setChecked] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => rc.on('env-log', (ev) => setLog((l) => [...l, ev])), []);
  useEffect(() => { logRef.current?.scrollTo(0, 1e9); }, [log]);
  const connected = conn.state === 'connected';
  const run = async () => {
    setRunning(true); setLog([]);
    try { await rc.env.install({ cjkFonts: cjk }); } catch (e: any) { setLog((l) => [...l, { type: 'fatal', msg: e.message }]); }
    await refreshDoctor(); setChecked(new Date().toLocaleTimeString()); setRunning(false);
  };
  const item = (name: string, v: string | null | undefined, sub: string) => (
    <Row t={name} sub={v || sub}>{doctor ? (v ? <Status ok>正常</Status> : <Status>未安装</Status>) : <span className="st">—</span>}</Row>
  );
  return <>
    <h2>环境</h2>
    <div className="sub">检查 VPS 上的依赖，缺什么一键装上。</div>
    {!connected && <div className="err-text">还没连接服务器</div>}
    <div className="grp"><div className="list">
      {item('Claude Code', doctor?.claude, '未安装')}
      {item('Node.js', doctor?.node, '运行助手 rcc 需要')}
      {item('tmux', doctor?.tmux, '让任务在断线后继续运行')}
      {item('git', doctor?.git, '项目与并行任务需要')}
      {item('VPS 浏览器', doctor ? (doctor.chromium || null) : undefined, '登录和网页版需要 Chromium')}
      <Row t="远程画面" sub={doctor ? (doctor.xvnc && doctor.websockify ? `TigerVNC${doctor.windowManager ? ' · 窗口自动铺满' : ''}` : '旧版或未安装：点下面“开始”升级到 TigerVNC，画面更清晰、支持中文复制粘贴') : '—'}>{doctor ? (doctor.xvnc && doctor.websockify ? <Status ok>正常</Status> : <Status warn>需要升级</Status>) : <span className="st">—</span>}</Row>
      <Row t="Claude 登录" sub={doctor ? (doctor.loggedIn ? '已登录' : '未登录') : '—'}>{doctor && (doctor.loggedIn ? <Status ok>正常</Status> : <Status warn>未登录</Status>)}</Row>
    </div></div>
    <div className="grp"><h3>安装</h3><div className="list">
      <Row t="安装或修复依赖" sub="Claude Code、tmux、Node.js、git，以及 VPS 浏览器用的 TigerVNC、Chromium、websockify">
        <button className="btn p" disabled={!connected || running} onClick={run}>{running ? '安装中…' : '开始'}</button>
      </Row>
      <Row t="中文和 Emoji 字体" sub="可选：VPS 浏览器里中文显示成方块时勾选">
        <input type="checkbox" checked={cjk} onChange={(e) => setCjk(e.target.checked)} />
      </Row>
      <Row t="重新检测" sub={checked ? `上次检查 ${checked}` : ''}>
        <button className="btn" disabled={!connected} onClick={async () => { await refreshDoctor(); setChecked(new Date().toLocaleTimeString()); }}>检测</button>
      </Row>
    </div></div>
    {log.length > 0 && (
      <div className="log" ref={logRef}>
        {log.map((e, i) => <div key={i} className={e.type === 'fatal' || e.ok === false || e.status === 'fail' ? 'bad' : e.status === 'ok' || e.ok === true ? 'ok' : ''}>{fmtLog(e)}</div>)}
      </div>
    )}
  </>;
}
function fmtLog(e: any): string {
  switch (e.type) {
    case 'check': return `${e.ok ? '✓' : '·'} ${e.name}${e.ok ? '' : ' 未安装'}`;
    case 'install': return `${e.status === 'start' ? '↓ 安装' : e.status === 'ok' ? '✓ 已安装' : '✗ 安装失败'} ${e.name}${e.msg && e.status !== 'start' ? ' ' + e.msg : ''}`;
    case 'done': return e.ok ? '✓ 完成' : '✗ 有步骤失败';
    case 'auth': return e.logged_in ? '✓ Claude 已登录' : '· Claude 未登录';
    default: return e.msg ? `${e.type === 'fatal' ? '✗ ' : ''}${e.msg}` : JSON.stringify(e);
  }
}

function AccountPage(p: Parameters<typeof SettingsPage>[0]) {
  const { conn, accounts, refreshAccounts, prefs, setPrefs } = p;
  const connected = conn.state === 'connected';
  const [rename, setRename] = useState<Account | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (connected) refreshAccounts(true); }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now() / 1000;
  const act = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); } catch (e: any) { setErr(e.message); } await refreshAccounts(true); };
  const move = (id: string, d: number) => {
    const ids = accounts.map((a) => a.id); const i = ids.indexOf(id); const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(() => rc.accounts.order(ids));
  };
  return <>
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <div><h2>Claude 账号</h2><div className="sub">每个账号有自己的 Claude 配置和独立的 VPS 浏览器，Cookie 和登录状态互不干扰。对话历史所有账号共享。</div></div>
      <button className="btn p" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }} disabled={!connected} onClick={p.onAddAccount}>＋ 添加账号</button>
    </div>
    {!connected && <div className="err-text">还没连接服务器</div>}
    <div className="grp"><h3>账号（排在前面的优先使用）</h3><div className="list">
      {accounts.map((a, i) => {
        const lim = !!(a.limitedUntil && a.limitedUntil > now);
        const five = a.usage?.fiveHour;
        const pct = lim ? 100 : five ? Math.round(five.utilization) : null;
        return (
          <div className="row" key={a.id}>
            <span style={{ fontSize: 12, color: 'var(--faint)', width: 12 }}>{i + 1}</span>
            <QuotaAvatar a={a} size={34} />
            <div className="l">
              <b>{a.name}{a.active && <span className="tag cur">当前</span>}{lim && <span className="tag lim">额度用完</span>}{!a.loggedIn && <span className="tag">未登录</span>}</b>
              <span>{a.loggedIn ? [a.email, a.plan && a.plan.replace(/^./, (c) => c.toUpperCase())].filter(Boolean).join(' · ') || '已登录' : '独立浏览器已创建，还没有登录'}</span>
            </div>
            {a.loggedIn && pct !== null && (
              <div className="meter"><div className="b"><i className={pct >= 100 ? 'full' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                <div className="t"><span>5 小时 {pct}%</span><span>{lim ? resetText(a.limitedUntil) : five?.resetsAt ? resetText(Date.parse(five.resetsAt) / 1000) : ''}</span></div></div>
            )}
            {a.loggedIn && pct === null && lim && <span className="st">{resetText(a.limitedUntil)}</span>}
            {!a.loggedIn ? <button className="btn p" disabled={!connected} onClick={() => p.onLogin(a)}>登录</button>
              : !a.active && <button className="btn" disabled={!connected} onClick={() => p.onUseAccount(a.id)}>切换</button>}
            <button className="ib" title="用这个账号的浏览器打开 Claude 网页版" disabled={!connected} onClick={() => p.onBrowse(a)}>{I.globe()}</button>
            <Dropdown className="ib" align="right" down trigger={I.more(14)}>
              {(close) => <>
                <button className="mi" onClick={() => { close(); setRename(a); }}>重命名</button>
                <button className="mi" onClick={() => { close(); p.onLogin(a); }}>{a.loggedIn ? '重新登录' : '登录'}</button>
                {lim && <button className="mi" onClick={() => { close(); act(() => rc.accounts.clearLimit(a.id)); }}>标记为有额度</button>}
                {i > 0 && <button className="mi" onClick={() => { close(); move(a.id, -1); }}>上移</button>}
                {i < accounts.length - 1 && <button className="mi" onClick={() => { close(); move(a.id, 1); }}>下移</button>}
                <div className="msep" />
                {a.loggedIn && <button className="mi danger" onClick={async () => { close(); if (await confirmDialog({ title: `退出「${a.name}」的登录？`, body: '之后需要重新在 VPS 浏览器里登录才能用这个账号。', ok: '退出登录', danger: true })) act(() => rc.auth.logout(a.id)); }}>退出登录</button>}
                {a.id !== 'default' && <button className="mi danger" onClick={async () => { close(); if (await confirmDialog({ title: `删除账号「${a.name}」？`, body: '它的登录和独立浏览器数据都会从 VPS 上删除，对话历史保留。', ok: '删除', danger: true })) act(() => rc.accounts.remove(a.id)); }}>删除账号</button>}
              </>}
            </Dropdown>
          </div>
        );
      })}
      {accounts.length === 0 && <Row t="—" sub={connected ? '正在读取…' : ''} />}
    </div></div>
    {err && <div className="err-text">{err}</div>}
    <div className="grp"><h3>额度用完时</h3><div className="list">
      <Row t="自动切换账号" sub="按上面的顺序切到下一个有额度的账号，并在原会话里继续">
        <button className={`tog ${prefs.autoSwitch ? 'on' : ''}`} onClick={() => setPrefs({ autoSwitch: !prefs.autoSwitch })} />
      </Row>
      <Row t="切换后重发最后一条消息" sub="被额度打断的那条消息自动交给新账号">
        <button className={`tog ${prefs.resendOnSwitch ? 'on' : ''}`} onClick={() => setPrefs({ resendOnSwitch: !prefs.resendOnSwitch })} />
      </Row>
    </div></div>
    <div className="grp"><h3>Claude 网页版</h3><div className="list">
      <Row t="关闭窗口后保留 VPS 浏览器" sub="打开时更快，网页里正在生成的内容不会中断；每个账号会多占约 300 MB 内存">
        <button className={`tog ${prefs.keepBrowser ? 'on' : ''}`} onClick={() => setPrefs({ keepBrowser: !prefs.keepBrowser })} />
      </Row>
    </div></div>
    {rename && <NameModal title="重命名账号" initial={rename.name} onClose={() => setRename(null)} onSave={async (n) => { setRename(null); await act(() => rc.accounts.rename(rename.id, n)); }} />}
  </>;
}

export function NameModal({ title, sub, initial = '', ok = '保存', onClose, onSave }: { title: string; sub?: string; initial?: string; ok?: string; onClose(): void; onSave(name: string): void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      {sub && <div className="sub">{sub}</div>}
      <div className="field"><label>名称</label><input className="input" autoFocus value={name} placeholder="例如：工作、个人" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())} /></div>
      <div className="actions"><button className="btn" onClick={onClose}>取消</button><button className="btn p" disabled={!name.trim()} onClick={() => onSave(name.trim())}>{ok}</button></div>
    </Modal>
  );
}

function ModelPage({ prefs, setPrefs, resolved }: Parameters<typeof SettingsPage>[0]) {
  return <>
    <h2>模型与对话</h2>
    <div className="sub">新会话的默认值，每次对话也可以在输入框右下角单独切换。</div>
    <div className="grp"><h3>默认值</h3><div className="list">
      <Row t="模型" sub="由 Claude Code 解析为最新版本">
        <select className="sel" value={prefs.model} onChange={(e) => setPrefs({ model: e.target.value })}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Row>
      <Row t="思考强度">
        <div className="seg">{EFFORTS.map((e) => <button key={e.id} className={prefs.effort === e.id ? 'on' : ''} onClick={() => setPrefs({ effort: e.id })}>{e.label}</button>)}</div>
      </Row>
      <Row t="权限模式" sub={PERMS.find((x) => x.id === prefs.permissionMode)?.desc}>
        <select className="sel" value={prefs.permissionMode} onChange={(e) => setPrefs({ permissionMode: e.target.value })}>
          {PERMS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Row>
    </div></div>
    <div className="grp"><h3>已解析的模型</h3><div className="list">
      {MODELS.map((m) => (
        <Row key={m.id} t={m.label} sub={`${m.id || '默认'} → ${prettyModel(resolved[m.id || 'default']) || '用一次后显示'}${m.id === 'fable' ? ' · 可能消耗额外额度' : ''}`} />
      ))}
    </div>
      <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--faint)' }}>版本信息来自 VPS 上 Claude Code 每次会话开始时的报告。</div>
    </div>
  </>;
}

function LookPage({ prefs, setPrefs }: Parameters<typeof SettingsPage>[0]) {
  const mod = rc.platform === 'darwin' ? '⌘' : 'Ctrl';
  const keys: [string, string][] = [
    [`${mod} N`, '新建会话'], ['Esc', 'Claude 工作时中断'], [`${mod} ⇧ B`, '打开当前账号的 Claude 网页版'],
    [`${mod} ⇧ A`, '切换到下一个可用账号'], [`${mod} ,`, '打开设置'], [`${mod} V`, '粘贴图片/文件到输入框'],
  ];
  return <>
    <h2>外观</h2>
    <div className="grp"><div className="list">
      <Row t="主题">
        <div className="seg">
          {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([id, l]) => (
            <button key={id} className={prefs.theme === id ? 'on' : ''} onClick={() => setPrefs({ theme: id })}>{l}</button>
          ))}
        </div>
      </Row>
      <Row t="对话字号" sub={`${prefs.fontSize || 14} px`}>
        <div className="seg">
          {[13, 14, 15, 16].map((n) => <button key={n} className={(prefs.fontSize || 14) === n ? 'on' : ''} onClick={() => setPrefs({ fontSize: n })}>{n === 13 ? '小' : n === 14 ? '标准' : n === 15 ? '大' : '特大'}</button>)}
        </div>
      </Row>
      <Row t="密度" sub="紧凑模式下一屏能看到更多内容">
        <div className="seg">
          {([['comfortable', '舒适'], ['compact', '紧凑']] as const).map(([id, l]) => <button key={id} className={(prefs.density || 'comfortable') === id ? 'on' : ''} onClick={() => setPrefs({ density: id })}>{l}</button>)}
        </div>
      </Row>
    </div></div>
    <div className="grp"><h3>快捷键</h3><div className="list">
      {keys.map(([k, d]) => <Row key={k} t={d}><span className="kbd3">{k}</span></Row>)}
    </div></div>
    <UpdateBox prefs={prefs} setPrefs={setPrefs} />
  </>;
}

function UpdateBox({ prefs, setPrefs }: { prefs: Prefs; setPrefs(p: Partial<Prefs>): void }) {
  const [ver, setVer] = useState('');
  const [st, setSt] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(prefs.updateUrl || '');
  useEffect(() => { rc.app.version().then(setVer).catch(() => {}); }, []);
  const check = async () => { setBusy(true); try { setSt(await rc.app.checkUpdate(true)); } finally { setBusy(false); } };
  return (
    <div className="grp"><h3>更新</h3><div className="list">
      <Row t={`当前版本 v${ver}`} sub={st ? (st.error || (st.latest ? `有新版本 v${st.latest}${st.notes ? `：${String(st.notes).split('\n')[0].slice(0, 80)}` : ''}` : '已是最新')) : '启动时会自动检查（每 6 小时最多一次）'}>
        {st?.latest && st.url ? <button className="btn p" onClick={() => rc.app.openExternal(st.url!)}>下载 v{st.latest}</button>
          : <button className="btn" disabled={busy || !prefs.updateUrl} onClick={check}>{busy ? '检查中…' : '检查更新'}</button>}
      </Row>
      <Row t="更新地址" sub="GitHub Releases 的 API 地址（…/releases/latest），或返回 {version, notes, url} 的 JSON">
        <input className="input" style={{ width: 300 }} placeholder="https://api.github.com/repos/你/remote-claude/releases/latest" value={url}
          onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== prefs.updateUrl && setPrefs({ updateUrl: url.trim() })} />
      </Row>
    </div></div>
  );
}

// ---------- phone ----------
function PhonePage({ conn }: { conn: ConnState }) {
  const [st, setSt] = useState<MobileStatus | null>(null);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ts, setTs] = useState<{ step: string; loginUrl?: string | null; enableUrl?: string | null; detail?: string } | null>(null);
  const [pair, setPair] = useState<{ which: 'direct' | 'relay'; url: string; code: string; qr: string; exp: number } | null>(null);
  const [custom, setCustom] = useState('');
  const connected = conn.state === 'connected';
  const load = async () => {
    try { const s = await rc.mobile.status(); setSt(s); setCustom((c) => c || (s.url && !s.tailscale?.url ? s.url : '')); } catch (e: any) { setErr(e.message); }
    rc.mobile.relayStatus().then(setRelay).catch(() => {});
  };
  useEffect(() => { if (connected) load(); }, [connected]);
  const run = async (k: string, f: () => Promise<any>) => { setBusy(k); setErr(null); try { await f(); } catch (e: any) { setErr(e.message); } setBusy(null); load(); };
  const tailscale = () => run('ts', async () => { const r = await rc.mobile.tailscale(); setTs(r); });
  const showPair = (which: 'direct' | 'relay') => run('pair-' + which, async () => {
    const base = which === 'relay' ? relay?.urls[0] : undefined;
    const r = await rc.mobile.pair(base);
    if (!r.url) throw new Error('还没有手机能访问的地址：先开启 Tailscale，或填上你自己的 HTTPS 地址');
    setPair({ which, url: r.url, code: r.code, qr: await rc.mobile.qr(r.url), exp: r.expiresAt });
  });
  if (!connected) return <><h2>手机</h2><div className="sub">先连接一台服务器。</div></>;
  const tsInfo = st?.tailscale;
  const directUrl = st?.url || tsInfo?.url || null;
  return <>
    <h2>手机</h2>
    <div className="sub">在手机上给 VPS 里的 Claude Code 发消息、批准权限、收通知。Claude 只看到 VPS 的环境。</div>
    {err && <div className="note err" style={{ marginTop: 12 }}>{err}</div>}

    <div className="grp"><h3>手机服务</h3><div className="list">
      <Row t="rcc serve" sub={st ? (st.running ? `运行中 · 端口 ${st.port}（只监听 127.0.0.1）` : '未运行') : '读取中…'}>
        {st?.running
          ? <button className="btn" disabled={!!busy} onClick={() => run('off', () => rc.mobile.disable())}>停止</button>
          : <button className="btn p" disabled={!!busy} onClick={() => run('on', () => rc.mobile.enable())}>{busy === 'on' ? '开启中…' : '开启手机端'}</button>}
      </Row>
    </div></div>

    <div className="grp"><h3>直连 VPS（电脑关着也能用）</h3><div className="list">
      <Row t="Tailscale 私网 HTTPS" sub={!tsInfo ? '…' : !tsInfo.installed ? '推荐：不开公网端口，手机装 Tailscale 登录同一个账号即可' : tsInfo.serving ? `已发布：${tsInfo.url}` : tsInfo.state === 'NeedsLogin' ? '需要登录 Tailscale' : tsInfo.state === 'Running' ? '已登录，还没发布 HTTPS' : `状态：${tsInfo.state}`}>
        <button className={`btn ${tsInfo?.serving ? '' : 'p'}`} disabled={!!busy || !st?.running} onClick={tailscale}>{busy === 'ts' ? '处理中…' : tsInfo?.serving ? '重新检查' : tsInfo?.installed ? '继续设置' : '一键设置'}</button>
      </Row>
      {ts?.step === 'login' && (ts.loginUrl || tsInfo?.loginUrl) && <Row t="打开链接登录 Tailscale" sub="登录后回来再点一次「继续设置」"><button className="btn p" onClick={() => rc.app.openExternal((ts.loginUrl || tsInfo?.loginUrl)!)}>打开登录页</button></Row>}
      {ts?.step === 'enable-https' && <Row t="在 Tailscale 后台开启 HTTPS" sub="DNS 页面打开 MagicDNS 和 HTTPS Certificates，然后再点「继续设置」">{(ts.enableUrl || tsInfo?.enableUrl) ? <button className="btn p" onClick={() => rc.app.openExternal((ts.enableUrl || tsInfo?.enableUrl)!)}>打开设置页</button> : <button className="btn" onClick={() => rc.app.openExternal('https://login.tailscale.com/admin/dns')}>打开 DNS 设置</button>}</Row>}
      <Row t="或者用自己的 HTTPS 地址" sub="反向代理到 VPS 的 127.0.0.1:7788，例如 Cloudflare Tunnel、Caddy">
        <input className="input" style={{ width: 260 }} placeholder="https://claude.example.com" value={custom} onChange={(e) => setCustom(e.target.value)}
          onBlur={() => { const v = custom.trim(); if (v !== (st?.url || '') && (!v || /^https:\/\//.test(v))) run('url', () => rc.mobile.setUrl(v)); }} />
      </Row>
      <Row t="配对手机" sub={directUrl ? `手机打开 ${directUrl}` : '先完成上面任意一种'}>
        <button className="btn p" disabled={!directUrl || !st?.running || !!busy} onClick={() => showPair('direct')}>{busy === 'pair-direct' ? '生成中…' : '显示二维码'}</button>
      </Row>
    </div></div>

    <div className="grp"><h3>经电脑端（同一 Wi-Fi，电脑开着时）</h3><div className="list">
      <Row t="局域网入口" sub={relay?.running ? (relay.urls.join('  ·  ') || '没找到局域网地址') : '电脑在局域网开一个入口，经这台电脑的 SSH 连接转到 VPS；不需要 Tailscale'}>
        <button className={`tog ${relay?.running ? 'on' : ''}`} onClick={() => run('relay', async () => setRelay(await rc.mobile.relay(!relay?.running)))} />
      </Row>
      {relay?.running && <Row t="配对手机（局域网）" sub="普通 http 页面，浏览器不允许后台通知；需要通知请用直连">
        <button className="btn" disabled={!!busy || !relay.urls.length} onClick={() => showPair('relay')}>显示二维码</button>
      </Row>}
    </div></div>

    {!!st?.devices.length && <div className="grp"><h3>已配对的手机</h3><div className="list">
      {st.devices.map((d) => <Row key={d.id} t={d.name} sub={`${d.via === 'relay' ? '经电脑端' : '直连'} · 最近使用 ${new Date(d.lastSeen).toLocaleString()}`}>
        <button className="btn" onClick={async () => { if (await confirmDialog({ title: `移除「${d.name}」？`, body: '这台手机需要重新扫码才能再用。', ok: '移除', danger: true })) run('rm', () => rc.mobile.revoke(d.id)); }}>移除</button>
      </Row>)}
    </div></div>}

    {pair && <Modal onClose={() => setPair(null)}>
      <div style={{ textAlign: 'center', padding: '8px 4px' }}>
        <h2 style={{ fontSize: 17, marginBottom: 6 }}>{pair.which === 'relay' ? '扫码连接（局域网）' : '扫码连接 VPS'}</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>用手机相机扫描，10 分钟内有效，只能用一次</p>
        <img src={pair.qr} alt="" style={{ width: 220, height: 220, margin: '16px auto', display: 'block', borderRadius: 12, border: '1px solid var(--line)' }} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 22, letterSpacing: 4, fontWeight: 600 }}>{pair.code.slice(0, 4)} {pair.code.slice(4)}</div>
        <p style={{ color: 'var(--faint)', fontSize: 12, marginTop: 8, wordBreak: 'break-all' }}>{pair.url.replace(/#.*/, '')}</p>
        <button className="btn" style={{ marginTop: 14 }} onClick={() => setPair(null)}>完成</button>
      </div>
    </Modal>}
  </>;
}
