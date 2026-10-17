import { useEffect, useState } from 'react';
import { api, auth, type Me } from './api';
import { I, Sheet, Switch, ago, toast } from './ui';
import { disablePush, enablePush, isIOS, pushState } from './push';
import { passkeySupported, registerPasskey } from './passkey';
import { native, rcc } from './Cards';

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
  const [simple, setSimple] = useState(localStorage.getItem('rcc.simple') !== '0');
  const [keep, setKeep] = useState(localStorage.getItem('rcc.keepBrowser') === '1');
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [browser, setBrowser] = useState(localStorage.getItem('rcc.browser') !== '0');
  const [sheet, setSheet] = useState<'' | 'memory' | 'sched'>('');
  const [keys, setKeys] = useState<{ id: string; name: string; createdAt: number; lastUsed?: number }[] | null>(null);
  const loadKeys = () => api<any[]>('/api/passkeys').then(setKeys).catch(() => setKeys([]));
  useEffect(() => { loadKeys(); }, []);
  const addKey = async () => { try { await registerPasskey(me?.device.name || '手机'); toast('通行密钥已添加'); loadKeys(); } catch (e: any) { toast(e.name === 'NotAllowedError' ? '已取消' : e.name === 'InvalidStateError' ? '这台设备已经添加过了' : e.message); } };
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
    if (ps === 'unsupported') return <div className="opt"><div><div className="n">通知</div><div className="d">{native ? '安卓 App 里收不到后台通知。想要通知，用 Chrome 打开同一个网址，再「安装应用」' : relay ? '经电脑端（http）打开时浏览器不允许后台通知，用直连地址打开即可' : '这个浏览器不支持后台通知'}</div></div></div>;
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

        <div className="sec" style={{ paddingTop: 8 }}><span>Claude</span></div>
        <div className="card">
          <button className="opt" onClick={() => setSheet('memory')}><div style={{ flex: 1 }}><div className="n" style={{ fontWeight: 500 }}>关于我</div><div className="d">Claude 应该一直记得的事：称呼、习惯、偏好</div></div>{I.chev}</button>
          <button className="opt" onClick={() => setSheet('sched')}><div style={{ flex: 1 }}><div className="n" style={{ fontWeight: 500 }}>定时任务</div><div className="d">到点让 Claude 自动做事，做完推送给你</div></div>{I.chev}</button>
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>让 Claude 使用服务器浏览器</div><div className="d">登录网站、点按钮、填表时用；可以在「网页版」里看着</div></div><Switch on={browser} onChange={(v) => { setBrowser(v); localStorage.setItem('rcc.browser', v ? '1' : '0'); }} /></div>
        </div>

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
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>省心模式</div><div className="d">用大白话说做了什么，过程收起来，每轮可一键撤销</div></div><Switch on={simple} onChange={(v) => { setSimple(v); localStorage.setItem('rcc.simple', v ? '1' : '0'); }} /></div>
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>手机上允许「全部允许」权限模式</div><div className="d">打开后，新任务可以选不再询问</div></div><Switch on={bypass} onChange={(v) => { setBypass(v); localStorage.setItem('rcc.allowBypass', v ? '1' : '0'); }} /></div>
          <div className="opt"><div><div className="n" style={{ fontWeight: 500 }}>离开网页版后保留 VPS 浏览器</div><div className="d">关掉时 1 分钟后自动关闭，省内存</div></div><Switch on={keep} onChange={(v) => { setKeep(v); localStorage.setItem('rcc.keepBrowser', v ? '1' : '0'); }} /></div>
          {native && <button className="opt" onClick={() => native!.resetServer()}><div><div className="n" style={{ fontWeight: 500 }}>更换服务器地址</div><div className="d">{native.server()}</div></div></button>}
          <button className="opt" onClick={() => setConfirmUnpair(true)}><div className="n" style={{ fontWeight: 500, color: 'var(--red)' }}>解除这台手机的配对</div></button>
        </div>

        <div className="sec" style={{ paddingTop: 8 }}><span>通行密钥</span></div>
        <div className="card">
          {keys?.map((k) => (
            <div key={k.id} className="opt">
              <div style={{ flex: 1 }}><div className="n" style={{ fontWeight: 500 }}>{k.name}</div><div className="d">添加于 {ago(k.createdAt)}{k.lastUsed ? ` · 最近使用 ${ago(k.lastUsed)}` : ''}</div></div>
              <button className="chip" onClick={() => api('/api/passkeys/remove', { id: k.id }).then(loadKeys).catch((e) => toast(e.message))}>移除</button>
            </div>
          ))}
          {passkeySupported() ? <button className="opt" onClick={addKey}><div className="n" style={{ fontWeight: 500, color: 'var(--accent)' }}>添加通行密钥</div></button>
            : <div className="opt"><div className="d">需要用 https 地址打开才能使用通行密钥</div></div>}
        </div>
        <div className="hint">添加后，换手机或清了浏览器数据时，用 Face ID / 指纹就能重新登录，不用再找配对码。</div>

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
      {sheet === 'memory' && <MemorySheet onClose={() => setSheet('')} />}
      {sheet === 'sched' && <SchedSheet onClose={() => setSheet('')} />}
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

function MemorySheet({ onClose }: { onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { rcc<{ text: string }>(['memory']).then((r) => setText(r.text || '')).catch((e) => { toast(e.message); setText(''); }); }, []);
  const save = async () => { setBusy(true); try { await rcc(['memory', '--set'], text || ''); toast('已保存'); onClose(); } catch (e: any) { toast(e.message); setBusy(false); } };
  return (
    <Sheet onClose={onClose}>
      <h2>关于我</h2>
      <div className="sub">每个对话、每个账号都会读到。也可以在对话里直接说「记住……」。</div>
      {text === null ? <div className="note">读取中…</div> : <textarea className="field" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'# 关于我\n- 称呼：\n- 回复请用简体中文\n- 我不会写代码，请用大白话'} style={{ resize: 'none', fontSize: 14 }} />}
      <div className="btns"><button className="btn pri" disabled={busy || text === null} onClick={save}>{busy ? '正在保存…' : '保存'}</button></div>
    </Sheet>
  );
}

interface Sched { id?: string; name: string; prompt: string; cwd: string; kind: 'daily' | 'weekly' | 'interval' | 'once'; time: string; days: number[]; every: number; date?: string | null; enabled: boolean; lastRun?: number | null; lastError?: string | null; tz?: string }
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const when = (s: Sched) => s.kind === 'interval' ? `每 ${s.every >= 60 ? `${s.every / 60} 小时` : `${s.every} 分钟`}` : s.kind === 'weekly' ? `每周${s.days.map((d) => DOW[d]).join('、')} ${s.time}` : s.kind === 'once' ? `${s.date} ${s.time}` : `每天 ${s.time}`;
function SchedSheet({ onClose }: { onClose(): void }) {
  const [list, setList] = useState<Sched[] | null>(null);
  const [edit, setEdit] = useState<Sched | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => rcc<Sched[]>(['sched-list']).then(setList).catch((e) => { toast(e.message); setList([]); });
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!edit) return; setBusy(true);
    try { await rcc(['sched-put'], JSON.stringify({ ...edit, name: edit.name.trim() || edit.prompt.trim().slice(0, 20), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })); setEdit(null); load(); toast('已保存'); }
    catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const set = (p: Partial<Sched>) => setEdit((x) => (x ? { ...x, ...p } : x));
  if (edit) return (
    <Sheet onClose={() => setEdit(null)}>
      <h2>{edit.id ? '编辑定时任务' : '新建定时任务'}</h2>
      <div className="lbl">要让 Claude 做什么</div>
      <textarea className="field" rows={4} value={edit.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="例如：搜一下今天关于 AI 的重要新闻，挑 5 条写成中文早报" style={{ resize: 'none' }} />
      <div className="lbl">名字</div>
      <input className="field" value={edit.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：AI 早报" />
      <div className="lbl">什么时候</div>
      <div className="seg">{([['daily', '每天'], ['weekly', '每周'], ['interval', '每隔'], ['once', '一次']] as const).map(([k, l]) => <button key={k} className={edit.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>{l}</button>)}</div>
      {edit.kind === 'weekly' && <div className="seg" style={{ marginTop: 8 }}>{DOW.map((d, i) => <button key={i} className={edit.days.includes(i) ? 'on' : ''} onClick={() => set({ days: edit.days.includes(i) ? edit.days.filter((x) => x !== i) : [...edit.days, i].sort() })}>{d}</button>)}</div>}
      {edit.kind === 'interval'
        ? <div className="seg" style={{ marginTop: 8 }}>{[30, 60, 180, 360, 720].map((m) => <button key={m} className={edit.every === m ? 'on' : ''} onClick={() => set({ every: m })}>{m < 60 ? `${m}分` : `${m / 60}时`}</button>)}</div>
        : <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{edit.kind === 'once' && <input className="field" type="date" value={edit.date || ''} onChange={(e) => set({ date: e.target.value })} />}<input className="field" type="time" value={edit.time} onChange={(e) => set({ time: e.target.value })} /></div>}
      <div className="opt" style={{ padding: '12px 0 0' }}><div className="n" style={{ fontWeight: 500 }}>启用</div><Switch on={edit.enabled} onChange={(v) => set({ enabled: v })} /></div>
      <div className="btns">
        <button className="btn pri" disabled={busy || !edit.prompt.trim() || (edit.kind === 'once' && !edit.date) || (edit.kind === 'weekly' && !edit.days.length)} onClick={save}>{busy ? '正在保存…' : '保存'}</button>
        {edit.id && <button className="btn" style={{ color: 'var(--red)' }} onClick={async () => { if (!confirm('删除这个定时任务？')) return; await rcc(['sched-remove', edit.id!]).catch(() => {}); setEdit(null); load(); }}>删除</button>}
      </div>
    </Sheet>
  );
  return (
    <Sheet onClose={onClose}>
      <h2>定时任务</h2>
      <div className="sub">在服务器上按时运行，手机和电脑都关着也会做。结果在「会话」里（标题带 ⏰）。</div>
      <div className="card" style={{ margin: '12px 0 0' }}>
        {list === null && <div className="opt"><div className="d">读取中…</div></div>}
        {list?.length === 0 && <div className="opt"><div className="d">还没有定时任务</div></div>}
        {list?.map((s) => (
          <div key={s.id} className="opt">
            <button style={{ flex: 1, textAlign: 'left' }} onClick={() => setEdit(s)}><div className="n" style={{ fontWeight: 500 }}>{s.name}{!s.enabled ? '（已暂停）' : ''}</div><div className="d">{when(s)}{s.lastError ? ` · 出错：${s.lastError}` : s.lastRun ? ` · 上次 ${ago(s.lastRun)}` : ''}</div></button>
            <button className="chip" onClick={() => rcc(['sched-run', s.id!]).then(() => { toast('已开始，去「会话」里看'); load(); }).catch((e) => toast(e.message))}>运行</button>
          </div>
        ))}
      </div>
      <div className="btns"><button className="btn pri" onClick={() => setEdit({ name: '', prompt: '', cwd: '~/chat', kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5], every: 60, enabled: true })}>新建定时任务</button></div>
    </Sheet>
  );
}
