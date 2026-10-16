// The "Claude 网页版" window: one tab per account, each its own VPS browser, with our own toolbar.
import { useEffect, useRef, useState } from 'react';
import { rc } from './api';
import { VncView } from './components/VncView';
import { Avatar, Dropdown, I } from './components/ui';
import { useTheme } from './theme';
import type { Account, DeskDownloads, DeskPage } from '../shared/types';

const params = new URLSearchParams(location.hash.slice(1));
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const prettyUrl = (u: string) => { try { const x = new URL(u); return (x.host + x.pathname + x.search).replace(/\/$/, ''); } catch { return u; } };

export function WebApp() {
  const first = params.get('web') || 'default';
  const [tabs, setTabs] = useState<string[]>([first]);
  const [cur, setCur] = useState(first);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pages, setPages] = useState<Record<string, DeskPage[]>>({});
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [dl, setDl] = useState<DeskDownloads | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const pendingUrl = useRef<Record<string, string>>(params.get('url') ? { [first]: params.get('url')! } : {});
  const toastT = useRef<any>(null);
  const mac = rc.platform === 'darwin';
  const prefs = useTheme();

  const say = (t: string) => { setToast(t); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(''), 2600); };
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name || (id === 'default' ? '默认' : id);

  useEffect(() => {
    rc.accounts.list().then((r) => setAccounts(r.accounts)).catch(() => {});
    return rc.on('web-open', ({ account, url }: { account: string; url?: string }) => {
      setTabs((t) => (t.includes(account) ? t : [...t, account]));
      setCur(account);
      if (url) pendingUrl.current[account] = url;
    });
  }, []);
  useEffect(() => { document.title = `Claude 网页版 · ${nameOf(cur)}`; });

  // follow the active account's pages (url, title, tabs)
  useEffect(() => {
    if (!ready[cur]) return;
    let stop = false;
    const tick = async () => {
      try {
        if (pendingUrl.current[cur]) { const u = pendingUrl.current[cur]; delete pendingUrl.current[cur]; await rc.desk.newTab(cur, u); }
        const p = await rc.desk.pages(cur);
        if (!stop) setPages((all) => ({ ...all, [cur]: p }));
      } catch { /* screen restarting */ }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [cur, ready[cur]]);

  // downloads, checked in the background so the button can show a badge
  useEffect(() => {
    if (!ready[cur]) return;
    const load = () => rc.desk.downloads(cur).then(setDl).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [cur, ready[cur]]);

  const closeAccount = (id: string) => {
    const rest = tabs.filter((x) => x !== id);
    if (!rest.length) { window.close(); return; }
    setTabs(rest);
    if (cur === id) setCur(rest[rest.length - 1]);
  };

  const ps = pages[cur] || [];
  const page = ps[0];
  const fresh = (dl?.files || []).filter((f) => f.mtime > (seen[cur] || Date.now() - 60000 * 60 * 24 * 365)).length;
  const run = (p: Promise<unknown>) => p.catch((e) => say(e.message));

  return (
    <div className={`webapp ${mac ? 'mac' : ''}`} style={{ fontSize: prefs?.fontSize }}>
      <div className="wtabs drag">
        {tabs.map((id) => (
          <div key={id} className={`wtab nodrag ${id === cur ? 'on' : ''}`} onClick={() => setCur(id)} title={`${nameOf(id)} 的 VPS 浏览器`}>
            <Avatar id={id} name={nameOf(id)} size={18} />
            <span className="wtab-name">{nameOf(id)}</span>
            {!ready[id] && <span className="spin xs" />}
            <button className="wtab-x" onClick={(e) => { e.stopPropagation(); closeAccount(id); }} title="关闭">{I.x(12)}</button>
          </div>
        ))}
        <Dropdown className="icon-btn nodrag" down trigger={I.plus(15)}>
          {(close) => <>
            <div className="mh2">用其他账号打开</div>
            {accounts.filter((a) => !tabs.includes(a.id)).map((a) => (
              <button key={a.id} className="mi" onClick={() => { close(); setTabs((t) => [...t, a.id]); setCur(a.id); }}>
                <Avatar id={a.id} name={a.name} size={18} /> {a.name}<span className="r">{a.email || (a.loggedIn ? '' : '未登录')}</span>
              </button>
            ))}
            {accounts.every((a) => tabs.includes(a.id)) && <div className="mi dim">所有账号都已打开</div>}
          </>}
        </Dropdown>
        <div className="grow" />
      </div>

      <div className="wbar">
        <button className="icon-btn" title="后退" disabled={!page} onClick={() => run(rc.desk.history(cur, -1))}>{I.back(15)}</button>
        <button className="icon-btn flip" title="前进" disabled={!page} onClick={() => run(rc.desk.history(cur, 1))}>{I.back(15)}</button>
        <button className="icon-btn" title="刷新" disabled={!page} onClick={() => run(rc.desk.reload(cur))}>{I.refresh(14)}</button>
        <div className={`wurl ${editing !== null ? 'edit' : ''}`}>
          {page?.url.startsWith('https:') && editing === null && <span className="wurl-lock">{I.lock(11)}</span>}
          <input value={editing ?? (page ? prettyUrl(page.url) : '')} placeholder="输入网址或搜索" spellCheck={false}
            onFocus={(e) => { setEditing(page?.url || ''); setTimeout(() => e.target.select(), 0); }}
            onBlur={() => setEditing(null)}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && editing) { run(rc.desk.navigate(cur, editing)); (e.target as HTMLInputElement).blur(); }
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }} />
        </div>
        <Dropdown className="icon-btn wcount" align="right" down trigger={<span className="pagecount" title="标签页">{Math.max(ps.length, 1)}</span>}>
          {(close) => <>
            <div className="mh2">标签页</div>
            {ps.map((p, i) => (
              <div key={p.id} className={`mi ${i === 0 ? 'cur' : ''}`} onClick={() => { close(); run(rc.desk.activate(cur, p.id)); }}>
                <span className="grow ellipsis">{p.title || prettyUrl(p.url)}</span>
                <button className="icon-btn sm" title="关闭标签页" onClick={(e) => { e.stopPropagation(); run(rc.desk.closeTab(cur, p.id)); }}>{I.x(12)}</button>
              </div>
            ))}
            <button className="mi" onClick={() => { close(); run(rc.desk.newTab(cur)); }}>{I.plus(13)} 新标签页（Claude）</button>
          </>}
        </Dropdown>
        <button className="icon-btn" title="上传文件到当前网页（也可以直接拖进画面或粘贴截图）" disabled={!page} onClick={() => run(rc.desk.upload(cur).then((r) => r.count && say(`已添加 ${r.count} 个文件到网页`)))}>{I.upload(15)}</button>
        <Dropdown className="icon-btn" align="right" down trigger={<span className="badge-wrap" title="下载" onClick={() => setSeen((s) => ({ ...s, [cur]: Date.now() }))}>{I.download(15)}{fresh > 0 && <span className="cnt-badge">{fresh}</span>}</span>}>
          {(close) => <div className="dlmenu">
            <div className="mh2">在网页里下载的文件{dl?.partial ? ` · ${dl.partial} 个下载中` : ''}</div>
            {!dl?.files.length && <div className="mi dim">还没有下载</div>}
            {dl?.files.slice(0, 12).map((f) => (
              <div key={f.path} className="mi">
                <span className="grow ellipsis" title={f.name}>{f.name}</span>
                <span className="r">{fmtSize(f.size)}</span>
                <button className="btn sm" onClick={() => { close(); rc.desk.saveDownload(f.path).then((p) => p && say(`已保存到 ${p}`)).catch((e) => say(e.message)); }}>保存到本地</button>
              </div>
            ))}
          </div>}
        </Dropdown>
      </div>

      <div className="wbody">
        {tabs.map((id) => (
          <VncView key={id} account={id} active={id === cur} onToast={say} onConnected={() => setReady((r) => ({ ...r, [id]: true }))} />
        ))}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}
