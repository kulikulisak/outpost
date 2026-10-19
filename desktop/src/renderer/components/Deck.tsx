// Cards for files Claude made and links it found: floating in 3D like prints on a table.
// Clicking one opens a dark viewer where the cards sit on a 3D carousel.
// Pure presentation, shared by the desktop app and the phone app (which imports it via @desktop).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface DeckAction { label: string; run(): void | Promise<void>; primary?: boolean }
export interface DeckItem {
  key: string;
  title: string;
  sub?: string;
  badge: string;          // "PDF", "XLSX", or the site name
  color: string;          // tile colour when there is no picture
  thumb?: string | null;  // undefined = still loading, null = none
  icon?: string | null;   // favicon for links
  wide?: boolean;         // pictures that look better landscape (og:image)
  note?: string;          // small line in the viewer (e.g. "预览由服务器抓取")
  glyph?: string;         // text on the tile instead of the badge (":5173")
  actions: DeckAction[];
}

// each card leans a different way in space, so the row reads as loose prints, not a grid
// big landscape prints, overlapping and staggered up/down, leaning back and turned toward each other
const POSES = [
  'rotateX(16deg) rotateY(20deg) rotateZ(-4deg)',
  'rotateX(12deg) rotateY(-18deg) rotateZ(4deg)',
  'rotateX(18deg) rotateY(14deg) rotateZ(-2deg)',
  'rotateX(10deg) rotateY(-22deg) rotateZ(3deg)',
];
const pose = (i: number, n: number) => {
  if (n === 1) return 'none';
  // two: one up-left leaning back, one down-right turned toward it, in front
  if (n === 2) return ['rotateX(18deg) rotateY(10deg) rotateZ(-3deg)', 'rotateX(10deg) rotateY(-24deg) rotateZ(2deg)'][i];
  // three: the middle one raised and in front, the sides lower and behind, turned in toward the middle
  if (n === 3) return ['rotateX(8deg) rotateY(26deg) rotateZ(-2deg)', 'rotateX(12deg) rotateY(-8deg) rotateZ(1deg)', 'rotateX(8deg) rotateY(-26deg) rotateZ(2deg)'][i];
  return POSES[i % POSES.length];
};
const lift = (i: number, n: number) => n === 3 ? [1, 3, 2][i] : i + 1;

export function Deck({ items }: { items: DeckItem[] }) {
  const [open, setOpen] = useState<{ i: number; from: DOMRect } | null>(null);
  if (!items.length) return null;
  return (
    <>
      <div className={`deck n${Math.min(items.length, 4)} ${items.length === 1 ? 'one' : ''}`}>
        {items.map((it, i) => (
          <button
            key={it.key}
            className="pslot"
            style={{ ['--i' as any]: i, ['--pose' as any]: pose(i, items.length), zIndex: lift(i, items.length) }}
            onClick={(e) => setOpen({ i, from: ((e.currentTarget as HTMLElement).querySelector('.pcard') as HTMLElement).getBoundingClientRect() })}
            title={it.title}
          >
            <div className={`pcard ${it.wide && it.thumb ? 'wide' : ''}`}>
              <Face it={it} />
              <span className="pc-chip">{it.icon ? <img src={it.icon} alt="" /> : <i style={{ background: it.color }} />}<b>{it.title}</b></span>
            </div>
            
          </button>
        ))}
      </div>
      {open && <Viewer items={items} start={open.i} from={open.from} onClose={() => setOpen(null)} />}
    </>
  );
}

function Face({ it, big }: { it: DeckItem; big?: boolean }) {
  if (it.thumb) return <img className="pc-img" src={it.thumb} alt="" draggable={false} onLoad={big ? (e) => {
    // in the viewer, the card takes the picture's own shape (within reason)
    const im = e.currentTarget; const ar = im.naturalWidth / im.naturalHeight;
    if (ar > 0 && !it.wide) im.parentElement?.style.setProperty('--ar', String(Math.max(0.62, Math.min(1.5, ar))));
  } : undefined} />;
  return (
    <div className="pc-tile" style={{ ['--c' as any]: it.color }}>
      {it.thumb === undefined && <div className="pc-shimmer" />}
      {it.thumb === null && (it.icon
        ? <img className="pc-fav" src={it.icon} alt="" />
        : <span className="pc-ext">{it.glyph ?? it.badge.slice(0, big ? 8 : 5)}</span>)}
      {it.thumb === null && big && <span className="pc-tname">{it.title}</span>}
    </div>
  );
}

function Viewer({ items, start, from, onClose }: { items: DeckItem[]; start: number; from: DOMRect; onClose(): void }) {
  const [cur, setCur] = useState(start);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const first = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const n = items.length;
  const go = (i: number) => { setErr(''); setCur(Math.max(0, Math.min(n - 1, i))); };
  const close = () => { setClosing(true); setTimeout(onClose, 260); };

  useEffect(() => {
    // the opened card grows out of the one that was clicked
    const el = first.current;
    if (el) {
      const to = el.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}) rotateX(7deg) rotateY(-18deg)`, opacity: 0.6 },
        { transform: 'none', opacity: 1 },
      ], { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); go(cur + 1); }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); go(cur - 1); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [cur]);

  const it = items[cur];
  const run = async (a: DeckAction) => {
    setBusy(a.label); setErr('');
    try { await a.run(); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(''); }
  };

  return createPortal(
    <div
      className={`dv ${closing ? 'out' : ''}`}
      onPointerDown={(e) => { drag.current = { x: e.clientX, moved: false }; }}
      onPointerMove={(e) => { if (drag.current && Math.abs(e.clientX - drag.current.x) > 8) drag.current.moved = true; }}
      onPointerUp={(e) => {
        const d = drag.current; drag.current = null;
        if (d && Math.abs(e.clientX - d.x) > 50) go(cur + (e.clientX < d.x ? 1 : -1));
      }}
    >
      <div className="dv-top">
        <button className="dv-round" onClick={close} aria-label="关闭">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div className="dv-title"><b>{it.title}</b>{it.sub && <span>{it.sub}</span>}</div>
        <div className="dv-acts">
          {it.actions.map((a) => (
            <button key={a.label} className={a.primary ? 'p' : ''} disabled={!!busy} onClick={() => run(a)}>{busy === a.label ? '…' : a.label}</button>
          ))}
        </div>
      </div>

      <div className="dv-stage" onClick={(e) => { if (e.target === e.currentTarget && !closing) close(); }}>
        {items.map((x, i) => {
          const d = i - cur, a = Math.abs(d);
          return (
            <div
              key={x.key}
              ref={i === start ? first : undefined}
              className={`dv-card ${x.wide && x.thumb ? 'wide' : ''} ${d === 0 ? 'on' : ''}`}
              style={{
                transform: `translateX(calc(-50% + ${d * 68}%)) translateY(-50%) translateZ(${-a * 240}px) rotateY(${-Math.sign(d) * Math.min(a, 2) * 38}deg)`,
                filter: d ? `blur(${Math.min(a, 2) * 4}px) brightness(.8)` : 'none',
                opacity: a > 2 ? 0 : d ? 0.6 : 1,
                zIndex: 10 - a,
                pointerEvents: a > 2 ? 'none' : undefined,
              }}
              onClick={(e) => { e.stopPropagation(); if (drag.current?.moved) return; if (d) go(i); }}
            >
              <Face it={x} big />
            </div>
          );
        })}
      </div>

      {n > 1 && <>
        <button className="dv-round dv-arrow l" disabled={cur === 0} onClick={() => go(cur - 1)} aria-label="上一个">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button className="dv-round dv-arrow r" disabled={cur === n - 1} onClick={() => go(cur + 1)} aria-label="下一个">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      </>}

      <div className="dv-foot">
        {(err || it.note) && <div className={`dv-note ${err ? 'err' : ''}`}>{err || it.note}</div>}
        {n > 1 && <div className="dv-count">{cur + 1} / {n}</div>}
      </div>
    </div>,
    document.body,
  );
}
