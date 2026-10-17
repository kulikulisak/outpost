import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rc } from './api';
import { Sidebar, type SideProject, type SideSession } from './components/Sidebar';
import { Chat } from './components/Chat';
import { NameModal, SettingsNav, SettingsPage, type Page } from './components/Settings';
import { ServerForm } from './components/ServerForm';
import { LoginModal } from './components/LoginModal';
import { ConfirmHost, Modal, confirmDialog } from './components/ui';
import { buildTranscript } from './transcript';
import { useLook } from './theme';
import type { Account, AuthStatus, ConnState, Doctor, LiveSession, OutFile, Prefs, Project, ServerConfig } from '../shared/types';

interface Conv {
  key: string; // 's:<sid>' once running, 'h:<claudeId>' for history, 'n:<uuid>' for a new one
  cwd: string;
  title: string;
  branch?: string | null;
  sid?: string;
  claudeId?: string;
  events: any[];
  loading: boolean;
  model: string; effort: string; permissionMode: string;
  started?: { model: string; effort: string; permissionMode: string; account?: string };
  mkdir?: boolean;
  account?: string; // account the next message goes to
}

const wt = (cwd: string) => { const m = cwd.match(/^(.*)-worktrees\/([^/]+)$/); return m ? { root: m[1], branch: m[2] } : { root: cwd, branch: null as string | null }; };
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function App() {
  const [servers, setServers] = useState<ServerConfig[] | null>(null);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [conn, setConn] = useState<ConnState>({ state: 'idle' });
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [live, setLive] = useState<LiveSession[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [convs, setConvs] = useState<Record<string, Conv>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [page, setPage] = useState<Page>('server');
  const [modal, setModal] = useState<null | { kind: 'project' } | { kind: 'worktree'; cwd: string } | { kind: 'login'; account?: Account } | { kind: 'addAccount' }>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const accountsRef = useRef(accounts); accountsRef.current = accounts;
  const activeAccountRef = useRef(activeAccount); activeAccountRef.current = activeAccount;
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const handledLimits = useRef(new Set<string>());
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const convsRef = useRef(convs); convsRef.current = convs;
  const convAccountRef = useRef<string | null>(null);

  const serverId = conn.state !== 'idle' ? conn.serverId : prefs?.lastServerId;
  const server = servers?.find((s) => s.id === serverId) || servers?.[0];
  const connected = conn.state === 'connected';

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      const [s, p, c] = await Promise.all([rc.servers.list(), rc.prefs.get(), rc.conn.state()]);
      setServers(s); setPrefsState(p); setConn(c);
      if (c.state === 'idle' && p.lastServerId && s.some((x) => x.id === p.lastServerId)) rc.conn.connect(p.lastServerId).catch(() => {});
    })();
    const off1 = rc.on('conn', setConn);
    const off2 = rc.on('session-events', ({ sid, events }: { sid: string; events: any[] }) => {
      setConvs((all) => {
        const key = `s:${sid}`;
        const c = all[key];
        if (!c) return all;
        for (const ev of events) {
          if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
            const alias = c.started?.model || c.model || 'default';
            setResolved((r) => (r[alias] === ev.model ? r : { ...r, [alias || 'default']: ev.model }));
          }
          if (ev.type === 'result') setTimeout(() => refreshLists(), 600);
          if (ev.type === 'rcc_limit') {
            const id = `${sid}:${ev.ts}`;
            if (!handledLimits.current.has(id) && Date.now() - Number(ev.ts || 0) < 120000) { handledLimits.current.add(id); setTimeout(() => onLimitRef.current(key, ev), 0); }
          }
        }
        return { ...all, [key]: { ...c, events: [...c.events, ...events] } };
      });
    });
    return () => { off1(); off2(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLook(prefs);

  // resolved model names, remembered per server
  useEffect(() => { if (serverId) setResolved(JSON.parse(localStorage.getItem(`resolved:${serverId}`) || '{}')); }, [serverId]);
  useEffect(() => { if (serverId) localStorage.setItem(`resolved:${serverId}`, JSON.stringify(resolved)); }, [resolved, serverId]);

  const refreshLists = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const [p, l] = await Promise.all([rc.claude.projects().catch(() => [] as Project[]), rc.claude.live().catch(() => [] as LiveSession[])]);
      setProjects(p); setLive(l);
    } finally { setLoadingProjects(false); }
  }, []);
  const refreshAccounts = useCallback(async (usage?: boolean) => {
    try {
      const r = await rc.accounts.list(usage);
      setAccounts(r.accounts); setActiveAccount(r.active);
      accountsRef.current = r.accounts; activeAccountRef.current = r.active;
      const a = r.accounts.find((x) => x.id === r.active);
      if (a) setAuth({ loggedIn: a.loggedIn, email: a.email || undefined, subscriptionType: a.plan || undefined });
      return r;
    } catch { return null; }
  }, []);
  const refreshDoctor = useCallback(async () => {
    try {
      const d = await rc.env.doctor(); setDoctor(d);
      if (d.node && d.claude) { const r = await refreshAccounts(); if (!r) setAuth({ loggedIn: d.loggedIn }); refreshLists(); }
      else setAuth({ loggedIn: d.loggedIn });
    } catch { /* connection issue shows elsewhere */ }
  }, [refreshLists, refreshAccounts]);

  useEffect(() => {
    if (!connected) return;
    refreshDoctor();
    const t = setInterval(refreshLists, 20000);
    return () => clearInterval(t);
  }, [connected, refreshDoctor, refreshLists]);

  const setPrefs = async (p: Partial<Prefs>) => setPrefsState(await rc.prefs.set(p));

  // ---------- sidebar model ----------
  const sideProjects: SideProject[] = useMemo(() => {
    const groups = new Map<string, SideProject & { t: string }>();
    const hidden = new Set(prefs?.hiddenProjects?.[serverId || ''] || []);
    const group = (cwd: string, t = '') => {
      const { root } = wt(cwd);
      if (!groups.has(root)) groups.set(root, { cwd: root, name: base(root), sessions: [], t: '' });
      const g = groups.get(root)!;
      if (t > g.t) g.t = t;
      return g;
    };
    const liveByClaude = new Map(live.filter((l) => l.status === 'running' || l.status === 'starting').map((l) => [l.claudeSessionId, l]));
    for (const p of projects) {
      for (const s of p.sessions) {
        if (liveByClaude.has(s.id)) continue;
        group(p.cwd, s.updatedAt).sessions.push({ key: `h:${s.id}`, title: s.title, live: false, busy: false, branch: wt(p.cwd).branch, updatedAt: s.updatedAt });
      }
    }
    const titleOf = new Map(projects.flatMap((p) => p.sessions.map((s) => [s.id, s.title] as const)));
    for (const l of live) {
      if (l.status !== 'running' && l.status !== 'starting') continue;
      const c = convsRef.current[`s:${l.sid}`];
      const busy = c ? buildTranscript(c.events).busy : l.busy;
      group(l.cwd, l.updatedAt).sessions.push({ key: `s:${l.sid}`, title: l.title || titleOf.get(l.claudeSessionId || '') || c?.title || '新会话', live: true, busy, branch: l.worktree || wt(l.cwd).branch, updatedAt: l.updatedAt });
    }
    for (const c of Object.values(convs)) {
      if (c.key.startsWith('n:')) group(c.cwd, new Date().toISOString()).sessions.unshift({ key: c.key, title: c.title, live: false, busy: false, updatedAt: undefined });
      if (c.key.startsWith('s:') && !live.some((l) => `s:${l.sid}` === c.key)) {
        const g = group(c.cwd);
        if (!g.sessions.some((s) => s.key === c.key)) g.sessions.unshift({ key: c.key, title: c.title, live: true, busy: buildTranscript(c.events).busy, branch: c.branch });
      }
    }
    for (const cwd of prefs?.extraProjects?.[serverId || ''] || []) group(cwd);
    return [...groups.values()]
      .filter((g) => !hidden.has(g.cwd) || g.sessions.some((s) => s.live))
      .map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || String(b.updatedAt || '9').localeCompare(String(a.updatedAt || '9'))) }))
      .sort((a, b) => b.t.localeCompare(a.t));
  }, [projects, live, convs, prefs, serverId]);

  const active = activeKey ? convs[activeKey] : null;
  const transcript = useMemo(() => buildTranscript(active?.events || []), [active?.events]);

  // ---------- conversations ----------
  const defaults = () => ({ model: prefs?.model ?? 'opus', effort: prefs?.effort ?? 'high', permissionMode: prefs?.permissionMode ?? 'default' });

  const newConv = (cwd?: string, mkdir?: boolean) => {
    const dir = cwd || active?.cwd && wt(active.cwd).root || sideProjects[0]?.cwd || server?.workdir || '~';
    const existing = Object.values(convs).find((c) => c.key.startsWith('n:') && c.cwd === dir && c.events.length === 0);
    if (existing) { setActiveKey(existing.key); setView('chat'); return; }
    const key = `n:${crypto.randomUUID()}`;
    setConvs((a) => ({ ...a, [key]: { key, cwd: dir, title: '新会话', events: [], loading: false, mkdir, ...defaults() } }));
    setActiveKey(key); setView('chat');
  };

  const open = async (key: string) => {
    setView('chat');
    setActiveKey(key);
    if (convs[key]) return;
    if (key.startsWith('h:')) {
      const id = key.slice(2);
      const p = projects.find((x) => x.sessions.some((s) => s.id === id));
      const s = p?.sessions.find((x) => x.id === id);
      setConvs((a) => ({ ...a, [key]: { key, cwd: p?.cwd || '~', title: s?.title || '会话', branch: wt(p?.cwd || '').branch, claudeId: id, events: [], loading: true, ...defaults() } }));
      const events = await rc.claude.history(id).catch(() => []);
      setConvs((a) => ({ ...a, [key]: { ...a[key], events, loading: false } }));
    } else if (key.startsWith('s:')) {
      const sid = key.slice(2);
      const l = live.find((x) => x.sid === sid);
      const started = { model: l?.model || '', effort: l?.effort || '', permissionMode: defaults().permissionMode };
      const st2 = { ...started, account: l?.account };
      setConvs((a) => ({ ...a, [key]: { key, cwd: l?.cwd || '~', title: l?.title || '会话', branch: l?.worktree, sid, claudeId: l?.claudeSessionId || undefined, events: [], loading: true, ...defaults(), model: started.model, effort: started.effort || defaults().effort, started: st2, account: l?.account } }));
      let earlier: any[] = [];
      if (l?.resume) {
        const h = await rc.claude.history(l.resume).catch(() => []);
        earlier = h.filter((e: any) => !e.timestamp || !l.createdAt || e.timestamp < l.createdAt);
      }
      setConvs((a) => ({ ...a, [key]: { ...a[key], events: [...earlier, ...a[key].events], loading: false } }));
      await rc.claude.subscribe(sid);
    }
  };

  const patchActive = (p: Partial<Conv>) => { if (activeKey) setConvs((a) => ({ ...a, [activeKey]: { ...a[activeKey], ...p } })); };

  const sendTo = async (convKey: string, text: string, files?: OutFile[]) => {
    const c = convsRef.current[convKey];
    if (!c) return;
    const account = c.account || activeAccountRef.current || undefined;
    const want = { model: c.model, effort: c.effort, permissionMode: c.permissionMode, account };
    const t = buildTranscript(c.events);
    let sid = c.sid && !t.exited ? c.sid : undefined;
    const differs = c.started && (c.started.model !== want.model || c.started.effort !== want.effort || c.started.permissionMode !== want.permissionMode || (want.account && (c.started.account || 'default') !== want.account));
    if (sid && differs) { await rc.claude.stop(sid).catch(() => {}); await rc.claude.unsubscribe(sid); sid = undefined; }
    if (!sid) {
      const resume = t.claudeSessionId || c.claudeId;
      const title = c.title === '新会话' ? (text || files?.[0]?.name || '新会话').replace(/\s+/g, ' ').slice(0, 40) : c.title;
      const r = await rc.claude.start({ cwd: c.cwd, model: want.model || undefined, effort: want.effort, permissionMode: want.permissionMode, resume, title, mkdir: c.mkdir, account, simple: prefs?.simple !== false, browser: prefs?.browser !== false });
      sid = r.sid;
      const key = `s:${sid}`;
      const moved = { ...convsRef.current[convKey], key, sid, title, cwd: r.cwd, started: want, account };
      setConvs((a) => { const { [convKey]: _old, ...rest } = a; return { ...rest, [key]: { ...(a[convKey] || moved), key, sid, title, cwd: r.cwd, started: want, account } }; });
      setActiveKey((k) => (k === convKey ? key : k));
      convsRef.current = { ...convsRef.current, [key]: moved };
      await rc.claude.subscribe(sid);
    }
    for (let i = 0; ; i++) {
      try { await rc.claude.send(sid!, text, files); break; }
      catch (e: any) { if (i > 40 || !/not attached|starting/.test(e.message)) throw e; await sleep(250); }
    }
    refreshLists();
  };
  const send = (text: string, files?: OutFile[]) => sendTo(activeKey!, text, files);

  // ---------- accounts ----------
  const openWeb = (id: string) => { rc.web.open(id).catch((e) => setNotice({ text: `打不开网页版：${e.message}`, error: true })); };
  const lastUserText = (events: any[]) => { for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'rcc_user') return String(events[i].text || ''); return ''; };
  const switchConv = async (convKey: string, to: string, auto: boolean) => {
    const c = convsRef.current[convKey];
    if (!c) return;
    const acc = accountsRef.current.find((a) => a.id === to);
    await rc.accounts.use(to).catch(() => {});
    setActiveAccount(to); activeAccountRef.current = to;
    const marker = { type: 'rcc_switch', to, toName: acc?.name, auto };
    const next = { ...c, account: to, events: [...c.events, marker] };
    convsRef.current = { ...convsRef.current, [convKey]: next };
    setConvs((a) => (a[convKey] ? { ...a, [convKey]: { ...a[convKey], account: to, events: [...a[convKey].events, marker] } } : a));
    const text = lastUserText(c.events);
    if (text && (auto ? prefsRef.current?.resendOnSwitch !== false : true)) await sendTo(convKey, text).catch(() => {});
    refreshAccounts();
  };
  const onLimit = async (convKey: string, ev: any) => {
    const r = await refreshAccounts();
    if (!prefsRef.current?.autoSwitch || !r) return;
    const now = Date.now() / 1000;
    const order = r.accounts;
    const i = order.findIndex((a) => a.id === ev.account);
    const pick = [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0))].find((a) => a.id !== ev.account && a.loggedIn && !(a.limitedUntil && a.limitedUntil > now));
    if (pick) await switchConv(convKey, pick.id, true);
  };
  const onLimitRef = useRef(onLimit); onLimitRef.current = onLimit;
  const useAccount = async (id: string) => {
    await rc.accounts.use(id).catch(() => {});
    setActiveAccount(id); activeAccountRef.current = id;
    if (activeKey && convs[activeKey]) {
      const c = convs[activeKey];
      const marker = c.events.length && (c.account || c.started?.account || 'default') !== id ? [{ type: 'rcc_switch', to: id, toName: accounts.find((a) => a.id === id)?.name }] : [];
      setConvs((a) => ({ ...a, [activeKey]: { ...a[activeKey], account: id, events: [...a[activeKey].events, ...marker] } }));
    }
    refreshAccounts();
  };

  const startWorktree = async (cwd: string, name: string, baseBranch: string) => {
    const want = defaults();
    const account = activeAccountRef.current || undefined;
    const r = await rc.claude.start({ cwd, worktree: name, base: baseBranch || 'HEAD', title: name, model: want.model || undefined, effort: want.effort, permissionMode: want.permissionMode, account, simple: prefs?.simple !== false, browser: prefs?.browser !== false });
    const key = `s:${r.sid}`;
    setConvs((a) => ({ ...a, [key]: { key, cwd: r.cwd, title: name, branch: name, sid: r.sid, events: [], loading: false, ...want, started: { ...want, account }, account } }));
    setActiveKey(key); setView('chat');
    await rc.claude.subscribe(r.sid);
    refreshLists();
  };

  // keyboard shortcuts
  const nextAccount = () => {
    const now = Date.now() / 1000;
    const list = accountsRef.current.filter((a) => a.loggedIn && !(a.limitedUntil && a.limitedUntil > now));
    if (list.length < 2) return;
    const i = list.findIndex((a) => a.id === (convAccountRef.current || activeAccountRef.current));
    const to = list[(i + 1) % list.length];
    if (activeKey && convs[activeKey]?.events.length) switchConv(activeKey, to.id, false); else useAccount(to.id);
    setNotice({ text: `已切换到「${to.name}」` });
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); newConv(); }
      else if (k === 'b' && e.shiftKey) { e.preventDefault(); const id = convAccountRef.current || activeAccountRef.current; if (id) openWeb(id); }
      else if (k === 'a' && e.shiftKey) { e.preventDefault(); nextAccount(); }
      else if (e.key === ',') { e.preventDefault(); setView('settings'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // quota rings: refresh usage now and then
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => refreshAccounts(true), 5 * 60 * 1000);
    const first = setTimeout(() => refreshAccounts(true), 4000);
    return () => { clearInterval(t); clearTimeout(first); };
  }, [connected, refreshAccounts]);

  // update check on start
  useEffect(() => {
    rc.app.checkUpdate(false).then((u) => { if (u.latest) setNotice({ text: `有新版本 v${u.latest}`, action: u.url ? { label: '下载', run: () => rc.app.openExternal(u.url!) } : undefined, sticky: true }); }).catch(() => {});
  }, []);

  // one place for short notices and action errors
  const [notice, setNotice] = useState<null | { text: string; error?: boolean; action?: { label: string; run(): void }; sticky?: boolean }>(null);
  useEffect(() => { if (!notice || notice.sticky) return; const t = setTimeout(() => setNotice(null), notice.error ? 6000 : 2600); return () => clearTimeout(t); }, [notice]);

  // ---------- render ----------
  if (!servers || !prefs) return null;
  const mac = rc.platform === 'darwin';

  if (servers.length === 0) {
    return (
      <div className={`app ${mac ? 'mac' : ''}`} style={{ flexDirection: 'column' }}>
        <div className="drag" style={{ height: 40, flexShrink: 0 }} />
        <div className="welcome"><div className="card">
          <h1>连接你的 VPS</h1>
          <div className="lead">Claude Code 会安装并运行在服务器上，这里只是它的窗口。</div>
          <ServerForm onSaved={async () => { setServers(await rc.servers.list()); setView('settings'); setPage('env'); }} />
        </div></div>
      </div>
    );
  }

  const dot = conn.state === 'connected' ? 'ok' : conn.state === 'connecting' ? 'warn' : conn.state === 'error' ? 'err' : '';
  const serverLabel = conn.state === 'connected' ? '已连接' : conn.state === 'connecting' ? '连接中…' : conn.state === 'error' ? conn.message : '未连接';
  const notReady = !connected ? (conn.state === 'connecting' ? '正在连接服务器…' : '未连接服务器') : !doctor ? '正在检查环境…' : !doctor.claude || !doctor.node ? '先在设置 → 环境里安装依赖' : !(auth?.loggedIn ?? doctor.loggedIn) ? '先登录 Claude 账号' : '';
  const convAccount = active ? (active.account || active.started?.account || activeAccount) : activeAccount;
  convAccountRef.current = convAccount;
  const accName = accounts.length > 1 ? accounts.find((a) => a.id === convAccount)?.name : null;
  const footer = [server?.name, accName ? `账号「${accName}」` : null, doctor?.claude ? `Claude Code v${doctor.claude.split(' ')[0]}` : null, connected ? null : serverLabel].filter(Boolean).join(' · ');

  let banner: React.ReactElement | null = null;
  if (conn.state === 'error') banner = <div className="banner"><span className="sdot err" /><span className="grow">{conn.message}</span><button className="btn" onClick={() => server && rc.conn.connect(server.id).catch(() => {})}>重试</button></div>;
  else if (connected && doctor && (!doctor.claude || !doctor.node)) banner = <div className="banner"><span className="sdot warn" /><span className="grow">VPS 上还缺少 Claude Code 或依赖</span><button className="btn p" onClick={() => { setView('settings'); setPage('env'); }}>去安装</button></div>;
  else if (connected && doctor?.claude && auth && !auth.loggedIn) banner = <div className="banner"><span className="sdot warn" /><span className="grow">{accounts.length > 1 ? `账号「${accounts.find((a) => a.id === activeAccount)?.name || ''}」还没登录` : 'Claude Code 还没登录'}，登录在 VPS 上的独立浏览器里完成</span><button className="btn p" onClick={() => setModal({ kind: 'login', account: accounts.find((a) => a.id === activeAccount) })}>登录</button></div>;

  return (
    <div className={`app ${mac ? 'mac' : ''}`}>
      {view === 'settings' ? <>
        <SettingsNav page={page} setPage={setPage} onBack={() => setView('chat')} serverName={server?.name || ''} dot={dot} />
        <SettingsPage page={page} conn={conn} servers={servers} prefs={prefs} doctor={doctor} auth={auth} resolved={resolved}
          reloadServers={async () => setServers(await rc.servers.list())} setPrefs={setPrefs} refreshDoctor={refreshDoctor}
          accounts={accounts} refreshAccounts={async (u) => { await refreshAccounts(u); }} onUseAccount={useAccount}
          onLogin={(a) => setModal({ kind: 'login', account: a })} onBrowse={(a) => openWeb(a.id)} onAddAccount={() => setModal({ kind: 'addAccount' })} />
      </> : <>
        <Sidebar projects={sideProjects} activeKey={activeKey} activeCwd={active ? wt(active.cwd).root : null}
          server={{ name: server?.name || '', dot, label: serverLabel }} loadingProjects={loadingProjects}
          onNew={newConv} onQuick={() => newConv('~/chat', true)} onOpen={open} onAddProject={() => setModal({ kind: 'project' })}
          onWorktree={(cwd) => setModal({ kind: 'worktree', cwd })}
          onRemoveProject={async (cwd) => serverId && await confirmDialog({ title: '从侧边栏移除这个项目？', body: '只是不再显示，VPS 上的文件和对话历史都不会删除。', ok: '移除' }) && setPrefs({
            hiddenProjects: { ...prefs.hiddenProjects, [serverId]: [...(prefs.hiddenProjects?.[serverId] || []), cwd] },
            extraProjects: { ...prefs.extraProjects, [serverId]: (prefs.extraProjects?.[serverId] || []).filter((x) => x !== cwd) },
          })}
          onRefresh={refreshLists} onSettings={(p) => { setView('settings'); setPage((p as Page) || 'server'); }}
          accounts={accounts} activeAccount={convAccount} onUseAccount={useAccount} onAddAccount={() => setModal({ kind: 'addAccount' })} onWeb={openWeb} />
        <main className="main">
          {active ? (
            <Chat title={active.title} cwd={active.cwd} branch={active.branch} transcript={transcript} loading={active.loading}
              canSend={!notReady} blockedReason={notReady || undefined}
              model={active.model} effort={active.effort} permissionMode={active.permissionMode} resolved={resolved}
              onModel={(model) => patchActive({ model })} onEffort={(effort) => patchActive({ effort })} onPerm={(permissionMode) => patchActive({ permissionMode })}
              onSend={send} simple={prefs?.simple !== false} account={convAccount || 'default'}
              onClear={() => newConv(wt(active.cwd).root)}
              onRestore={async (c) => { if (!active.sid) throw new Error('会话已结束，重新打开后再恢复'); await rc.claude.restore(active.sid, c); }}
              onPreview={async (pg) => { if (!active.sid) throw new Error('会话已结束，发一条消息后再预览'); await rc.claude.preview(active.sid, pg); }}
              onInterrupt={() => active.sid && rc.claude.interrupt(active.sid).catch(() => {})}
              onAnswer={(req, d, x) => active.sid && rc.claude.answer(active.sid, req, d, x?.message, x?.answers).catch(() => {})}
              footer={footer} banner={banner}
              accounts={accounts} onSwitch={(id) => activeKey && switchConv(activeKey, id, false)} />
          ) : (
            <>
              <div className="top drag" />
              {banner}
              <div className="chat"><div className="empty">
                <h2>{connected ? '选一个会话，或新建一个' : serverLabel}</h2>
                <div style={{ marginTop: 14 }}><button className="btn p" disabled={!connected} onClick={() => newConv()}>新建会话</button></div>
              </div></div>
            </>
          )}
        </main>
      </>}

      <ConfirmHost />
      {notice && <div className={`toast app-toast ${notice.error ? 'err' : ''}`}>{notice.text}{notice.action && <button className="btn sm" onClick={() => { notice.action!.run(); setNotice(null); }}>{notice.action.label}</button>}{(notice.sticky || notice.error) && <button className="toast-x" onClick={() => setNotice(null)}>{'×'}</button>}</div>}
      {modal?.kind === 'project' && <AddProjectModal workdir={server?.workdir || '~/code'} onClose={() => setModal(null)} onAdd={(cwd, mkdir) => {
        if (serverId) setPrefs({
          extraProjects: { ...prefs.extraProjects, [serverId]: [...new Set([...(prefs.extraProjects?.[serverId] || []), cwd])] },
          hiddenProjects: { ...prefs.hiddenProjects, [serverId]: (prefs.hiddenProjects?.[serverId] || []).filter((x) => x !== cwd) },
        });
        setModal(null); newConv(cwd, mkdir);
      }} />}
      {modal?.kind === 'worktree' && <WorktreeModal cwd={modal.cwd} onClose={() => setModal(null)} onStart={async (n, b) => { await startWorktree(modal.cwd, n, b); setModal(null); }} />}
      {modal?.kind === 'login' && <LoginModal account={modal.account ? { id: modal.account.id, name: modal.account.name } : undefined} onClose={() => { setModal(null); refreshAccounts(true); }} onDone={() => { setModal(null); refreshDoctor(); refreshAccounts(true); }} />}
      {modal?.kind === 'addAccount' && <NameModal title="添加账号" sub="会在 VPS 上为它创建独立的 Claude 配置和浏览器，接着打开浏览器登录。" ok="创建并登录" onClose={() => setModal(null)} onSave={async (name) => {
        try {
          const { id } = await rc.accounts.add(name);
          const r = await refreshAccounts();
          const a = r?.accounts.find((x) => x.id === id);
          setModal(a ? { kind: 'login', account: a } : null);
        } catch { setModal(null); }
      }} />}
    </div>
  );
}

function AddProjectModal({ workdir, onClose, onAdd }: { workdir: string; onClose(): void; onAdd(cwd: string, mkdir: boolean): void }) {
  const [path, setPath] = useState(workdir.replace(/\/?$/, '/'));
  const [mkdir, setMkdir] = useState(true);
  return (
    <Modal onClose={onClose}>
      <h3>添加项目</h3>
      <div className="sub">VPS 上的一个目录。Claude Code 按目录区分项目。</div>
      <div className="field"><label>路径</label><input className="input" autoFocus value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && onAdd(path.trim().replace(/\/+$/, ''), mkdir)} /></div>
      <label className="check"><input type="checkbox" checked={mkdir} onChange={(e) => setMkdir(e.target.checked)} />目录不存在时自动创建</label>
      <div className="actions"><button className="btn" onClick={onClose}>取消</button><button className="btn p" disabled={!path.trim()} onClick={() => onAdd(path.trim().replace(/\/+$/, ''), mkdir)}>添加</button></div>
    </Modal>
  );
}

function WorktreeModal({ cwd, onClose, onStart }: { cwd: string; onClose(): void; onStart(name: string, base: string): Promise<void> }) {
  const [name, setName] = useState('');
  const [baseBranch, setBase] = useState('main');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await onStart(name.trim(), baseBranch.trim()); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const valid = /^[\w.\-/]+$/.test(name.trim());
  return (
    <Modal onClose={onClose}>
      <h3>新建并行任务</h3>
      <div className="sub">在 {cwd.replace(/^\/(root|home\/[^/]+)/, '~')} 旁边建一个 git worktree 和新分支，Claude 在里面独立工作，互不干扰。</div>
      <div className="field"><label>任务 / 分支名</label><input className="input" autoFocus placeholder="fix-login" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label>基于分支</label><input className="input" value={baseBranch} onChange={(e) => setBase(e.target.value)} /></div>
      {err && <div className="err-text">{err}</div>}
      <div className="actions"><button className="btn" onClick={onClose}>取消</button><button className="btn p" disabled={!valid || busy} onClick={go}>{busy ? '创建中…' : '创建'}</button></div>
    </Modal>
  );
}
