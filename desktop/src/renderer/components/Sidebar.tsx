import { useState } from 'react';
import { Dropdown, I, QuotaAvatar, ago, resetText } from './ui';
import type { Account } from '../../shared/types';

export interface SideSession { key: string; title: string; live: boolean; busy: boolean; branch?: string | null; updatedAt?: string }
export interface SideProject { cwd: string; name: string; sessions: SideSession[] }

export function Sidebar(p: {
  projects: SideProject[];
  activeKey: string | null;
  activeCwd: string | null;
  server: { name: string; dot: 'ok' | 'warn' | 'err' | ''; label: string };
  loadingProjects: boolean;
  onNew(cwd?: string): void;
  onOpen(key: string): void;
  onAddProject(): void;
  onWorktree(cwd: string): void;
  onRemoveProject(cwd: string): void;
  onRefresh(): void;
  onSettings(page?: string): void;
  accounts: Account[];
  activeAccount: string | null;
  onUseAccount(id: string): void;
  onAddAccount(): void;
  onWeb(id: string): void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const isOpen = (cwd: string, i: number) => open[cwd] ?? (i === 0 || cwd === p.activeCwd);

  return (
    <aside className="side">
      <div className="titlespace drag" />
      <button className="side-btn" onClick={() => p.onNew()}>{I.compose()}新建会话<span className="kbd">{navigator.platform.includes('Mac') ? '⌘N' : 'Ctrl+N'}</span></button>
      <div className="sec">
        <span>项目</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" title="刷新" onClick={p.onRefresh}>{p.loadingProjects ? <div className="spin" style={{ width: 11, height: 11 }} /> : I.refresh()}</button>
          <button className="icon-btn" title="添加项目" onClick={p.onAddProject}>{I.plus()}</button>
        </span>
      </div>
      <div className="tree">
        {p.projects.length === 0 && !p.loadingProjects && <div className="side-note">还没有项目。点 ＋ 添加 VPS 上的一个目录。</div>}
        {p.projects.map((pr, i) => {
          const o = isOpen(pr.cwd, i);
          const list = showAll[pr.cwd] ? pr.sessions : pr.sessions.slice(0, 6);
          return (
            <div key={pr.cwd}>
              <div className="proj" title={pr.cwd} onClick={() => setOpen({ ...open, [pr.cwd]: !o })}>
                <span className={`chev ${o ? 'open' : ''}`}>▶</span>
                {I.folder()}
                <span className="name">{pr.name}</span>
                {pr.sessions.some((s) => s.busy) ? <span className="dot pulse" /> : <span className="cnt">{pr.sessions.length || ''}</span>}
                <span className="acts">
                  <button className="icon-btn" title="在此项目新建会话" onClick={(e) => { e.stopPropagation(); p.onNew(pr.cwd); }}>{I.plus(13)}</button>
                  <Dropdown className="icon-btn" align="right" down trigger={I.more(13)}>
                    {(close) => <>
                      <button className="mi" onClick={() => { close(); p.onNew(pr.cwd); }}>新建会话</button>
                      <button className="mi" onClick={() => { close(); p.onWorktree(pr.cwd); }}>新建并行任务（worktree）</button>
                      <div className="msep" />
                      <button className="mi" onClick={() => { close(); navigator.clipboard.writeText(pr.cwd); }}>复制路径</button>
                      <button className="mi danger" onClick={() => { close(); p.onRemoveProject(pr.cwd); }}>从列表移除</button>
                    </>}
                  </Dropdown>
                </span>
              </div>
              {o && list.map((s) => (
                <div key={s.key} className={`sess ${s.key === p.activeKey ? 'on' : ''}`} onClick={() => p.onOpen(s.key)} title={s.title}>
                  {s.live && <span className={`dot ${s.busy ? 'pulse' : ''}`} style={s.busy ? undefined : { background: 'var(--green)' }} />}
                  <span className="t">{s.title}</span>
                  {s.branch ? <span className="br">{s.branch}</span> : <span className="meta">{s.live && s.busy ? '运行中' : ago(s.updatedAt)}</span>}
                </div>
              ))}
              {o && pr.sessions.length > 6 && !showAll[pr.cwd] && <div className="more" onClick={() => setShowAll({ ...showAll, [pr.cwd]: true })}>显示全部 {pr.sessions.length} 个</div>}
            </div>
          );
        })}
        <div className="side-note">会话读取自 VPS 的 ~/.claude/projects</div>
      </div>
      {p.accounts.length > 0 && <AccountSwitch {...p} />}
      <div className="foot">
        <button className="srv" onClick={() => p.onSettings('server')} title={p.server.label}>
          <span className={`sdot ${p.server.dot}`} /><span>{p.server.name}</span>
        </button>
        <button className="icon-btn" title="设置" onClick={() => p.onSettings()}>{I.gear()}</button>
      </div>
    </aside>
  );
}

const mod = (window as any).rc?.platform === 'darwin' ? '⌘' : 'Ctrl+';
function AccountSwitch(p: { accounts: Account[]; activeAccount: string | null; onUseAccount(id: string): void; onAddAccount(): void; onSettings(page?: string): void; onWeb(id: string): void }) {
  const cur = p.accounts.find((a) => a.id === p.activeAccount) || p.accounts[0];
  const now = Date.now() / 1000;
  return (
    <div style={{ padding: '6px 0 8px' }}>
      <Dropdown className="acc-btn" align="left" trigger={<>
        <QuotaAvatar a={cur} />
        <span>{cur.name}</span>
        {cur.plan && <span className="plan">· {cur.plan.replace(/^./, (c) => c.toUpperCase())}</span>}
        <span className="chev2">⌃</span>
      </>}>
        {(close) => <div className="acc-menu">
          <div style={{ fontSize: 11.5, color: 'var(--faint)', padding: '6px 10px 4px' }}>切换账号</div>
          {p.accounts.map((a) => {
            const lim = a.limitedUntil && a.limitedUntil > now;
            return (
              <button key={a.id} className={`acc-item ${a.id === cur.id ? 'on' : ''}`} onClick={() => { close(); if (a.loggedIn) p.onUseAccount(a.id); else p.onSettings('account'); }}>
                <QuotaAvatar a={a} />
                <div style={{ minWidth: 0 }}><div>{a.name}</div><div className="e">{!a.loggedIn ? '未登录' : lim ? `额度用完 · ${resetText(a.limitedUntil)}` : a.email || a.plan || ''}</div></div>
                <span className={`r ${lim ? 'bad' : ''}`}>{a.id === cur.id ? '✓' : ''}</span>
                <span className="icon-btn" role="button" title="用这个账号打开 Claude 网页版" onClick={(e) => { e.stopPropagation(); close(); p.onWeb(a.id); }}>{I.globe(14)}</span>
              </button>
            );
          })}
          <div className="msep" />
          <button className="mi" onClick={() => { close(); p.onWeb(cur.id); }}>{I.globe(14)} 打开 Claude 网页版（{cur.name}）<span className="kbd2">{mod}⇧B</span></button>
          <button className="mi" onClick={() => { close(); p.onAddAccount(); }}>＋ 添加账号</button>
          <button className="mi" onClick={() => { close(); p.onSettings('account'); }}>管理账号…</button>
        </div>}
      </Dropdown>
    </div>
  );
}
