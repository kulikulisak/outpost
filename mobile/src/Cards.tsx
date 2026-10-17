// Link cards, file cards and the / @ menu on the phone. Link previews are fetched by the server,
// so the phone never touches the site until you open it.
import { useEffect, useState } from 'react';
import { api, auth } from './api';
import { I, toast } from './ui';
import { fileKind, isLocalUrl } from '@desktop/transcript';

const rcc = <T = any,>(argv: string[], stdin?: string) => api<{ stdout: string }>('/api/rcc', { argv, stdin }, { timeout: 30000 }).then((r) => JSON.parse(r.stdout) as T);
export { rcc };

interface Unfurl { url: string; site?: string; title?: string | null; description?: string | null; icon?: string | null; image?: string | null }
const cache = new Map<string, Promise<Unfurl>>();
const unfurl = (url: string) => { if (!cache.has(url)) cache.set(url, rcc<Unfurl>(['unfurl', '--url', url]).catch(() => ({ url }))); return cache.get(url)!; };

export const native = (window as any).OutpostNative as undefined | { openUrl(u: string): void; saveFile(name: string, mime: string, b64: string): void; shareFile(name: string, mime: string, b64: string): void; resetServer(): void; server(): string };
export const openExternal = (u: string) => { if (native) native.openUrl(u); else window.open(u, '_blank', 'noopener'); };

export function LinkCards({ urls, onServerBrowser }: { urls: string[]; onServerBrowser(url: string): void }) {
  if (!urls.length) return null;
  return <div className="lcards">{urls.map((u) => <LinkCard key={u} url={u} onServerBrowser={onServerBrowser} />)}</div>;
}
function LinkCard({ url, onServerBrowser }: { url: string; onServerBrowser(url: string): void }) {
  const local = isLocalUrl(url);
  const [u, setU] = useState<Unfurl | null>(null);
  useEffect(() => { if (!local) { let on = true; unfurl(url).then((r) => on && setU(r)); return () => { on = false; }; } }, [url, local]);
  let host = url; try { host = new URL(url).host.replace(/^www\./, ''); } catch { /* keep */ }
  if (local) {
    const x = new URL(url);
    const open = async () => {
      if (native) { try { const r = await api<{ url: string }>('/api/preview', { port: Number(x.port || 80), path: x.pathname + x.search }); native.openUrl(r.url); } catch (e: any) { toast(e.message); } return; }
      const w = window.open('about:blank', '_blank');
      try { const r = await api<{ url: string }>('/api/preview', { port: Number(x.port || 80), path: x.pathname + x.search }); if (w) w.location.href = r.url; else location.href = r.url; }
      catch (e: any) { w?.close(); toast(e.message); }
    };
    return (
      <div className="lcard local">
        <span className="lc-ic">{I.globe}</span>
        <div className="lc-b"><b>服务器上的网页 · 端口 {x.port || 80}</b><span>Claude 启动的预览，只有你能打开</span></div>
        <button className="y" onClick={open}>预览</button>
      </div>
    );
  }
  return (
    <div className="lcard">
      <button className="lc-main" onClick={() => openExternal(url)}>
        {u?.image && <img className="lc-img" src={u.image} alt="" />}
        <div className="lc-b">
          <span className="lc-site">{u?.icon ? <img src={u.icon} alt="" /> : null}{u?.site || host}</span>
          <b>{u ? u.title || url.replace(/^https?:\/\//, '') : '…'}</b>
          {u?.description && <span>{u.description}</span>}
        </div>
      </button>
      <div className="lc-acts">
        <button onClick={() => openExternal(url)}>打开</button>
        <button onClick={() => onServerBrowser(url)}>服务器浏览器</button>
        <button onClick={() => navigator.clipboard?.writeText(url).then(() => toast('已复制链接'))}>复制</button>
      </div>
    </div>
  );
}

// ---------- files Claude made ----------
const KIND_COLOR: Record<string, string> = { image: '#0ea5e9', pdf: '#e11d48', sheet: '#16a34a', slides: '#f59e0b', doc: '#2563eb', media: '#a855f7', zip: '#71717a', text: '#52525b' };
const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'video/mp4', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };
async function fetchFile(abs: string): Promise<Blob> {
  const r = await fetch(`/api/file?path=${encodeURIComponent(abs)}`, { headers: { Authorization: `Bearer ${auth.token}` } });
  if (!r.ok) throw new Error(r.status === 404 ? '文件不存在了' : `下载失败（${r.status}）`);
  const ext = (abs.split('.').pop() || '').toLowerCase();
  return new Blob([await r.arrayBuffer()], { type: MIME[ext] || 'application/octet-stream' });
}
const b64 = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(b); });

export function FileCards({ paths, cwd }: { paths: string[]; cwd: string }) {
  if (!paths.length) return null;
  return <div className="fcards">{paths.map((p) => <FileCard key={p} rel={p} cwd={cwd} />)}</div>;
}
function FileCard({ rel, cwd }: { rel: string; cwd: string }) {
  const abs = rel.startsWith('/') ? rel : `${cwd.replace(/\/+$/, '')}/${rel}`;
  const name = rel.split('/').pop() || rel;
  const k = fileKind(rel);
  const [busy, setBusy] = useState(false);
  const viewable = /^(image|pdf|text|media)$/.test(k.icon);
  const canShare = !!native || typeof (navigator as any).share === 'function';
  const act = async (what: 'open' | 'save' | 'share') => {
    if (busy) return;
    setBusy(true);
    const w = what === 'open' && viewable && !native ? window.open('about:blank', '_blank') : null;
    try {
      const blob = await fetchFile(abs);
      if (native) { const data = await b64(blob); if (what === 'share') native.shareFile(name, blob.type, data); else native.saveFile(name, blob.type, data); if (what !== 'share') toast('已保存到「下载」'); return; }
      if (what === 'share' && navigator.canShare?.({ files: [new File([blob], name, { type: blob.type })] })) { await navigator.share({ files: [new File([blob], name, { type: blob.type })], title: name }); return; }
      const url = URL.createObjectURL(blob);
      if (w) { w.location.href = url; } else { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) { w?.close(); if (e?.name !== 'AbortError') toast(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="fcard">
      <span className="fc-ic" style={{ background: KIND_COLOR[k.icon] }}>{(name.split('.').pop() || '').slice(0, 4).toUpperCase()}</span>
      <button className="fc-b" onClick={() => act('open')}><b>{name}</b><span>{busy ? '正在下载…' : k.label}</span></button>
      <button className="fc-a" onClick={() => act(canShare ? 'share' : 'save')}>{canShare ? '分享' : '保存'}</button>
    </div>
  );
}

// ---------- / commands and @ files ----------
export interface MenuItem { key: string; label: string; desc?: string; insert: string; run?: 'clear' }
const BUILTIN: MenuItem[] = [
  { key: 'b:compact', label: '/compact', desc: '压缩对话，聊久了变慢时用', insert: '/compact' },
  { key: 'b:clear', label: '/clear', desc: '开一个新对话', insert: '', run: 'clear' },
];
const cmdCache = new Map<string, Promise<MenuItem[]>>();
export function slashItems(cwd: string, q: string): Promise<MenuItem[]> {
  if (!cmdCache.has(cwd)) { cmdCache.set(cwd, rcc<any[]>(['commands', '--cwd', cwd]).then((l) => l.map((c) => ({ key: `c:${c.source}:${c.name}`, label: c.skill ? c.name : `/${c.name}`, desc: c.description || (c.skill ? '技能' : '命令'), insert: c.skill ? `用「${c.name}」技能：` : `/${c.name}` }))).catch(() => [])); setTimeout(() => cmdCache.delete(cwd), 60000); }
  return cmdCache.get(cwd)!.then((custom) => [...BUILTIN, ...custom].filter((m) => !q || m.label.toLowerCase().includes(q.toLowerCase())).slice(0, 10));
}
export async function fileItems(cwd: string, q: string): Promise<MenuItem[]> {
  const l = await rcc<string[]>(['files', '--cwd', cwd, '--q', q || '', '--limit', '10']).catch(() => [] as string[]);
  return l.map((f) => ({ key: `f:${f}`, label: f.split('/').pop() || f, desc: f.includes('/') ? f : undefined, insert: `@${/\s/.test(f) ? `"${f}"` : f} ` }));
}
export function trigger(text: string, caret: number): { kind: '/' | '@'; q: string; start: number } | null {
  const before = text.slice(0, caret);
  const s = before.match(/^\/([^\s]*)$/);
  if (s) return { kind: '/', q: s[1], start: 0 };
  const a = before.match(/(^|\s)@([^\s@]*)$/);
  if (a) return { kind: '@', q: a[2], start: caret - a[2].length - 1 };
  return null;
}
