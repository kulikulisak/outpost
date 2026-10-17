import { useEffect, useState } from 'react';
import { rc } from '../api';
import { I } from './ui';
import { fileKind, isLocalUrl } from '../transcript';

// ---------- link cards: title, site, icon and picture fetched on the server (this computer never touches the site) ----------
interface Unfurl { url: string; site?: string; title?: string | null; description?: string | null; icon?: string | null; image?: string | null; local?: boolean; port?: number; path?: string; error?: string }
const cache = new Map<string, Promise<Unfurl>>();
const unfurl = (url: string) => {
  if (!cache.has(url)) cache.set(url, rc.x(['unfurl', '--url', url]).catch(() => ({ url })));
  return cache.get(url)!;
};

export function LinkCards({ urls, account }: { urls: string[]; account: string }) {
  if (!urls.length) return null;
  return <div className="lcards">{urls.map((u) => <LinkCard key={u} url={u} account={account} />)}</div>;
}

function LinkCard({ url, account }: { url: string; account: string }) {
  const local = isLocalUrl(url);
  const [u, setU] = useState<Unfurl | null>(local ? { url, local: true } : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!local) { let on = true; unfurl(url).then((r) => on && setU(r)); return () => { on = false; }; } }, [url, local]);
  let host = url; try { const x = new URL(url); host = x.host.replace(/^www\./, ''); } catch { /* keep */ }

  if (local) {
    const x = new URL(url);
    const port = Number(x.port || 80);
    const open = async () => { setBusy(true); setErr(''); try { await rc.claude.previewPort(port, x.pathname + x.search); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
    return (
      <div className="lcard local">
        <div className="lc-ic">{I.globe(16)}</div>
        <div className="lc-b">
          <div className="lc-t">服务器上的网页 · 端口 {port}</div>
          <div className="lc-s">{err || 'Claude 在服务器上启动的预览，只有你能打开'}</div>
        </div>
        <button className="btn p sm" disabled={busy} onClick={open}>{busy ? <div className="spin" /> : '预览'}</button>
      </div>
    );
  }
  return (
    <div className="lcard" title={url}>
      <div className="lc-main" onClick={() => rc.app.openExternal(url)}>
        {u?.image && <img className="lc-img" src={u.image} alt="" />}
        <div className="lc-b">
          <div className="lc-site">{u?.icon ? <img src={u.icon} alt="" /> : I.globe(12)}<span>{u?.site || host}</span></div>
          <div className="lc-t">{u ? u.title || url.replace(/^https?:\/\//, '') : <span className="lc-skel" />}</div>
          {u?.description && <div className="lc-s">{u.description}</div>}
        </div>
      </div>
      <div className="lc-acts">
        <button className="lc-a" onClick={() => rc.app.openExternal(url)}>在本机打开</button>
        <button className="lc-a" onClick={() => rc.web.open(account, url)} title="用服务器上的浏览器打开，网站看到的是服务器的环境">用服务器浏览器打开</button>
        <button className="lc-a" onClick={() => navigator.clipboard.writeText(url)}>复制链接</button>
      </div>
    </div>
  );
}

// ---------- file cards: what Claude made (documents, pictures, media) ----------
const KIND_COLOR: Record<string, string> = { image: '#0ea5e9', pdf: '#e11d48', sheet: '#16a34a', slides: '#f59e0b', doc: '#2563eb', media: '#a855f7', zip: '#71717a', text: '#52525b' };
export function FileCards({ paths, cwd }: { paths: string[]; cwd: string }) {
  if (!paths.length) return null;
  return <div className="fcards">{paths.map((p) => <FileCard key={p} rel={p} cwd={cwd} />)}</div>;
}
function FileCard({ rel, cwd }: { rel: string; cwd: string }) {
  const abs = rel.startsWith('/') ? rel : `${cwd.replace(/\/+$/, '')}/${rel}`;
  const k = fileKind(rel);
  const name = rel.split('/').pop() || rel;
  const [busy, setBusy] = useState<'' | 'open' | 'save'>('');
  const [msg, setMsg] = useState('');
  const run = async (b: 'open' | 'save') => {
    setBusy(b); setMsg('');
    try { if (b === 'open') await rc.files.open(abs); else { const r = await rc.files.save(abs); if (r) setMsg('已保存'); } }
    catch (e: any) { setMsg(e.message); } finally { setBusy(''); }
  };
  return (
    <div className="fcard">
      <div className="fc-ic" style={{ background: KIND_COLOR[k.icon] }}>{(name.split('.').pop() || '').slice(0, 4).toUpperCase()}</div>
      <div className="fc-b" onClick={() => run('open')}>
        <div className="fc-n">{name}</div>
        <div className="fc-s">{msg || `${k.label}${rel.includes('/') ? ` · ${rel.split('/').slice(0, -1).join('/')}` : ''}`}</div>
      </div>
      <button className="btn sm" disabled={!!busy} onClick={() => run('open')}>{busy === 'open' ? <div className="spin" /> : '打开'}</button>
      <button className="icon-btn" title="保存到电脑" disabled={!!busy} onClick={() => run('save')}>{busy === 'save' ? <div className="spin" /> : I.download(15)}</button>
    </div>
  );
}

// ---------- composer helpers: / commands and @ files ----------
export interface MenuItem { key: string; label: string; desc?: string; insert: string; run?: 'clear' }
const BUILTIN: MenuItem[] = [
  { key: 'b:compact', label: '/compact', desc: '压缩对话上下文，聊久了变慢时用', insert: '/compact' },
  { key: 'b:clear', label: '/clear', desc: '开一个新对话', insert: '', run: 'clear' },
];
const cmdCache = new Map<string, Promise<MenuItem[]>>();
export function slashItems(cwd: string, q: string): Promise<MenuItem[]> {
  if (!cmdCache.has(cwd)) cmdCache.set(cwd, rc.x(['commands', '--cwd', cwd]).then((l: any[]) => l.map((c) => ({ key: `c:${c.source}:${c.name}`, label: c.skill ? c.name : `/${c.name}`, desc: c.description || (c.skill ? '技能' : c.source === 'project' ? '项目命令' : '我的命令'), insert: c.skill ? `用「${c.name}」技能：` : `/${c.name}` }))).catch(() => []));
  setTimeout(() => cmdCache.delete(cwd), 60000);
  return cmdCache.get(cwd)!.then((custom) => [...BUILTIN, ...custom].filter((m) => !q || m.label.toLowerCase().includes(q.toLowerCase()) || (m.desc || '').includes(q)).slice(0, 12));
}
export async function fileItems(cwd: string, q: string): Promise<MenuItem[]> {
  const l: string[] = await rc.x(['files', '--cwd', cwd, '--q', q || '', '--limit', '12']).catch(() => []);
  return l.map((f) => ({ key: `f:${f}`, label: f.split('/').pop() || f, desc: f.includes('/') ? f : undefined, insert: `@${/\s/.test(f) ? `"${f}"` : f} ` }));
}
/** What the caret is in the middle of: "/word" at the very start, or "@word" anywhere. */
export function trigger(text: string, caret: number): { kind: '/' | '@'; q: string; start: number } | null {
  const before = text.slice(0, caret);
  const s = before.match(/^\/([^\s]*)$/);
  if (s) return { kind: '/', q: s[1], start: 0 };
  const a = before.match(/(^|\s)@([^\s@]*)$/);
  if (a) return { kind: '@', q: a[2], start: caret - a[2].length - 1 };
  return null;
}
