import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, Dropdown, I, Markdown, resetText } from './ui';
import type { Account, OutFile } from '../../shared/types';
import { toOutFiles } from './VncView';
import { toolDiff, toolTitle, type Item, type Transcript } from '../transcript';
import { EFFORTS, MODELS, PERMS, effortLabel, modelLabel, permLabel, prettyModel } from '../options';

export interface ChatProps {
  title: string;
  cwd: string;
  branch?: string | null;
  transcript: Transcript;
  loading: boolean;
  canSend: boolean;
  blockedReason?: string;
  model: string; effort: string; permissionMode: string;
  resolved: Record<string, string>; // alias -> full model id seen on this server
  onModel(v: string): void; onEffort(v: string): void; onPerm(v: string): void;
  onSend(text: string, files?: OutFile[]): Promise<void>;
  onInterrupt(): void;
  onAnswer(req: string, d: 'allow' | 'deny'): void;
  footer: string;
  banner?: React.ReactNode;
  accounts: Account[];
  onSwitch(accountId: string): void;
}

export function Chat(p: ChatProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { items, busy } = p.transcript;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, busy, p.loading]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const shownModel = prettyModel(p.transcript.resolvedModel) || prettyModel(p.resolved[p.model || 'default']) || modelLabel(p.model);

  return (
    <>
      <div className="top drag">
        <h1>{p.title}</h1>
        <span className="path">{p.cwd.replace(/^\/(root|home\/[^/]+)/, '~')}</span>
        <div className="r">{p.branch && <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{I.branch()} {p.branch}</span>}</div>
      </div>
      {p.banner}
      <div className="chat" ref={scroller} onScroll={onScroll}>
        {p.loading ? <div className="empty"><div className="spin" style={{ margin: '0 auto' }} /></div>
          : items.length === 0 ? (
            <div className="empty">
              <h2>想让 Claude 做什么？</h2>
              <div>在 {p.cwd.replace(/^\/(root|home\/[^/]+)/, '~')} 里工作，所有命令都在你的 VPS 上执行。</div>
            </div>
          ) : (
            <div className="col">
              {items.map((it) => <ItemView key={it.key} it={it} onAnswer={p.onAnswer} accounts={p.accounts} onSwitch={p.onSwitch} />)}
              {busy && <div className="working"><div className="spin" />Claude 正在工作…</div>}
            </div>
          )}
      </div>
      <Composer {...p} shownModel={shownModel} />
    </>
  );
}

function ItemView({ it, onAnswer, accounts, onSwitch }: { it: Item; onAnswer: ChatProps['onAnswer']; accounts: Account[]; onSwitch(id: string): void }) {
  switch (it.kind) {
    case 'user': return (
      <div className="user-wrap">
        {it.files && <div className="ufiles">{it.files.map((f, i) => <span key={i} className="ufile">{f.image ? I.image(13) : I.file(13)} {f.name}</span>)}</div>}
        {it.text && <div className="user">{it.text}</div>}
      </div>
    );
    case 'text': return <Markdown text={it.text} />;
    case 'thinking': return <Thinking text={it.text} />;
    case 'tool': return <ToolCard it={it} />;
    case 'perm': return <PermCard it={it} onAnswer={onAnswer} />;
    case 'note': return <div className={`note ${it.error ? 'err' : ''}`}>{it.text}</div>;
    case 'limit': return <LimitCard it={it} accounts={accounts} onSwitch={onSwitch} />;
  }
}

function LimitCard({ it, accounts, onSwitch }: { it: Extract<Item, { kind: 'limit' }>; accounts: Account[]; onSwitch(id: string): void }) {
  const acc = accounts.find((a) => a.id === it.account);
  const name = acc?.name || it.account;
  const to = it.switchedTo ? accounts.find((a) => a.id === it.switchedTo) : null;
  const now = Date.now() / 1000;
  const usable = accounts.filter((a) => a.id !== it.account && a.loggedIn && !(a.limitedUntil && a.limitedUntil > now));
  const reset = resetText(it.resetsAt);
  return (
    <div className="limit">
      <Avatar id={it.account} name={name} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>账号「{name}」额度已用完</b>
        <div className="x">{[reset, it.switchedTo ? `${it.auto ? '已自动' : '已'}切换到「${to?.name || it.switchedTo}」继续` : usable.length ? '换个账号就能接着做' : '没有其他可用账号，可以在设置里添加'].filter(Boolean).join(' · ')}</div>
      </div>
      {!it.switchedTo && usable.length > 0 && <>
        <button className="btn p" onClick={() => onSwitch(usable[0].id)}>切换到「{usable[0].name}」并继续</button>
        {usable.length > 1 && (
          <Dropdown className="btn" align="right" trigger={<>其他 ▾</>}>
            {(close) => usable.slice(1).map((a) => <button key={a.id} className="mi" onClick={() => { close(); onSwitch(a.id); }}><Avatar id={a.id} name={a.name} size={18} /> {a.name}</button>)}
          </Dropdown>
        )}
      </>}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="think" onClick={() => setOpen(!open)}>{I.clock()}思考过程 {open ? '⌃' : '⌄'}</div>
      {open && <div className="think-body" style={{ marginTop: 6 }}>{text}</div>}
    </div>
  );
}

function ToolCard({ it }: { it: Extract<Item, { kind: 'tool' }> }) {
  const diff = toolDiff(it.name, it.input);
  const [open, setOpen] = useState(!!diff);
  const [all, setAll] = useState(false);
  const { verb, target } = toolTitle(it.name, it.input);
  const adds = diff?.filter((d) => d.t === '+').length || 0;
  const dels = diff?.filter((d) => d.t === '-').length || 0;
  const shown = diff && !all ? diff.slice(0, 40) : diff;
  const status = !it.done ? <div className="spin" /> : it.isError ? <span className="badge err">!</span> : <span className="badge ok">{I.check(10)}</span>;
  let summary = '';
  if (it.done && it.result && it.name === 'Bash') summary = `${it.result.split('\n').length} 行输出`;
  if (it.done && it.name === 'Read' && it.result) summary = `${it.result.split('\n').length} 行`;
  return (
    <div className="tool">
      <div className="th" onClick={() => setOpen(!open)}>
        {status}
        <span className="k">{verb}</span>
        <span className="f">{target}</span>
        <span className="s">
          {diff && <><span className="plus">+{adds}</span><span className="minus">−{dels}</span></>}
          {summary}
          <span>{open ? '⌃' : '⌄'}</span>
        </span>
      </div>
      {open && diff && (
        <div className="diff">
          {shown!.map((d, i) => <div key={i} className={d.t === '+' ? 'a' : d.t === '-' ? 'd' : ''}>{d.t} {d.s}</div>)}
          {diff.length > 40 && !all && <div style={{ color: 'var(--faint)', cursor: 'pointer' }} onClick={() => setAll(true)}>  … 还有 {diff.length - 40} 行，点击展开</div>}
        </div>
      )}
      {open && it.result && (!diff || it.isError) && (
        <div className={`tool-out ${it.isError ? 'err' : ''}`}>{it.result.length > 6000 ? it.result.slice(0, 6000) + '\n…' : it.result}</div>
      )}
      {open && !diff && !it.result && it.name !== 'Bash' && (
        <div className="tool-out">{JSON.stringify(it.input, null, 2)}</div>
      )}
    </div>
  );
}

function PermCard({ it, onAnswer }: { it: Extract<Item, { kind: 'perm' }>; onAnswer: ChatProps['onAnswer'] }) {
  const { verb, target } = toolTitle(it.tool, it.input || {});
  const detail = it.tool === 'Bash' ? it.input?.command : toolDiff(it.tool, it.input || {}) ? null : JSON.stringify(it.input, null, 2);
  if (it.outcome) return <div className="note">{it.outcome === 'allow' ? '已允许' : '已拒绝'}：{verb} {target}</div>;
  return (
    <div className="perm">
      <div className="q">Claude 想要{verb}{target ? `：${target.length > 80 ? target.slice(0, 80) + '…' : target}` : ''}</div>
      {detail && <pre>{detail}</pre>}
      <div className="perm-actions">
        <button className="btn p" onClick={() => onAnswer(it.req, 'allow')}>允许</button>
        <button className="btn" onClick={() => onAnswer(it.req, 'deny')}>拒绝</button>
      </div>
    </div>
  );
}

type Att = OutFile & { key: string; preview?: string };
const MAX = 30 * 1024 * 1024;

function Composer(p: ChatProps & { shownModel: string }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Att[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => { ta.current?.focus(); }, [p.cwd, p.title]);
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  const busy = p.transcript.busy;
  // Esc stops Claude while it works (unless a menu or dialog is open)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy && !document.querySelector('.overlay, .menu')) { e.preventDefault(); p.onInterrupt(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [busy, p.onInterrupt]);

  const add = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    const big = arr.find((f) => f.size > MAX);
    if (big) { setErr(`「${big.name}」超过 30 MB，先放到 VPS 上再让 Claude 读`); return; }
    const out = await toOutFiles(arr);
    setFiles((cur) => [...cur, ...out.map((f, i) => ({ ...f, key: `${Date.now()}-${i}-${f.name}`, preview: /^image\//.test(f.mime) ? URL.createObjectURL(arr[i]) : undefined }))]);
    setErr('');
    ta.current?.focus();
  };
  const submit = async () => {
    const t = text.trim();
    if ((!t && !files.length) || sending || busy || !p.canSend) return;
    setSending(true); setErr('');
    try {
      await p.onSend(t, files.map(({ key: _k, preview: _p, ...f }) => f));
      setText(''); files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)); setFiles([]);
    } catch (e: any) { setErr(e.message); } finally { setSending(false); }
  };

  return (
    <div className="comp">
      <div className={`box ${drag ? 'drag-on' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
        {files.length > 0 && (
          <div className="atts">
            {files.map((f) => (
              <div key={f.key} className={`att ${f.preview ? 'img' : ''}`} title={f.name}>
                {f.preview ? <img src={f.preview} alt="" /> : <><span className="att-ic">{I.file(16)}</span><span className="att-n">{f.name}</span></>}
                <button className="att-x" onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}>{I.x(10)}</button>
              </div>
            ))}
          </div>
        )}
        <textarea ref={ta} rows={1} value={text} placeholder={p.blockedReason || (busy ? 'Claude 正在工作，按 Esc 可以中断…' : '继续追问，可以粘贴或拖入图片、文件')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { const fl = Array.from(e.clipboardData.files || []); if (fl.length) { if (!e.clipboardData.getData('text/plain')) e.preventDefault(); add(fl); } }}
          onCompositionStart={() => (composing.current = true)} onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <div className="bar">
          <button className="icon-btn att-btn" title="添加图片或文件" onClick={() => picker.current?.click()}>{I.clip(16)}</button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
          <Dropdown className="chip b" trigger={<>{I.lock()}{permLabel(p.permissionMode)}<span className="cv">▾</span></>}>
            {(close) => PERMS.map((m) => (
              <button key={m.id} className="mi" onClick={() => { p.onPerm(m.id); close(); }}>
                <span>{m.label}<span className="d">{m.desc}</span></span>{p.permissionMode === m.id && <span className="ck">{I.check()}</span>}
              </button>
            ))}
          </Dropdown>
          <div style={{ flex: 1 }} />
          <Dropdown align="right" trigger={<><span style={{ color: 'var(--accent)' }}>✳</span><span style={{ color: 'var(--text)' }}>{p.shownModel}</span><span className="cv">⌄</span></>}>
            {(close) => <>
              <div className="mhead"><span>模型</span><span>由 VPS 上的 Claude Code 解析</span></div>
              {MODELS.map((m) => (
                <button key={m.id} className="mi" onClick={() => { p.onModel(m.id); close(); }}>
                  <span>{m.label}{p.resolved[m.id || 'default'] && <span style={{ color: 'var(--faint)' }}> → {prettyModel(p.resolved[m.id || 'default'])}</span>}<span className="d">{m.desc}</span></span>
                  {p.model === m.id && <span className="ck">{I.check()}</span>}
                </button>
              ))}
            </>}
          </Dropdown>
          <Dropdown align="right" trigger={<><span style={{ color: 'var(--text)' }}>{effortLabel(p.effort)}</span><span className="cv">⌄</span></>}>
            {(close) => <>
              <div className="mhead"><span>思考强度</span></div>
              {EFFORTS.map((m) => (
                <button key={m.id} className="mi" onClick={() => { p.onEffort(m.id); close(); }}>{m.label}{p.effort === m.id && <span className="ck">{I.check()}</span>}</button>
              ))}
              <div className="mhead"><span>模型不支持的档位会自动降级</span></div>
            </>}
          </Dropdown>
          {busy
            ? <button className="send" title="中断（Esc）" onClick={p.onInterrupt}>{I.stop()}</button>
            : <button className="send" disabled={(!text.trim() && !files.length) || sending || !p.canSend} onClick={submit}>{sending ? <div className="spin" /> : I.up()}</button>}
        </div>
        {drag && <div className="box-drop">松开添加到消息</div>}
      </div>
      {err ? <div className="hint" style={{ color: 'var(--delt)' }}>{err}</div> : <div className="hint">{p.footer}</div>}
    </div>
  );
}
