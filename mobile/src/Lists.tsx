import { useEffect, useMemo, useState } from 'react';
import { api, type Account, type LiveSession, type Project } from './api';
import { I, Ring, Sheet, ago, base, short, toast } from './ui';
import { EFFORTS, MODELS, PERMS, prettyModel } from '@desktop/options';

export type Open = { sid: string } | { resumeId: string; cwd: string; title: string };

const sessTitle = (s: LiveSession) => s.title || s.firstText || base(s.cwd);
const sessSub = (s: LiveSession) => {
  if (s.pending?.length) return s.pending[0].text;
  if (s.status === 'running' && s.busy) return '正在处理…';
  if (s.lastText) return s.lastText;
  if (s.status === 'exited' || s.status === 'stopped') return '已结束';
  return prettyModel(s.resolvedModel) || '等待输入';
};

export function SessionsPage({ sessions, connected, server, accounts, onOpen, onNew, onAccounts }: {
  sessions: LiveSession[] | null; connected: boolean; server: string; accounts: Account[]; onOpen(o: Open): void; onNew(): void; onAccounts(): void;
}) {
  const [q, setQ] = useState('');
  const active = accounts.find((a) => a.active);
  const running = (sessions || []).filter((s) => s.status === 'running' && s.busy).length;
  const groups = useMemo(() => {
    const list = (sessions || []).filter((s) => s.status !== 'stopped' || Date.now() - Date.parse(s.updatedAt) < 3 * 86400e3)
      .filter((s) => !q || `${sessTitle(s)} ${s.cwd} ${s.lastText || ''}`.toLowerCase().includes(q.toLowerCase()));
    const pending = list.filter((s) => s.pending?.length);
    const rest = list.filter((s) => !s.pending?.length);
    const by = new Map<string, LiveSession[]>();
    for (const s of rest) { const k = s.repo || s.cwd; by.set(k, [...(by.get(k) || []), s]); }
    return { pending, by: [...by.entries()] };
  }, [sessions, q]);

  const Row = (s: LiveSession) => (
    <button key={s.sid} className="row" onClick={() => onOpen({ sid: s.sid })}>
      <div className={`av ${s.pending?.length ? 'warn' : ''}`}>{s.pending?.length ? '!' : base(s.repo || s.cwd).slice(0, 1)}</div>
      <div className="b">
        <div className="t1">
          {s.status === 'running' && s.busy && !s.pending?.length && <span className="pulse" />}
          <span className="tt">{sessTitle(s)}</span>
          {s.pending?.length ? <span className="badge">等待批准</span> : s.worktree ? <span className="br">{s.worktree}</span> : null}
          <span className="tm">{s.status === 'running' && s.busy ? '运行中' : ago(s.updatedAt)}</span>
        </div>
        <div className="t2">{sessSub(s)}</div>
      </div>
    </button>
  );

  return (
    <div className="page">
      <div className="nav">
        <h1>会话</h1>
        <div className="r">
          {active && <button onClick={onAccounts} aria-label="账号"><Ring label={active.name} pct={active.usage?.fiveHour?.utilization ?? null} limited={!!active.limitedUntil && active.limitedUntil * 1000 > Date.now()} /></button>}
        </div>
      </div>
      <div className="scroll">
        <div className="srv"><span className={`dotg ${connected ? '' : 'off'}`} />{server || 'VPS'} · {connected ? '已连接' : '连接中…'}{running ? ` · ${running} 个任务进行中` : ''}</div>
        <div className="search">{I.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索会话" /></div>
        {sessions === null && <div className="empty">正在读取…</div>}
        {sessions && !sessions.length && <div className="empty">还没有会话。<br />点右下角「新任务」开始，或去「项目」接着以前的对话。</div>}
        {groups.pending.length > 0 && <><div className="sec"><span>需要你处理</span></div>{groups.pending.map(Row)}</>}
        {groups.by.map(([cwd, list]) => (
          <div key={cwd}><div className="sec"><span>{base(cwd)}</span><span>{list.length}</span></div>{list.map(Row)}</div>
        ))}
        <div style={{ height: 90 }} />
      </div>
      <button className="fab" onClick={onNew}>{I.plus}新任务</button>
    </div>
  );
}

export function ProjectsPage({ onOpen, onNew }: { onOpen(o: Open): void; onNew(cwd?: string): void }) {
  const [list, setList] = useState<Project[] | null>(null);
  const [open, setOpen] = useState<Project | null>(null);
  const load = () => api<Project[]>('/api/projects', undefined, { timeout: 60000 }).then(setList).catch((e) => { toast(e.message); setList([]); });
  useEffect(() => { load(); }, []);
  return (
    <div className="page">
      <div className="nav"><h1>项目</h1><div className="r"><button className="ib fill" onClick={() => onNew()} aria-label="新任务">{I.plus}</button></div></div>
      <div className="scroll">
        {list === null && <div className="empty">正在读取 VPS 上的项目…</div>}
        {list && !list.length && <div className="empty">VPS 上还没有 Claude Code 的项目记录。</div>}
        {list?.map((p) => (
          <button key={p.cwd} className="row" onClick={() => setOpen(p)}>
            <div className="av">{p.name.slice(0, 1)}</div>
            <div className="b">
              <div className="t1"><span className="tt">{p.name}</span>{p.gitBranch && <span className="br">{p.gitBranch}</span>}<span className="tm">{ago(p.updatedAt)}</span></div>
              <div className="t2">{short(p.cwd)} · {p.sessions.length} 个对话</div>
            </div>
          </button>
        ))}
        <div style={{ height: 24 }} />
      </div>
      {open && (
        <Sheet onClose={() => setOpen(null)}>
          <h2>{open.name}</h2>
          <div className="sub">{short(open.cwd)}</div>
          <div className="btns" style={{ marginTop: 14 }}><button className="btn pri" onClick={() => { setOpen(null); onNew(open.cwd); }}>在这里开新任务</button></div>
          <div className="lbl">接着以前的对话</div>
          {open.sessions.slice(0, 30).map((s) => (
            <button key={s.id} className="opt" onClick={() => { setOpen(null); onOpen({ resumeId: s.id, cwd: open.cwd, title: s.title }); }}>
              <div style={{ minWidth: 0, flex: 1 }}><div className="n" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div><div className="d">{ago(s.updatedAt)}{s.branch ? ` · ${s.branch}` : ''}</div></div>
              {I.chev}
            </button>
          ))}
        </Sheet>
      )}
    </div>
  );
}

export interface RunOpts { model: string; effort: string; permissionMode: string; account: string }
export const loadOpts = (): RunOpts => ({ model: '', effort: 'high', permissionMode: 'default', account: '', ...JSON.parse(localStorage.getItem('rcc.opts') || '{}') });
export const saveOpts = (o: RunOpts) => localStorage.setItem('rcc.opts', JSON.stringify(o));
export const allowBypass = () => localStorage.getItem('rcc.allowBypass') === '1';

/** Model, effort, permission mode and account: one sheet, used for new tasks and running ones. */
export function OptionsSheet({ value, accounts, onChange, onClose, title = '模型与账号' }: { value: RunOpts; accounts: Account[]; onChange(v: RunOpts): void; onClose(): void; title?: string }) {
  const perms = PERMS.filter((p) => p.id !== 'bypassPermissions' || allowBypass() || value.permissionMode === 'bypassPermissions');
  const accId = value.account || accounts.find((a) => a.active)?.id || 'default';
  return (
    <Sheet onClose={onClose}>
      <h2>{title}</h2>
      <div className="lbl">模型</div>
      <div className="seg">{MODELS.filter((m) => m.id !== 'fable').map((m) => <button key={m.id} className={value.model === m.id ? 'on' : ''} onClick={() => onChange({ ...value, model: m.id })}>{m.label}</button>)}</div>
      <div className="lbl">思考强度</div>
      <div className="seg">{EFFORTS.map((e) => <button key={e.id} className={value.effort === e.id ? 'on' : ''} onClick={() => onChange({ ...value, effort: e.id })}>{e.label}</button>)}</div>
      <div className="lbl">权限</div>
      {perms.map((p) => (
        <button key={p.id} className="opt" onClick={() => onChange({ ...value, permissionMode: p.id })}>
          <div><div className="n">{p.label}</div><div className="d">{p.desc}</div></div>
          {value.permissionMode === p.id && <span className="ck">✓</span>}
        </button>
      ))}
      {accounts.length > 0 && <>
        <div className="lbl">账号</div>
        {accounts.map((a) => {
          const lim = !!a.limitedUntil && a.limitedUntil * 1000 > Date.now();
          const pct = a.usage?.fiveHour?.utilization;
          return (
            <button key={a.id} className="opt" onClick={() => onChange({ ...value, account: a.id })}>
              <Ring label={a.name} pct={pct ?? null} limited={lim} />
              <div><div className="n">{a.name}</div><div className="d">{!a.loggedIn ? '未登录' : lim ? `已用完 · ${new Date(a.limitedUntil! * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 恢复` : pct != null ? `5 小时额度已用 ${Math.round(pct)}%` : a.email || ''}</div></div>
              {accId === a.id && <span className="ck">✓</span>}
            </button>
          );
        })}
      </>}
      <div className="btns"><button className="btn dark" onClick={onClose}>完成</button></div>
    </Sheet>
  );
}

export function NewTaskSheet({ cwd: initialCwd, accounts, onClose, onStarted }: { cwd?: string; accounts: Account[]; onClose(): void; onStarted(sid: string): void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cwd, setCwd] = useState(initialCwd || localStorage.getItem('rcc.lastCwd') || '');
  const [text, setText] = useState('');
  const [opts, setOpts] = useState<RunOpts>(loadOpts());
  const [showOpts, setShowOpts] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Project[]>('/api/projects', undefined, { timeout: 60000 }).then((p) => { setProjects(p); if (!cwd && p[0]) setCwd(p[0].cwd); }).catch(() => {}); }, []);
  const go = async () => {
    if (!cwd.trim() || !text.trim()) return;
    setBusy(true);
    try {
      saveOpts(opts); localStorage.setItem('rcc.lastCwd', cwd.trim());
      const r = await api<{ sid: string }>('/api/start', { cwd: cwd.trim(), mkdir: true, model: opts.model || undefined, effort: opts.effort, permissionMode: opts.permissionMode, account: opts.account || undefined, title: text.trim().slice(0, 40) });
      await new Promise((res) => setTimeout(res, 600));
      for (let i = 0; i < 10; i++) {
        try { await api('/api/send', { sid: r.sid, text: text.trim() }); break; }
        catch (e: any) { if (i === 9 || !/fifo|attached|starting/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 500)); }
      }
      onStarted(r.sid);
    } catch (e: any) { toast(e.message); setBusy(false); }
  };
  const label = [MODELS.find((m) => m.id === opts.model)?.label, EFFORTS.find((e) => e.id === opts.effort)?.label].filter(Boolean).join(' · ');
  if (showOpts) return <OptionsSheet value={opts} accounts={accounts} onChange={setOpts} onClose={() => setShowOpts(false)} title="新任务设置" />;
  return (
    <Sheet onClose={onClose}>
      <h2>新任务</h2>
      <div className="lbl">项目目录</div>
      <input className="field mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/项目名" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      {projects.length > 0 && <div className="sugg" style={{ marginTop: 8 }}>{projects.slice(0, 6).map((p) => <button key={p.cwd} className="chip" onClick={() => setCwd(p.cwd)} style={cwd === p.cwd ? { color: 'var(--accent)' } : undefined}>{p.name}</button>)}</div>}
      <div className="lbl">要做什么</div>
      <textarea className="field" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="比如：给登录页加上记住我" style={{ resize: 'none' }} />
      <div className="sugg" style={{ marginTop: 10 }}><button className="chip" onClick={() => setShowOpts(true)}>{label || '默认'} · {PERMS.find((p) => p.id === opts.permissionMode)?.label}{opts.account ? ` · ${accounts.find((a) => a.id === opts.account)?.name || ''}` : ''}</button></div>
      <div className="btns"><button className="btn pri" disabled={!cwd.trim() || !text.trim() || busy} onClick={go}>{busy ? '正在启动…' : '开始'}</button></div>
    </Sheet>
  );
}
