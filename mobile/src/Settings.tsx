import { useEffect, useState } from 'react';
import { api, auth, type Me } from './api';
import { I, Sheet, Switch, ago, toast } from './ui';
import { disablePush, enablePush, isIOS, pushState } from './push';

type Dev = { id: string; name: string; createdAt: string; lastSeen: number; via: string; me: boolean };
const KINDS = [{ id: 'perm', label: '需要批准' }, { id: 'done', label: '任务完成' }, { id: 'limit', label: '额度用完' }];

export function applyTheme() {
  const t = localStorage.getItem('rcc.theme') || 'auto';
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.setProperty('--fs', `${localStorage.getItem('rcc.fs') || 15}px`);
}

export function SettingsPage({ me, connected, latency, onUnpaired }: { me: Me | null; connected: boolean; latency: number | null; onUnpaired(): void }) {
  const [ps, setPs] = useState<string>('…');
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('rcc.pushPrefs') || '{"perm":true,"done":true,"limit":true}'));
  const [devs, setDevs] = useState<Dev[] | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem('rcc.theme') || 'auto');
  const [fs, setFs] = useState(Number(localStorage.getItem('rcc.fs') || 15));
  const [bypass, setBypass] = useState(localStorage.getItem('rcc.allowBypass') === '1');
  const [keep, setKeep] = useState(localStorage.getItem('rcc.keepBrowser') === '1');
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const relay = location.protocol === 'http:' && !/^(localhost|127\.)/.test(location.hostname);
  const direct = localStorage.getItem('rcc.directUrl');

  useEffect(() => { pushState().then(setPs); api<Dev[]>('/api/devices').then(setDevs).catch(() => setDevs([])); }, []);
  useEffect(() => { localStorage.setItem('rcc.theme', theme); localStorage.setItem('rcc.fs', String(fs)); applyTheme(); }, [theme, fs]);

  const togglePush = async (on: boolean) => {
    try {
      if (on) { await enablePush(me!.pushKey, prefs); toast('通知已开启'); } else { await disablePush(); toast('通知已关闭'); }
      setPs(await pushState());
    } catch (e: any) { toast(e.message); }
  };
  const setPref = async (k: string, v: boolean) => {
    const n = { ...prefs, [k]: v }; setPrefs(n); localStorage.setItem('rcc.pushPrefs', JSON.stringify(n));
    api('/api/push/prefs', { prefs: n }).catch(() => {});
  };
  const unpair = async () => {
    try { await disablePush().catch(() => {}); const mine = devs?.find((d) => d.me); if (mine) await api('/api/devices/revoke', { id: mine.id }); } catch { /* token may already be gone */ }
    auth.set(null); onUnpaired();
  };

  const pushRow = () => {
    if (ps === 'need-install') return <div className="opt"><div><div className="n">通知</div><div className="d">iPhone 需要先「分享 → 添加到主屏幕」，再从主屏幕打开</div></div></div>;
    if (ps === 'unsupported') return <div className="opt"><div><div className="n">通知</div><div className="d">{relay ? '经电脑端（http）打开时浏览器不允许后台通知，用直连地址打开即可' : '这个浏览器不支持后台通知'}</div></div></div>;
    if (ps === 'denied') return <div className="opt"><div><div className="n">通知</div><div className="d">通知被系统禁止了，去系统设置里给这个应用打开</div></div></div>;
    return <div className="opt"><div className="n" style={{ fontWeight: 500 }}>开启通知</div><Switch on={ps === 'on'} onChange={togglePush} /></div>;
  };

  return (
    <div className="page">
      <div className="nav"><h1>设置</h1></div>
      <div className="scroll">
        <div className="card">
          <div className="opt"><span className={`dotg ${connected ? '' : 'off'}`} /><div><div className="n">{me?.server || localStorage.getItem('rcc.server') || 'VPS'}</div><div className="d">{relay ? '经电脑端' : '直连 VPS'}{latency != null ? ` · ${latency}ms` : ''}{me ? ` · rcc ${me.version}` : ''}</div></div></div>
        </div>
        <div className="sec" style={{ paddingTop: 8 }}><span>连接方式</span></div>
        <div className="card">
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>{relay ? '现在走电脑端' : '现在直连 VPS'}</div><div className="d">{relay ? '电脑关机后这个入口就打不开了' : '电脑关着也能用'}</div></div></div>
          {relay && direct && <a className="opt" href={direct} style={{ color: 'inherit', textDecoration: 'none' }}><div><div className="n" style={{ fontWeight: 500, color: 'var(--accent)' }}>改用直连地址</div><div className="d">{direct.replace(/^https?:\/\//, '')} · 需要重新配对一次</div></div>{I.chev}</a>}
        </div>
        <div className="hint">两个入口各自配对：直连地址用电脑端「手机 → 直连」的二维码，电脑端入口用「手机 → 局域网」的二维码。</div>

        <div className="sec" style={{ paddingTop: 8 }}><span>通知</span></div>
        <div className="card">
          {pushRow()}
          {ps === 'on' && KINDS.map((k) => <div key={k.id} className="opt"><div className="n" style={{ fontWeight: 500 }}>{k.label}</div><Switch on={prefs[k.id] !== false} onChange={(v) => setPref(k.id, v)} /></div>)}
          {ps === 'on' && <button className="opt" onClick={() => api('/api/push/test', {}).then(() => toast('已发送测试通知')).catch((e) => toast(e.message))}><div className="n" style={{ fontWeight: 500, color: 'var(--accent)' }}>发一条测试通知</div></button>}
        </div>
        {ps === 'on' && isIOS() && <div className="hint">iPhone 上点通知会打开批准页面；通知上直接点允许 / 拒绝只有安卓支持。</div>}

        <div className="sec" style={{ paddingTop: 8 }}><span>外观</span></div>
        <div className="card">
          <div className="opt" style={{ display: 'block' }}><div className="n" style={{ fontWeight: 500 }}>主题</div><div className="seg">{[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, l]) => <button key={k} className={theme === k ? 'on' : ''} onClick={() => setTheme(k)}>{l}</button>)}</div></div>
          <div className="opt" style={{ display: 'block' }}><div className="n" style={{ fontWeight: 500 }}>字号</div><div className="seg">{[14, 15, 16, 17].map((n) => <button key={n} className={fs === n ? 'on' : ''} onClick={() => setFs(n)}>{n === 14 ? '小' : n === 15 ? '标准' : n === 16 ? '大' : '特大'}</button>)}</div></div>
        </div>

        <div className="sec" style={{ paddingTop: 8 }}><span>安全</span></div>
        <div className="card">
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>手机上允许「全部允许」权限模式</div><div className="d">打开后，新任务可以选不再询问</div></div><Switch on={bypass} onChange={(v) => { setBypass(v); localStorage.setItem('rcc.allowBypass', v ? '1' : '0'); }} /></div>
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>离开网页版后保留 VPS 浏览器</div><div className="d">关掉时 1 分钟后自动关闭，省内存</div></div><Switch on={keep} onChange={(v) => { setKeep(v); localStorage.setItem('rcc.keepBrowser', v ? '1' : '0'); }} /></div>
          <button className="opt" onClick={() => setConfirmUnpair(true)}><div className="n" style={{ fontWeight: 500, color: 'var(--red)' }}>解除这台手机的配对</div></button>
        </div>

        <div className="sec" style={{ paddingTop: 8 }}><span>已配对的设备</span></div>
        <div className="card">
          {devs === null && <div className="opt"><div className="d">读取中…</div></div>}
          {devs?.map((d) => (
            <div key={d.id} className="opt">
              <div style={{ flex: 1 }}><div className="n" style={{ fontWeight: 500 }}>{d.name}{d.me ? '（这台）' : ''}</div><div className="d">{d.via === 'relay' ? '经电脑端' : '直连'} · 最近使用 {ago(d.lastSeen)}</div></div>
              {!d.me && <button className="chip" onClick={() => api('/api/devices/revoke', { id: d.id }).then(() => setDevs(devs.filter((x) => x.id !== d.id))).catch((e) => toast(e.message))}>移除</button>}
            </div>
          ))}
        </div>
        <div className="hint" style={{ paddingTop: 6, paddingBottom: 30 }}>Claude Code 和网页版都运行在 VPS 上，用的是 VPS 的 IP 和环境。手机只发送文字和文件，照片上传前会去掉定位等信息。</div>
      </div>
      {confirmUnpair && (
        <Sheet onClose={() => setConfirmUnpair(false)}>
          <h2>解除配对？</h2>
          <div className="sub">这台手机将不能再访问 VPS，需要重新扫码配对。</div>
          <div className="btns"><button className="btn" style={{ color: 'var(--red)' }} onClick={unpair}>解除配对</button><button className="btn dark" onClick={() => setConfirmUnpair(false)}>取消</button></div>
        </Sheet>
      )}
    </div>
  );
}
