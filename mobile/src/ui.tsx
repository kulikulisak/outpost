import { useEffect, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const P = (d: string) => <path d={d} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />;
export const I = {
  plus: <svg className="i" viewBox="0 0 24 24">{P('M12 5v14M5 12h14')}</svg>,
  back: <svg className="i" viewBox="0 0 24 24" style={{ width: 22, height: 22 }}>{P('M15 5l-7 7 7 7')}</svg>,
  fwd: <svg className="i" viewBox="0 0 24 24" style={{ width: 22, height: 22 }}>{P('M9 5l7 7-7 7')}</svg>,
  more: <svg className="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /><circle cx="19" cy="12" r="1.8" fill="currentColor" /></svg>,
  up: <svg className="i" viewBox="0 0 24 24" style={{ width: 18, height: 18 }}><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>,
  chat: <svg viewBox="0 0 24 24">{P('M4 5h16v11H9l-5 4z')}</svg>,
  folder: <svg viewBox="0 0 24 24">{P('M3 6h6l2 2h10v11H3z')}</svg>,
  globe: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" fill="none" />{P('M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18')}</svg>,
  gear: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" fill="none" />{P('M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1')}</svg>,
  clip: <svg className="i" viewBox="0 0 24 24">{P('M20 11l-8 8a5 5 0 01-7-7l8-8a3.3 3.3 0 015 5l-8 8a1.7 1.7 0 01-2.5-2.5l7-7')}</svg>,
  mic: <svg className="i" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" fill="none" />{P('M5 11a7 7 0 0014 0M12 18v3')}</svg>,
  search: <svg className="i" viewBox="0 0 24 24" style={{ width: 17, height: 17 }}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" fill="none" />{P('M20 20l-4-4')}</svg>,
  reload: <svg className="i" viewBox="0 0 24 24">{P('M20 12a8 8 0 11-2.3-5.6M20 4v5h-5')}</svg>,
  kb: <svg className="i" viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />{P('M6 10h1M10 10h1M14 10h1M18 10h0M7 14h10')}</svg>,
  tabs: <svg className="i" viewBox="0 0 24 24"><rect x="4" y="7" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />{P('M8 4h10a2 2 0 012 2v10')}</svg>,
  x: <svg className="i" viewBox="0 0 24 24" style={{ width: 18, height: 18 }}>{P('M6 6l12 12M18 6L6 18')}</svg>,
  chev: <svg className="i" viewBox="0 0 24 24" style={{ width: 16, height: 16, color: 'var(--faint)' }}>{P('M9 6l6 6-6 6')}</svg>,
};

export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string);
  return <div className="ai" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Sheet({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return <>
    <div className="dim" onClick={onClose} />
    <div className="sheet" role="dialog"><div className="grab" />{children}</div>
  </>;
}

let toastFn: ((t: string) => void) | null = null;
export const toast = (t: string) => toastFn?.(t);
export function ToastHost() {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    let timer: any;
    toastFn = (s) => { setT(s); clearTimeout(timer); timer = setTimeout(() => setT(null), 2600); };
    return () => { toastFn = null; };
  }, []);
  return t ? <div className="toast" onClick={() => setT(null)}>{t}</div> : null;
}

export function Ring({ label, pct, limited }: { label: string; pct: number | null; limited?: boolean }) {
  const p = limited ? 100 : Math.max(0, Math.min(100, pct ?? 0));
  const col = limited || p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--green)';
  return <div className="ring" style={{ background: pct == null && !limited ? 'var(--line)' : `conic-gradient(${col} 0 ${p}%, var(--line) ${p}% 100%)` }}><span>{label.slice(0, 1)}</span></div>;
}

export function ago(iso?: string | number | null): string {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export const base = (p?: string | null) => (p || '').replace(/\/+$/, '').split('/').pop() || p || '';
export const short = (p?: string | null) => (p || '').replace(/^\/(root|home\/[^/]+)(?=\/|$)/, '~');

export function Switch({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return <button className={`sw ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}
