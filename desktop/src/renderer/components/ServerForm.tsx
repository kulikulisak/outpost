import { useState } from 'react';
import { rc } from '../api';
import type { ServerConfig } from '../../shared/types';

export function ServerForm({ initial, onSaved, onCancel, submitLabel = '保存并连接' }: {
  initial?: ServerConfig; onSaved(cfg: ServerConfig): void; onCancel?(): void; submitLabel?: string;
}) {
  const [f, setF] = useState<ServerConfig>(initial || { id: crypto.randomUUID(), name: '', host: '', port: 22, username: 'root', auth: 'key', workdir: '~/code' });
  const [key, setKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const set = (p: Partial<ServerConfig>) => setF({ ...f, ...p });
  const isUrl = f.kind === 'url';

  const saveUrl = async () => {
    setErr('');
    let url = (f.url || '').trim().replace(/\/+$/, '');
    if (!url) return setErr('请填写网址');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!initial && !code.trim()) return setErr('请填写配对码');
    setBusy(true);
    try {
      const host = url.replace(/^https?:\/\//i, '').split('/')[0];
      const cfg: ServerConfig = { ...f, kind: 'url', url, name: f.name.trim() || host, host, port: 443, username: 'root', workdir: f.workdir || '/root/code' };
      await rc.servers.save(cfg, code.trim() ? { pairCode: code.trim() } : undefined);
      await rc.conn.connect(cfg.id);
      onSaved(cfg);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const save = async () => {
    setErr('');
    if (!f.host.trim()) return setErr('请填写服务器地址');
    const hasNewSecret = f.auth === 'key' ? !!key.trim() : !!password;
    if (!initial && !hasNewSecret) return setErr(f.auth === 'key' ? '请粘贴或选择私钥' : '请填写密码');
    setBusy(true);
    try {
      const cfg = { ...f, name: f.name.trim() || f.host.trim(), host: f.host.trim(), username: f.username.trim() || 'root', port: Number(f.port) || 22 };
      await rc.servers.save(cfg, hasNewSecret ? (f.auth === 'key' ? { privateKey: key.trim() + '\n', passphrase } : { password }) : undefined);
      await rc.conn.connect(cfg.id);
      onSaved(cfg);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const kindSeg = !initial && (
    <div className="field">
      <label>连接方式</label>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button className={!isUrl ? 'on' : ''} onClick={() => set({ kind: 'ssh', workdir: '~/code' })}>SSH</button>
        <button className={isUrl ? 'on' : ''} onClick={() => set({ kind: 'url', workdir: '/root/code' })}>网址（Docker / Zeabur）</button>
      </div>
    </div>
  );

  if (isUrl) return (
    <div>
      {kindSeg}
      <div className="field"><label>网址</label><input className="input" placeholder="https://outpost-xxx.zeabur.app" value={f.url || ''} onChange={(e) => set({ url: e.target.value })} /></div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}><label>配对码{initial ? '（留空则保持不变）' : ''}</label><input className="input" placeholder="服务日志里的 8 位配对码，或你设置的配对密码" value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>名称（可选）</label><input className="input" placeholder="zeabur" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
      </div>
      <div className="field"><label>项目目录</label><input className="input" value={f.workdir} onChange={(e) => set({ workdir: e.target.value })} /></div>
      <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 10 }}>配对后这台电脑会拿到自己的钥匙，只保存在本机系统钥匙串里；配对码用一次就失效。</div>
      {err && <div className="err-text">{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        {onCancel && <button className="btn" onClick={onCancel}>取消</button>}
        <button className="btn p" disabled={busy} onClick={saveUrl}>{busy ? '连接中…' : submitLabel}</button>
      </div>
    </div>
  );

  return (
    <div>
      {kindSeg}
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}><label>地址</label><input className="input" placeholder="203.0.113.24" value={f.host} onChange={(e) => set({ host: e.target.value })} /></div>
        <div className="field" style={{ width: 90 }}><label>端口</label><input className="input" value={f.port} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}><label>用户名</label><input className="input" value={f.username} onChange={(e) => set({ username: e.target.value })} /></div>
        <div className="field" style={{ flex: 1 }}><label>名称（可选）</label><input className="input" placeholder="eu-fra-01" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
      </div>
      <div className="field">
        <label>认证方式</label>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button className={f.auth === 'key' ? 'on' : ''} onClick={() => set({ auth: 'key' })}>SSH 密钥</button>
          <button className={f.auth === 'password' ? 'on' : ''} onClick={() => set({ auth: 'password' })}>密码</button>
        </div>
      </div>
      {f.auth === 'key' ? <>
        <div className="field">
          <label style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>私钥{initial ? '（留空则保持不变）' : ''}</span>
            <a style={{ color: 'var(--text)', cursor: 'pointer' }} onClick={async () => { const k = await rc.servers.pickKeyFile(); if (k) setKey(k); }}>选择文件…</a>
          </label>
          <textarea className="input" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="field"><label>密码短语（没有就留空）</label><input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></div>
      </> : (
        <div className="field"><label>密码{initial ? '（留空则保持不变）' : ''}</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      )}
      <div className="field"><label>项目目录</label><input className="input" value={f.workdir} onChange={(e) => set({ workdir: e.target.value })} /></div>
      <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 10 }}>凭据只保存在本机系统钥匙串里。</div>
      {err && <div className="err-text">{err}</div>}
      <div className="actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        {onCancel && <button className="btn" onClick={onCancel}>取消</button>}
        <button className="btn p" disabled={busy} onClick={save}>{busy ? '连接中…' : submitLabel}</button>
      </div>
    </div>
  );
}
