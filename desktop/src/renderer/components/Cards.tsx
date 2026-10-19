import { useEffect, useState } from 'react';
import { rc } from '../api';
import { Deck, type DeckItem } from './Deck';
import './deck.css';
import { fileKind, isLocalUrl } from '../transcript';

// ---------- link cards: title, site, icon and picture fetched on the server (this computer never touches the site) ----------
interface Unfurl { url: string; site?: string; title?: string | null; description?: string | null; icon?: string | null; image?: string | null; local?: boolean; port?: number; path?: string; error?: string }
const cache = new Map<string, Promise<Unfurl>>();
const unfurl = (url: string) => {
  if (!cache.has(url)) cache.set(url, rc.x(['unfurl', '--url', url]).catch(() => ({ url })));
  return cache.get(url)!;
};

export function LinkCards({ urls, account }: { urls: string[]; account: string }) {
  const [info, setInfo] = useState<Record<string, Unfurl>>({});
  useEffect(() => {
    let on = true;
    for (const u of urls) if (!isLocalUrl(u)) unfurl(u).then((r) => on && setInfo((x) => ({ ...x, [u]: r })));
    return () => { on = false; };
  }, [urls.join(' ')]);
  if (!urls.length) return null;
  const items: DeckItem[] = urls.map((url) => {
    let host = url; try { host = new URL(url).host.replace(/^www\./, ''); } catch { /* keep */ }
    if (isLocalUrl(url)) {
      const x = new URL(url); const port = Number(x.port || 80);
      return { key: url, title: `服务器上的网页`, sub: `端口 ${port}${x.pathname !== '/' ? ' · ' + x.pathname : ''}`, badge: 'localhost', glyph: `:${port}`, color: '#d97757', thumb: null, note: 'Claude 在服务器上启动的预览，只有你能打开',
        actions: [{ label: '预览', primary: true, run: () => rc.claude.previewPort(port, x.pathname + x.search) }, { label: '复制链接', run: () => navigator.clipboard.writeText(url) }] };
    }
    const u = info[url];
    return { key: url, title: u ? u.title || url.replace(/^https?:\/\//, '') : host, sub: u?.description || url.replace(/^https?:\/\//, ''), badge: u?.site || host, color: hue(host), thumb: u ? u.image || null : undefined, icon: u?.icon, wide: !!u?.image,
      note: '标题和图片由服务器抓取，你的电脑没有访问这个网站',
      actions: [{ label: '在本机打开', primary: true, run: () => rc.app.openExternal(url) }, { label: '用服务器浏览器打开', run: () => rc.web.open(account, url) }, { label: '复制链接', run: () => navigator.clipboard.writeText(url) }] };
  });
  return <Deck items={items} />;
}
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 52%)`; };

// ---------- file cards: what Claude made (documents, pictures, media) ----------
const KIND_COLOR: Record<string, string> = { image: '#0ea5e9', pdf: '#e11d48', sheet: '#16a34a', slides: '#f59e0b', doc: '#2563eb', media: '#a855f7', zip: '#71717a', text: '#52525b' };
const thumbCache = new Map<string, Promise<string | null>>();
const thumbOf = (abs: string, k: string) => {
  if (!/^(image|pdf|doc)$/.test(k)) return Promise.resolve(null);
  if (!thumbCache.has(abs)) thumbCache.set(abs, rc.x(['thumb', '--path', abs]).then((r: any) => r.thumb || null).catch(() => null));
  return thumbCache.get(abs)!;
};
export function FileCards({ paths, cwd }: { paths: string[]; cwd: string }) {
  const abs = (rel: string) => (rel.startsWith('/') ? rel : `${cwd.replace(/\/+$/, '')}/${rel}`);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let on = true;
    for (const p of paths) thumbOf(abs(p), fileKind(p).icon).then((t) => on && setThumbs((x) => ({ ...x, [p]: t })));
    return () => { on = false; };
  }, [paths.join('\n'), cwd]);
  if (!paths.length) return null;
  const items: DeckItem[] = paths.map((rel) => {
    const k = fileKind(rel);
    const name = rel.split('/').pop() || rel;
    const dir = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '';
    return { key: rel, title: name, sub: dir || undefined, badge: (name.split('.').pop() || '').toUpperCase(), color: KIND_COLOR[k.icon], thumb: rel in thumbs ? thumbs[rel] : undefined,
      actions: [{ label: '打开', primary: true, run: () => rc.files.open(abs(rel)) }, { label: '保存到电脑', run: async () => { await rc.files.save(abs(rel)); } }] };
  });
  return <Deck items={items} />;
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
