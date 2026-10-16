import { useEffect, useState } from 'react';
import { api, auth, feed, setUnauthorizedHandler, type Account, type LiveSession, type Me } from './api';
import { I, ToastHost, toast } from './ui';
import { Pair } from './Pair';
import { NewTaskSheet, OptionsSheet, ProjectsPage, SessionsPage, loadOpts, saveOpts, type Open } from './Lists';
import { Chat } from './Chat';
import { WebPage } from './Web';
import { SettingsPage } from './Settings';
import { registerSW } from './push';

type Tab = 'sessions' | 'projects' | 'web' | 'settings';

function openFromHash(): Open | null {
  const m = location.hash.match(/s=([\w-]+)/);
  return m ? { sid: m[1] } : null;
}

export function App() {
  const [paired, setPaired] = useState(!!auth.token);
  const [tab, setTab] = useState<Tab>('sessions');
  const [open, setOpen] = useState<Open | null>(openFromHash);
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [newTask, setNewTask] = useState<{ cwd?: string } | null>(null);
  const [accSheet, setAccSheet] = useState(false);

  useEffect(() => { setUnauthorizedHandler(() => { auth.set(null); setPaired(false); toast('配对已失效，请重新配对'); }); }, []);
  useEffect(() => {
    if (!paired) return;
    registerSW();
    const t0 = performance.now();
    api<Me>('/api/me').then((m) => { setMe(m); setLatency(Math.round(performance.now() - t0)); localStorage.setItem('rcc.server', m.server); if (m.url) localStorage.setItem('rcc.directUrl', m.url); }).catch(() => {});
    const loadAcc = () => api<{ accounts: Account[] }>('/api/accounts?usage=1', undefined, { timeout: 30000 }).then((r) => setAccounts(r.accounts)).catch(() => {});
    loadAcc();
    const accTimer = setInterval(loadAcc, 120000);
    const stop = feed(setSessions, setConnected);
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'open' && e.data.sid) setOpen({ sid: e.data.sid }); };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => { stop(); clearInterval(accTimer); navigator.serviceWorker?.removeEventListener('message', onMsg); };
  }, [paired]);

  // keep the open conversation in the URL so a notification tap or a reload lands on it
  useEffect(() => {
    const want = open && 'sid' in open ? `#s=${open.sid}` : '';
    if (location.hash !== want && !/pair=/.test(location.hash)) history.replaceState(null, '', location.pathname + want);
  }, [open]);
  useEffect(() => {
    const onPop = () => { const o = openFromHash(); if (o) setOpen(o); };
    window.addEventListener('hashchange', onPop);
    return () => window.removeEventListener('hashchange', onPop);
  }, []);

  if (!paired) return <><Pair onDone={() => setPaired(true)} /><ToastHost /></>;

  const useAccount = async (o: { account: string }) => {
    const target = accounts.find((a) => a.id === o.account);
    if (!target || target.active) return;
    try { await api('/api/accounts/use', { id: o.account }); setAccounts(accounts.map((a) => ({ ...a, active: a.id === o.account }))); const s = loadOpts(); saveOpts({ ...s, account: o.account }); toast(`新任务会用「${target.name}」`); } catch (e: any) { toast(e.message); }
  };

  return (
    <div className="app">
      {open ? (
        <Chat key={JSON.stringify(open)} open={open} sessions={sessions} accounts={accounts} onBack={() => setOpen(null)} onSwitch={(sid) => setOpen({ sid })} />
      ) : (
        <>
          {tab === 'sessions' && <SessionsPage sessions={sessions} connected={connected} server={me?.server || localStorage.getItem('rcc.server') || ''} accounts={accounts} onOpen={setOpen} onNew={() => setNewTask({})} onAccounts={() => setAccSheet(true)} />}
          {tab === 'projects' && <ProjectsPage onOpen={setOpen} onNew={(cwd) => setNewTask({ cwd })} />}
          <div className="page" style={{ display: tab === 'web' ? 'flex' : 'none' }}><WebPage accounts={accounts} visible={tab === 'web' && !open} /></div>
          {tab === 'settings' && <SettingsPage me={me} connected={connected} latency={latency} onUnpaired={() => setPaired(false)} />}
          <nav className="tabbar">
            {([['sessions', '会话', I.chat], ['projects', '项目', I.folder], ['web', '网页版', I.globe], ['settings', '设置', I.gear]] as const).map(([k, l, ic]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{ic}<span>{l}{k === 'sessions' && sessions?.some((s) => s.pending?.length) ? ' •' : ''}</span></button>
            ))}
          </nav>
        </>
      )}
      {newTask && <NewTaskSheet cwd={newTask.cwd} accounts={accounts} onClose={() => setNewTask(null)} onStarted={(sid) => { setNewTask(null); setTab('sessions'); setOpen({ sid }); }} />}
      {accSheet && <OptionsSheet value={{ ...loadOpts(), account: accounts.find((a) => a.active)?.id || '' }} accounts={accounts} onChange={(v) => { saveOpts(v); useAccount(v); }} onClose={() => setAccSheet(false)} title="新任务默认设置" />}
      <ToastHost />
    </div>
  );
}
