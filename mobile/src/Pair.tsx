import { useEffect, useState } from 'react';
import { api, auth } from './api';

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].trim().slice(0, 30);
  return /Android/.test(ua) ? 'Android 手机' : '手机';
}

export function Pair({ onDone }: { onDone(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const redeem = async (c: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ token: string; url: string | null; server: string }>('/api/pair', { code: c, name: deviceName() });
      auth.set(r.token);
      if (r.url) localStorage.setItem('rcc.directUrl', r.url);
      localStorage.setItem('rcc.server', r.server);
      history.replaceState(null, '', location.pathname);
      onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  // the QR code carries the pairing code in the URL fragment (never sent to any server log)
  useEffect(() => {
    const check = () => { const m = location.hash.match(/pair=([A-Za-z0-9]{8})/); if (m) { setCode(m[1].toUpperCase()); redeem(m[1]); } };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return (
    <div className="pair">
      <img className="logo" src="/icon-192.png" alt="" />
      <h1>连接 VPS</h1>
      <p>用手机相机扫电脑端「设置 → 手机」里的二维码，或在 VPS 上运行 <code>rcc pair</code> 扫终端里的码。也可以把 8 位配对码填在下面。</p>
      <div className="codebox">
        <input value={clean} onChange={(e) => setCode(e.target.value)} placeholder="配对码" autoCapitalize="characters" autoCorrect="off" spellCheck={false} inputMode="text" maxLength={9} />
      </div>
      {err && <div className="err">{err}</div>}
      <button className="btn pri" disabled={clean.length !== 8 || busy} onClick={() => redeem(clean)}>{busy ? '正在配对…' : '配对'}</button>
      <div className="steps">
        <div className="step"><div className="n">✓</div><div><b>直接连 VPS</b><div>电脑关着也能用；Claude 只看到 VPS 的环境</div></div></div>
        <div className="step"><div className="n">⇄</div><div><b>电脑开着时可走电脑端</b><div>同一 Wi-Fi 下扫电脑端的「局域网」二维码</div></div></div>
        <div className="step"><div className="n">⌂</div><div><b>添加到主屏幕</b><div>iPhone：分享 → 添加到主屏幕；安卓：菜单 → 安装应用</div></div></div>
      </div>
    </div>
  );
}
