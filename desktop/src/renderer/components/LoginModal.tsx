import { useEffect, useRef, useState } from 'react';
import { rc } from '../api';
import { Modal } from './ui';
import { VncView } from './VncView';

/** `claude auth login` in this account's own VPS browser. The code at the end is picked up and submitted automatically. */
export function LoginModal({ onClose, onDone, account }: { onClose(): void; onDone(): void; account?: { id: string; name: string } }) {
  const acc = account?.id || 'default';
  const [ready, setReady] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [toast, setToast] = useState('');
  const closed = useRef(false);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const s = await rc.auth.status(acc);
        if (s.codeSent) setCodeSent(true);
        if (s.loggedIn && !closed.current) { setDone(String(s.email || '')); clearInterval(t); setTimeout(() => finish(true), 1400); }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (ok: boolean) => {
    if (closed.current) return;
    closed.current = true;
    rc.auth.loginStop().catch(() => {});
    ok ? onDone() : onClose();
  };
  const submit = async () => {
    setMsg('');
    try { await rc.auth.loginCode(code.trim()); setMsg('已提交，正在确认…'); } catch (e: any) { setMsg(e.message); }
  };
  const step = done !== null ? 3 : codeSent ? 2.5 : ready ? 2 : 1;

  return (
    <Modal wide onClose={() => finish(false)}>
      <div className="mh">
        <b>登录 Claude{account ? ` ·「${account.name}」` : ''}</b>
        <div className="steps" style={{ marginLeft: 12 }}>
          <span className={step > 1 ? 'ok' : 'on'}>{step > 1 ? '✓' : '1'} 打开登录页</span>
          <span className={step > 2.5 ? 'ok' : step >= 2 ? 'on' : ''}>{step > 2.5 ? '✓' : '2'} 在页面里登录并授权</span>
          <span className={step === 3 ? 'ok' : ''}>{step === 3 ? '✓' : '3'} 完成</span>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => finish(false)}>关闭</button>
      </div>
      <div className="loginbody">
        <VncView account={acc} active login onConnected={() => setReady(true)} onToast={(t) => { setToast(t); setTimeout(() => setToast(''), 2400); }} />
        {toast && <div className="toast">{toast}</div>}
      </div>
      <div className="mf">
        {done !== null ? <span style={{ color: 'var(--green)' }}>✓ 登录成功{done ? `：${done}` : ''}</span>
          : codeSent ? <span>已自动提交授权码，正在确认…</span>
            : manual ? <>
              <input className="input" style={{ width: 320 }} autoFocus placeholder="粘贴页面上显示的授权码" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && submit()} />
              <button className="btn p" disabled={!code.trim()} onClick={submit}>提交</button>
              <span style={{ color: 'var(--faint)' }}>{msg}</span>
            </> : <>
              <span>这是 VPS 上这个账号专属的浏览器，可以直接粘贴本地文字。授权完成后会自动登录。</span>
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setManual(true)}>手动输入授权码</button>
            </>}
      </div>
    </Modal>
  );
}
