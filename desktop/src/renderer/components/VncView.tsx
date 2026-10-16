// Draws one account's VPS screen with noVNC's core only (no noVNC page or toolbar), and handles input:
// keys go over VNC, while pasted text and IME text go straight into the page as real text (any language).
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import Keyboard from 'novnc-keyboard';
import * as NovncLog from 'novnc-logging';
if (localStorage.getItem('vncDebug')) NovncLog.initLogging('debug');
import { rc } from '../api';
import type { OutFile } from '../../shared/types';

const isMac = rc.platform === 'darwin';
type St = { kind: 'starting' | 'connected' | 'reconnecting' | 'error'; msg?: string };

export async function toOutFiles(list: FileList | File[]): Promise<OutFile[]> {
  const out: OutFile[] = [];
  for (const f of Array.from(list)) {
    const p = rc.pathForFile(f);
    out.push(p ? { name: f.name, mime: f.type, path: p, size: f.size } : { name: f.name || `paste-${Date.now()}.png`, mime: f.type, data: await f.arrayBuffer(), size: f.size });
  }
  return out;
}

export function VncView({ account, active, login, onToast, onConnected }: { account: string; active: boolean; login?: boolean; onToast?(t: string): void; onConnected?(): void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const rfbRef = useRef<any>(null);
  const [st, setSt] = useState<St>({ kind: 'starting' });
  const [drag, setDrag] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const toast = (t: string) => onToast?.(t);

  const focusInput = () => { if (ta.current && document.activeElement !== ta.current) ta.current.focus({ preventScroll: true }); };

  // connect (and reconnect with backoff when the line drops)
  useEffect(() => {
    let dead = false, retry: any, kb: any, released = false;
    const el = screen.current!;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    (async () => {
      setSt((s) => (attempt ? { kind: 'reconnecting', msg: s.msg } : { kind: 'starting' }));
      let r;
      try {
        r = await rc.desk.open(account, { w: el.clientWidth * dpr, h: el.clientHeight * dpr, scale: dpr, login: login && attempt === 0 });
      } catch (e: any) {
        if (!dead) setSt({ kind: 'error', msg: e.message });
        return;
      }
      if (dead) { rc.desk.release(account); return; }
      const rfb = new RFB(el, r.wsUrl, { shared: true });
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.focusOnClick = false;
      rfb.qualityLevel = 8;
      rfb.compressionLevel = 2;
      rfb.background = 'transparent';
      // ask the VPS for a screen at device pixels so text stays sharp on high-DPI displays
      rfb._requestRemoteResize = function (this: any) {
        if (!this._resizeSession || this._viewOnly || !this._supportsSetDesktopSize || this._pendingRemoteResize) return;
        const w = Math.floor(el.clientWidth * dpr), h = Math.floor(el.clientHeight * dpr);
        if (w < 200 || h < 200 || (w === this._fbWidth && h === this._fbHeight)) return;
        if (Date.now() - this._lastResize < 150) { clearTimeout(this._resizeTimeout); this._resizeTimeout = setTimeout(() => this._requestRemoteResize(), 160); return; }
        this._pendingRemoteResize = true; this._lastResize = Date.now();
        RFB.messages.setDesktopSize(this._sock, w, h, this._screenID, this._screenFlags);
      };
      rfb.addEventListener('connect', () => {
        if (dead) return;
        try { rfb._keyboard.ungrab(); } catch { /* ignore */ }
        setSt({ kind: 'connected' }); setTimeout(() => rfb._requestRemoteResize(), 50);
        onConnected?.();
        if (active) focusInput();
      });
      rfb.addEventListener('disconnect', (e: any) => {
        rfbRef.current = null;
        if (dead) return;
        setSt({ kind: 'reconnecting', msg: e.detail?.clean ? '画面连接已关闭' : '连接断开' });
        if (!released) { released = true; rc.desk.release(account); }
        retry = setTimeout(() => setAttempt((n) => n + 1), Math.min(8000, 800 * (attempt + 1)));
      });
      rfb.addEventListener('clipboard', (e: any) => {
        const t = e.detail?.text;
        if (t) rc.clip.write(t).then(() => toast('已复制到本地剪贴板')).catch(() => {});
      });
      // our own keyboard on a hidden textarea, so the local IME works
      kb = new Keyboard(ta.current!);
      kb.onkeyevent = (keysym: number, code: string, down: boolean) => {
        const r2 = rfbRef.current; if (!r2) return;
        if (isMac && (code === 'MetaLeft' || code === 'MetaRight')) { r2.sendKey(0xffe3, 'ControlLeft', down); return; }
        r2.sendKey(keysym, code, down);
      };
      kb.grab();
    })();
    return () => {
      dead = true; clearTimeout(retry);
      try { kb?.ungrab(); } catch { /* ignore */ }
      const r2 = rfbRef.current; rfbRef.current = null;
      if (r2) { try { r2.disconnect(); } catch { /* ignore */ } }
      if (!released) { released = true; rc.desk.release(account); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, attempt]);

  useEffect(() => { if (active && st.kind === 'connected') setTimeout(focusInput, 30); }, [active, st.kind]);

  const insert = async (text: string) => {
    if (!text) return;
    try { await rc.desk.insertText(account, text); }
    catch {
      // fall back to the VNC clipboard + Ctrl+V
      const r = rfbRef.current; if (!r) return;
      r.clipboardPasteFrom(text);
      setTimeout(() => { r.sendKey(0xffe3, 'ControlLeft', true); r.sendKey(0x76, 'KeyV'); r.sendKey(0xffe3, 'ControlLeft', false); }, 120);
    }
  };
  const upload = async (files: FileList | File[]) => {
    if (!files.length) return;
    toast(`正在上传 ${files.length} 个文件…`);
    try { const r = await rc.desk.upload(account, await toOutFiles(files)); toast(r.count ? `已添加 ${r.count} 个文件到网页` : '没有上传'); }
    catch (e: any) { toast(e.message); }
  };

  const onKeyCapture = (e: React.KeyboardEvent) => {
    const n = e.nativeEvent;
    if (n.isComposing || n.keyCode === 229) { e.stopPropagation(); return; }
    // paste comes from the local clipboard (handled in onPaste), never from the VPS clipboard
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') { e.stopPropagation(); return; }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const files = Array.from(e.clipboardData.files || []);
    const text = e.clipboardData.getData('text/plain');
    if (files.length && !text) upload(files); else insert(text);
  };
  const placeInput = (e: React.MouseEvent) => {
    // keep the hidden input under the pointer so the IME candidate window shows up where you clicked
    const r = wrap.current!.getBoundingClientRect();
    if (ta.current) { ta.current.style.left = `${e.clientX - r.left}px`; ta.current.style.top = `${e.clientY - r.top + 4}px`; }
    setTimeout(focusInput, 0);
  };

  return (
    <div ref={wrap} className={`vnc ${active ? '' : 'hidden'}`} onMouseDownCapture={placeInput} onKeyDownCapture={onKeyCapture} onKeyUpCapture={(e) => { if (e.nativeEvent.isComposing) e.stopPropagation(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
      <div ref={screen} className="vnc-screen" />
      <textarea ref={ta} className="vnc-input" autoCapitalize="off" autoComplete="off" spellCheck={false} onPaste={onPaste}
        onCompositionEnd={(e) => { const t = e.data; (e.target as HTMLTextAreaElement).value = ''; insert(t); }}
        onInput={(e) => { const t = e.target as HTMLTextAreaElement; if (!(e.nativeEvent as InputEvent).isComposing) t.value = ''; }} />
      {st.kind !== 'connected' && (
        <div className="vnc-cover">
          {st.kind === 'error' ? <>
            <div className="vnc-title">打不开 VPS 浏览器</div>
            <div className="vnc-sub err-text">{st.msg}</div>
            <button className="btn p" onClick={() => setAttempt((n) => n + 1)}>重试</button>
          </> : <>
            <div className="skel"><div className="skel-bar" /><div className="skel-line w60" /><div className="skel-line w80" /><div className="skel-line w40" /></div>
            <div className="vnc-sub"><span className="spin sm" />{st.kind === 'starting' ? (login ? '正在打开登录页面…' : '正在启动这个账号的 VPS 浏览器…') : `${st.msg || '连接断开'}，正在重连…`}</div>
          </>}
        </div>
      )}
      {drag && <div className="vnc-drop">松开即可把文件添加到网页</div>}
    </div>
  );
}
