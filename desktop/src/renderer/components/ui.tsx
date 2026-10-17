import type { Account } from '../../shared/types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const P = (d: ReactNode, size = 16, sw = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
export const I = {
  compose: (s = 16) => P(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, s),
  folder: (s = 15) => P(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />, s),
  plus: (s = 15) => P(<><path d="M12 5v14" /><path d="M5 12h14" /></>, s, 2),
  more: (s = 15) => P(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>, s, 2.4),
  globe: (s = 15) => P(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, s),
  gear: (s = 16) => P(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>, s),
  lock: (s = 13) => P(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, s, 2),
  up: (s = 16) => P(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>, s, 2.2),
  stop: (s = 12) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>,
  clock: (s = 14) => P(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, s, 2),
  back: (s = 14) => P(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>, s, 2),
  server: (s = 15) => P(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /></>, s),
  wrench: (s = 15) => P(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5Z" />, s),
  user: (s = 15) => P(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, s),
  chat: (s = 15) => P(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />, s),
  sun: (s = 15) => P(<><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /></>, s),
  branch: (s = 13) => P(<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8" /><path d="M18 10a6 6 0 0 1-6 6H8" /></>, s, 2),
  refresh: (s = 13) => P(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>, s, 2),
  check: (s = 14) => P(<path d="M20 6 9 17l-5-5" />, s, 2.4),
  upload: (s = 15) => P(<><path d="M12 16V4" /><path d="m6 10 6-6 6 6" /><path d="M4 20h16" /></>, s, 2),
  download: (s = 15) => P(<><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></>, s, 2),
  clip: (s = 15) => P(<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2L9.8 17a1.8 1.8 0 0 1-2.6-2.6L15 6.6" />, s, 1.9),
  file: (s = 14) => P(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>, s),
  image: (s = 13) => P(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>, s),
  phone: (s = 15) => P(<><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>, s),
  x: (s = 14) => P(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, s, 2),
};

// links in Claude's replies open outside the app (a new tab / the computer's browser), never in place
DOMPurify.addHook('afterSanitizeAttributes', (n: Element) => { if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') || '')) { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });
export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string);
  return <div className="ai" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A chip/button that opens a small menu. */
export function Dropdown({ trigger, children, align = 'left', down = false, className = 'chip' }: {
  trigger: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; down?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className={className} onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && <div className={`menu ${align} ${down ? 'down' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !wide) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`}>{children}</div>
    </div>
  );
}

export function ago(iso?: string) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  if (s < 172800) return '昨天';
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天`;
  const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`;
}

const AV_COLORS = ['#d97757', '#6366f1', '#0ea5e9', '#10b981', '#e11d48', '#a855f7', '#f59e0b', '#14b8a6'];
export function Avatar({ id, name, size = 22, dim }: { id: string; name: string; size?: number; dim?: boolean }) {
  let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return <span className="av" style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: dim ? 'var(--chip)' : AV_COLORS[id === 'default' ? 0 : 1 + (h % (AV_COLORS.length - 1))], color: dim ? 'var(--muted)' : '#fff' }}>{(name || '?').trim().slice(0, 1).toUpperCase()}</span>;
}
export function resetText(epochSec: number | null | undefined): string {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return `${hm} 重置`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm} 重置`;
}

/** Avatar with a ring showing how much of the 5-hour quota is used. */
export function QuotaAvatar({ a, size = 22 }: { a: Account; size?: number }) {
  const now = Date.now() / 1000;
  const lim = !!(a.limitedUntil && a.limitedUntil > now);
  const u = a.usage?.fiveHour?.utilization;
  const pct = !a.loggedIn ? null : lim ? 100 : typeof u === 'number' ? Math.max(0, Math.min(100, u)) : null;
  const R = size / 2 + 2.5, C = 2 * Math.PI * R, box = size + 7;
  const color = pct === null ? 'transparent' : pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';
  const tip = !a.loggedIn ? `${a.name} · 未登录` : lim ? `${a.name} · 额度用完${a.limitedUntil ? ` · ${resetText(a.limitedUntil)}` : ''}` : pct !== null ? `${a.name} · 5 小时额度已用 ${Math.round(pct)}%` : a.name;
  return (
    <span className="qav" style={{ width: box, height: box }} title={tip}>
      {pct !== null && <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`}>
        <circle cx={box / 2} cy={box / 2} r={R} fill="none" stroke="var(--line)" strokeWidth="2" />
        <circle cx={box / 2} cy={box / 2} r={R} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(C * pct) / 100} ${C}`} transform={`rotate(-90 ${box / 2} ${box / 2})`} />
      </svg>}
      <Avatar id={a.id} name={a.name} size={size} dim={!a.loggedIn} />
    </span>
  );
}

// ---------- in-app confirm dialog (instead of window.confirm) ----------
type Ask = { title: string; body?: ReactNode; ok?: string; danger?: boolean; resolve(v: boolean): void };
let pushAsk: ((a: Ask | null) => void) | null = null;
export function confirmDialog(o: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => { if (!pushAsk) return resolve(window.confirm(o.title)); pushAsk({ ...o, resolve }); });
}
export function ConfirmHost() {
  const [a, setA] = useState<Ask | null>(null);
  useEffect(() => { pushAsk = setA; return () => { pushAsk = null; }; }, []);
  if (!a) return null;
  const done = (v: boolean) => { a.resolve(v); setA(null); };
  return (
    <Modal onClose={() => done(false)}>
      <h3>{a.title}</h3>
      {a.body && <div className="sub" style={{ marginBottom: 0 }}>{a.body}</div>}
      <div className="actions">
        <button className="btn" onClick={() => done(false)}>取消</button>
        <button className={`btn p ${a.danger ? 'danger-p' : ''}`} autoFocus onClick={() => done(true)}>{a.ok || '确定'}</button>
      </div>
    </Modal>
  );
}
