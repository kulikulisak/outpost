// The VPS browser on the phone: noVNC core draws the screen, touch becomes clicks and drags,
// and typed text (any language, the phone's own keyboard) goes straight into the page over CDP.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api, auth, type Account } from './api';
import { I, Sheet, toast } from './ui';

type St = { kind: 'idle' | 'starting' | 'on' | 'retry' | 'error'; msg?: string };

export function WebPage({ accounts, visible }: { accounts: Account[]; visible: boolean }) {
  const list = accounts.length ? accounts : [{ id: 'default', name: '默认' } as Account];
  const [acc, setAcc] = useState(() => localStorage.getItem('rcc.webAcc') || list.find((a) => a.active)?.id || list[0].id);
  const screen = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [st, setSt] = useState<St>({ kind: 'idle' });
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [kb, setKb] = useState(false);
  const [typed, setTyped] = useState('');
  const [tabs, setTabs] = useState<{ id: string; url: string; title: string }[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const opened = useRef<string | null>(null);
  useEffect(() => { localStorage.setItem('rcc.webAcc', acc); }, [acc]);

  const cmd = (op: string, arg?: unknown) => api('/api/desk/cmd', { account: acc, op, arg });
  const refreshUrl = () => cmd('tabs').then((ps: any) => { if (!editing && ps?.[0]) setUrl(ps[0].url); }).catch(() => {});

  useEffect(() => {
    if (!visible) return;
    let dead = false, retry: any;
    const el = screen.current!;
    (async () => {
      setSt(attempt ? { kind: 'retry' } : { kind: 'starting' });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      try {
        await api('/api/desk/open', { account: acc, w: el.clientWidth * dpr, h: el.clientHeight * dpr, scale: dpr }, { timeout: 60000 });
      } catch (e: any) { if (!dead) setSt({ kind: 'error', msg: e.message }); return; }
      opened.current = acc;
      if (dead) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const rfb = new RFB(el, `${proto}://${location.host}/vnc?account=${encodeURIComponent(acc)}&t=${encodeURIComponent(auth.token || '')}`, { shared: true });
      rfbRef.current = rfb;
      rfb.scaleViewport = true; rfb.resizeSession = true; rfb.focusOnClick = false; rfb.qualityLevel = 7; rfb.compressionLevel = 3;
      rfb.background = 'transparent';
      // size the VPS screen to the phone in device pixels, so the page is laid out for a phone and stays sharp
      rfb._requestRemoteResize = function (this: any) {
        if (!this._resizeSession || this._viewOnly || !this._supportsSetDesktopSize || this._pendingRemoteResize) return;
        const w = Math.floor(el.clientWidth * dpr), h = Math.floor(el.clientHeight * dpr);
        if (w < 200 || h < 200 || (w === this._fbWidth && h === this._fbHeight)) return;
        if (Date.now() - (this._lastResize || 0) < 150) { clearTimeout(this._resizeTimeout); this._resizeTimeout = setTimeout(() => this._requestRemoteResize(), 160); return; }
        this._pendingRemoteResize = true; this._lastResize = Date.now();
        (RFB as any).messages.setDesktopSize(this._sock, w, h, this._screenID, this._screenFlags);
      };
      rfb.addEventListener('connect', () => { if (!dead) { setSt({ kind: 'on' }); refreshUrl(); setTimeout(() => rfb._requestRemoteResize(), 50); } });
      rfb.addEventListener('disconnect', () => { if (dead) return; setSt({ kind: 'retry' }); retry = setTimeout(() => setAttempt((n) => n + 1), 1500); });
      rfb.addEventListener('clipboard', (e: any) => { const t = e.detail?.text; if (t) navigator.clipboard?.writeText(t).catch(() => {}); });
    })();
    const poll = setInterval(refreshUrl, 4000);
    return () => { dead = true; clearTimeout(retry); clearInterval(poll); try { rfbRef.current?.disconnect(); } catch { /* gone */ } rfbRef.current = null; };
  }, [acc, visible, attempt]);

  // stop the account's VPS browser once the phone leaves it for a while (the desktop does the same)
  useEffect(() => {
    if (visible || !opened.current) return;
    const which = opened.current;
    const t = setTimeout(() => {
      if (localStorage.getItem('rcc.keepBrowser') === '1') return;
      opened.current = null;
      api('/api/desk/stop', { account: which }).catch(() => {});
    }, 60000);
    return () => clearTimeout(t);
  }, [visible, acc]);

  const go = async () => { setEditing(false); (document.activeElement as HTMLElement)?.blur(); try { await cmd('navigate', url); } catch (e: any) { toast(e.message); } };
  const sendText = async () => { if (!typed) return; try { await cmd('insert', typed); setTyped(''); } catch (e: any) { toast(e.message); } };
  const key = (k: string) => cmd('key', k).catch((e) => toast(e.message));

  return (
    <div className="page">
      {list.length > 1 && <div className="acctabs"><div className="seg">{list.map((a) => <button key={a.id} className={acc === a.id ? 'on' : ''} onClick={() => setAcc(a.id)}>{a.name}</button>)}</div></div>}
      {list.length <= 1 && <div style={{ height: 'var(--st)' }} />}
      <div className="web">
        <div className="screen" ref={screen} />
        {st.kind !== 'on' && <div className="ov">{st.kind === 'error' ? <div>打不开 VPS 浏览器<br /><small>{st.msg}</small><br /><button className="chip" style={{ marginTop: 12 }} onClick={() => setAttempt((n) => n + 1)}>重试</button></div> : st.kind === 'retry' ? '重新连接中…' : '正在打开 VPS 里的浏览器…'}</div>}
      </div>
      {kb && (
        <div className="kbbar">
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); typed ? sendText() : key('Enter'); } }} placeholder="输入后点发送，会打进网页" />
          <button onClick={sendText}>发送</button>
          <button onClick={() => key('Backspace')}>⌫</button>
          <button onClick={() => key('Enter')}>↵</button>
        </div>
      )}
      <div className="wtool">
        <button className="ib" onClick={() => cmd('back').catch(() => {})} aria-label="后退">{I.back}</button>
        <button className="ib" onClick={() => cmd('forward').catch(() => {})} aria-label="前进">{I.fwd}</button>
        <input className="url" value={editing ? url : url.replace(/^https?:\/\//, '').replace(/\/$/, '')} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="网址或搜索" />
        <button className="ib" onClick={() => setKb((k) => !k)} aria-label="键盘" style={kb ? { color: 'var(--accent)' } : undefined}>{I.kb}</button>
        <button className="ib" onClick={() => cmd('tabs').then(setTabs).catch((e) => toast(e.message))} aria-label="标签页">{I.tabs}</button>
        <button className="ib" onClick={() => cmd('reload').catch(() => {})} aria-label="刷新">{I.reload}</button>
      </div>
      {tabs && (
        <Sheet onClose={() => setTabs(null)}>
          <h2>标签页</h2>
          {tabs.map((p) => (
            <div key={p.id} className="opt">
              <button style={{ flex: 1, minWidth: 0, textAlign: 'left' }} onClick={() => { cmd('activate', p.id); setTabs(null); }}><div className="n" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{p.title}</div><div className="d" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{p.url}</div></button>
              <button className="ib" onClick={() => cmd('close', p.id).then(() => cmd('tabs').then(setTabs))} aria-label="关闭">{I.x}</button>
            </div>
          ))}
          <div className="btns"><button className="btn pri" onClick={() => { cmd('newtab', 'https://claude.ai/new'); setTabs(null); }}>新标签页</button></div>
        </Sheet>
      )}
    </div>
  );
}
