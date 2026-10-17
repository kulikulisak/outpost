// Portrait cards fanned out like a hand of cards: used for files Claude made and links it found.
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
  note?: string;          // small line in the lightbox (e.g. "预览由服务器抓取")
  glyph?: string;         // big text on the tile instead of the badge (":5173")
  actions: DeckAction[];
}

// alternate small tilts so the row reads as a loose fan, not a grid
const TILT = [-4, 3, -2, 4, -3, 2, -1];

export function Deck({ items }: { items: DeckItem[] }) {
  const [open, setOpen] = useState<{ item: DeckItem; from: DOMRect } | null>(null);
  if (!items.length) return null;
  return (
    <>
      <div className={`deck ${items.length === 1 ? 'one' : ''}`}>
        {items.map((it, i) => (
          <button
            key={it.key}
            className="pcard"
            style={{ ['--i' as any]: i, ['--r' as any]: `${items.length === 1 ? -2 : TILT[i % TILT.length]}deg` }}
            onClick={(e) => setOpen({ item: it, from: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
            title={it.title}
          >
            <Face it={it} />
          </button>
        ))}
      </div>
      {open && <Lightbox item={open.item} from={open.from} onClose={() => setOpen(null)} />}
    </>
  );
}

function Face({ it, big }: { it: DeckItem; big?: boolean }) {
  return <>
    <div className={`pc-pic ${it.thumb ? 'has' : ''} ${it.wide ? 'wide' : ''}`} style={{ ['--c' as any]: it.color }}>
      {it.thumb === undefined && <div className="pc-shimmer" />}
      {it.thumb ? <img src={it.thumb} alt="" draggable={false} /> : it.thumb === null && (
        it.icon ? <img className="pc-fav" src={it.icon} alt="" /> : <span className="pc-ext">{it.glyph ?? it.badge.slice(0, big ? 8 : 5)}</span>
      )}
    </div>
    <div className="pc-meta">
      <div className="pc-badge">{it.icon && it.thumb ? <img src={it.icon} alt="" /> : <i style={{ background: it.color }} />}<span>{it.badge}</span></div>
      <div className="pc-title">{it.title}</div>
      {it.sub && <div className="pc-sub">{it.sub}</div>}
    </div>
  </>;
}

function Lightbox({ item, from, onClose }: { item: DeckItem; from: DOMRect; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const close = () => { setClosing(true); setTimeout(onClose, 220); };
  // grow out of the card that was clicked
  useEffect(() => {
    const el = panel.current; if (!el) return;
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}) rotate(-3deg)`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ], { duration: 340, easing: 'cubic-bezier(.2,.9,.25,1.12)' });
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const run = async (a: DeckAction) => {
    setBusy(a.label); setErr('');
    try { await a.run(); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(''); }
  };
  return createPortal(
    <div className={`deck-lb ${closing ? 'out' : ''}`} onClick={close}>
      <div className="deck-panel" ref={panel} onClick={(e) => e.stopPropagation()}>
        <div className="pcard big"><Face it={item} big /></div>
        <div className="deck-acts">
          {item.actions.map((a) => (
            <button key={a.label} className={a.primary ? 'p' : ''} disabled={!!busy} onClick={() => run(a)}>{busy === a.label ? '…' : a.label}</button>
          ))}
        </div>
        {(err || item.note) && <div className={`deck-note ${err ? 'err' : ''}`}>{err || item.note}</div>}
      </div>
    </div>,
    document.body,
  );
}
