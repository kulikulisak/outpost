import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, Dropdown, I, Markdown, confirmDialog, resetText } from './ui';
import type { Account, OutFile } from '../../shared/types';
import { toOutFiles } from './VncView';
import { changeSummary, docFiles, extractLinks, fixPrompt, humanPerm, previewTarget, toolDiff, toolTitle, type Item, type Transcript } from '../transcript';
import { FileCards, LinkCards, fileItems, slashItems, trigger, type MenuItem } from './Cards';
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
  onAnswer(req: string, d: 'allow' | 'deny', extra?: { message?: string; answers?: Record<string, string> }): void;
  footer: string;
  banner?: React.ReactNode;
  accounts: Account[];
  onSwitch(accountId: string): void;
  simple: boolean;
  onRestore(checkpoint: string): Promise<void>;
  onPreview(page: string): Promise<void>;
  account: string;
  onClear(): void;
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
              {p.simple
                ? turns(items).map((g, gi, all) => g.user
                  ? <ItemView key={g.items[0].key} it={g.items[0]} {...p} />
                  : <SimpleTurn key={g.items[0]?.key || 'busy'} items={g.items} live={gi === all.length - 1 && busy} p={p} />)
                : items.map((it) => <ItemView key={it.key} it={it} {...p} />)}
              {busy && (!p.simple || items[items.length - 1]?.kind === 'user') && <div className="working"><div className="spin" />Claude 正在工作…</div>}
            </div>
          )}
      </div>
      <Composer {...p} shownModel={shownModel} />
    </>
  );
}

// a user message, then everything Claude did until the next one
function turns(items: Item[]) {
  const out: { user: boolean; items: Item[] }[] = [];
  for (const it of items) {
    if (it.kind === 'user' || (it.kind === 'note' && !it.error)) out.push({ user: true, items: [it] });
    else { const last = out[out.length - 1]; if (last && !last.user) last.items.push(it); else out.push({ user: false, items: [it] }); }
  }
  return out;
}

/** Simple mode: the steps fold into one line; what's left is Claude's last words, open questions and what changed. */
function SimpleTurn({ items, live, p }: { items: Item[]; live: boolean; p: ChatProps }) {
  const [open, setOpen] = useState(false);
  const lastText = [...items].reverse().find((x) => x.kind === 'text');
  const final = live ? undefined : lastText;
  const isStep = (x: Item) => x.kind === 'tool' || x.kind === 'thinking' || (x.kind === 'text' && x !== final) || (x.kind === 'perm' && !!x.outcome);
  const steps = items.filter(isStep);
  const rest = items.filter((x) => !isStep(x) && x !== final);
  const tools = steps.filter((x) => x.kind === 'tool');
  const current = live ? [...tools].reverse().find((x) => x.kind === 'tool' && !x.done) as Extract<Item, { kind: 'tool' }> | undefined : undefined;
  const label = live ? (current ? `正在${humanStep(current)}` : '正在思考') : `做了 ${tools.length} 步`;
  return (
    <div className="sturn">
      {(steps.length > 0 || live) && (
        <div className="steps">
          <div className="steps-h" onClick={() => setOpen(!open)}>
            {live ? <div className="spin" /> : <span className="badge ok">{I.check(10)}</span>}
            <span>{label}</span>
            {steps.length > 0 && <span className="cv">{open ? '收起' : '查看过程'} {open ? '⌃' : '⌄'}</span>}
          </div>
          {open && <div className="steps-b">{steps.map((it) => <ItemView key={it.key} it={it} {...p} />)}</div>}
        </div>
      )}
      {rest.filter((x) => x.kind === 'perm').map((it) => <ItemView key={it.key} it={it} {...p} />)}
      {final && <ItemView it={final} {...p} />}
      {rest.filter((x) => x.kind !== 'perm').map((it) => <ItemView key={it.key} it={it} {...p} />)}
    </div>
  );
}
function humanStep(t: Extract<Item, { kind: 'tool' }>): string {
  switch (t.name) {
    case 'Read': case 'Grep': case 'Glob': case 'LS': return '查看项目';
    case 'Write': return '写文件';
    case 'Edit': case 'MultiEdit': return '修改文件';
    case 'WebFetch': case 'WebSearch': return '上网查资料';
    case 'mcp__rcc__browser_open': case 'mcp__rcc__browser_read': case 'mcp__rcc__browser_click': case 'mcp__rcc__browser_type': case 'mcp__rcc__browser_scroll': case 'mcp__rcc__browser_back': case 'mcp__rcc__browser_screenshot': return '用服务器浏览器上网';
    case 'Task': case 'Agent': return '分派子任务';
    case 'TodoWrite': return '列计划';
    case 'AskUserQuestion': return '等你回答';
    case 'ExitPlanMode': return '等你确认方案';
    case 'Bash': return humanPerm('Bash', t.input).text.replace(/^在服务器上/, '');
    default: return '处理';
  }
}

function ChangesCard({ it, p }: { it: Extract<Item, { kind: 'changes' }>; p: ChatProps }) {
  const [busy, setBusy] = useState<'' | 'undo' | 'preview'>('');
  const [err, setErr] = useState('');
  const [list, setList] = useState(false);
  const page = previewTarget(it.files);
  const run = async (k: 'undo' | 'preview', f: () => Promise<void>) => { setBusy(k); setErr(''); try { await f(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); } };
  const undo = async () => {
    if (!await confirmDialog({ title: '撤销这一轮的改动？', body: '项目文件会回到这条消息发出之前的样子，之后各轮的改动也会一起撤销。撤销前会自动再存一份，不会丢。', ok: '撤销' })) return;
    run('undo', () => p.onRestore(it.checkpoint));
  };
  if (it.undone) return <div className="changes undone">{I.check(12)} 这一轮的改动已撤销</div>;
  return (
    <div className="changes">
      <div className="ch-row">
        <span className="ch-t" onClick={() => setList(!list)}>{changeSummary(it.files, it.total)} <span className="cv">{list ? '⌃' : '⌄'}</span></span>
        <div style={{ flex: 1 }} />
        {page && <button className="btn p sm" disabled={!!busy} onClick={() => run('preview', () => p.onPreview(page))}>{busy === 'preview' ? <div className="spin" /> : '预览'}</button>}
        <button className="btn sm" disabled={!!busy || p.transcript.busy} onClick={undo}>{busy === 'undo' ? <div className="spin" /> : '撤销这一轮'}</button>
      </div>
      <FileCards paths={docFiles(it.files)} cwd={p.cwd} />
      {list && <div className="ch-list">{it.files.map((f) => <div key={f.p}><span className={`fs ${f.s}`}>{f.s === 'A' ? '新建' : f.s === 'D' ? '删除' : '修改'}</span>{f.p}</div>)}</div>}
      {err && <div className="err-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function ItemView({ it, onAnswer, accounts, onSwitch, ...p }: { it: Item } & ChatProps) {
  switch (it.kind) {
    case 'user': return (
      <div className="user-wrap">
        {it.files && <div className="ufiles">{it.files.map((f, i) => <span key={i} className="ufile">{f.image ? I.image(13) : I.file(13)} {f.name}</span>)}</div>}
        {it.text && <div className="user">{it.text}</div>}
      </div>
    );
    case 'text': return <><Markdown text={it.text} /><LinkCards urls={extractLinks(it.text)} account={p.account} /></>;
    case 'thinking': return <Thinking text={it.text} />;
    case 'tool': return <ToolCard it={it} />;
    case 'perm': return <PermCard it={it} onAnswer={onAnswer} />;
    case 'note': return it.error ? <ErrorCard text={it.text} last={it.key === p.transcript.items[p.transcript.items.length - 1]?.key} busy={p.transcript.busy} onFix={() => p.onSend(fixPrompt(it.text))} /> : <div className="note">{it.text}</div>;
    case 'limit': return <LimitCard it={it} accounts={accounts} onSwitch={onSwitch} />;
    case 'changes': return <ChangesCard it={it} p={{ ...p, onAnswer, accounts, onSwitch } as ChatProps} />;
  }
}

function plainError(t: string): string {
  if (/overloaded|529/i.test(t)) return 'Claude 那边现在太忙了，稍等一会儿再试';
  if (/ECONN|network|fetch failed|timed? ?out/i.test(t)) return '服务器连不上网络或请求超时了';
  if (/permission|denied|EACCES/i.test(t)) return '没有权限做这件事';
  if (/max_turns|maximum.*turns/i.test(t)) return '这件事步骤太多，做到一半停下了';
  if (/context|too long|prompt is too long/i.test(t)) return '对话太长了，可以输入 /compact 压缩一下再继续';
  return '这一步没做成';
}
function ErrorCard({ text, last, busy, onFix }: { text: string; last: boolean; busy: boolean; onFix(): Promise<void> }) {
  const [more, setMore] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className="errcard">
      <div className="ec-h"><span className="badge err">!</span><b>{plainError(text)}</b></div>
      {more ? <pre>{text}</pre> : <div className="more" onClick={() => setMore(true)}>查看原始信息 ⌄</div>}
      {last && !sent && <div className="perm-actions"><button className="btn p" disabled={busy} onClick={async () => { setSent(true); try { await onFix(); } catch { setSent(false); } }}>让 Claude 修好</button></div>}
    </div>
  );
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

/** Claude's multiple-choice question (AskUserQuestion): picks go back as answers {question: label}. */
function AskCard({ it, onAnswer }: { it: Extract<Item, { kind: 'perm' }>; onAnswer: ChatProps['onAnswer'] }) {
  const qs: any[] = Array.isArray(it.input?.questions) ? it.input.questions : [];
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  if (it.outcome) return <div className="note">{it.outcome === 'allow' ? '已回答' : '已跳过'}：{qs.map((q) => q.question).join('；').slice(0, 80)}</div>;
  const toggle = (q: any, label: string) => setPick((p) => {
    const cur = p[q.question] || [];
    return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  const value = (q: any) => [...(pick[q.question] || []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(', ');
  const ready = qs.length > 0 && qs.every((q) => value(q));
  return (
    <div className="perm ask">
      {qs.map((q, i) => (
        <div key={i} className="askq">
          <div className="q">{q.question}</div>
          <div className="opts">
            {(q.options || []).map((o: any) => (
              <button key={o.label} className={`opt ${(pick[q.question] || []).includes(o.label) ? 'on' : ''}`} onClick={() => toggle(q, o.label)}>
                <b>{o.label}</b>{o.description && <span>{o.description}</span>}
              </button>
            ))}
          </div>
          <input className="input" placeholder="都不是？直接写你的想法" value={other[q.question] || ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />
        </div>
      ))}
      <div className="perm-actions">
        <button className="btn p" disabled={!ready} onClick={() => onAnswer(it.req, 'allow', { answers: Object.fromEntries(qs.map((q) => [q.question, value(q)])) })}>回答</button>
        <button className="btn" onClick={() => onAnswer(it.req, 'deny', { message: '用户跳过了这个问题，请按你认为最合适的方式继续，或者用文字再问一次。' })}>跳过</button>
      </div>
    </div>
  );
}

function PermCard({ it, onAnswer }: { it: Extract<Item, { kind: 'perm' }>; onAnswer: ChatProps['onAnswer'] }) {
  void toolTitle;
  if (it.tool === 'AskUserQuestion') return <AskCard it={it} onAnswer={onAnswer} />;
  if (it.tool === 'ExitPlanMode') {
    if (it.outcome) return <div className="note">{it.outcome === 'allow' ? '已同意方案，开始动手' : '方案未通过'}</div>;
    return (
      <div className="perm">
        <div className="q">方案写好了，同意后开始动手</div>
        {it.input?.plan && <Markdown text={String(it.input.plan)} />}
        <div className="perm-actions">
          <button className="btn p" onClick={() => onAnswer(it.req, 'allow')}>开始做</button>
          <button className="btn" onClick={() => onAnswer(it.req, 'deny', { message: '用户想先改改方案，请问问他哪里需要调整。' })}>再改改</button>
        </div>
      </div>
    );
  }
  const [more, setMore] = useState(false);
  const h = humanPerm(it.tool, it.input || {});
  const detail = it.tool === 'Bash' ? it.input?.command : toolDiff(it.tool, it.input || {}) ? null : JSON.stringify(it.input, null, 2);
  if (it.outcome) return <div className="note">{it.outcome === 'allow' ? '已允许' : '已拒绝'}：{h.text}</div>;
  return (
    <div className={`perm ${h.risk}`}>
      <div className="q">Claude 想要{h.text}，可以吗？</div>
      {h.risk === 'high' && <div className="risk">这一步可能删掉东西或改动服务器，不确定就点拒绝。</div>}
      {detail && (more ? <pre>{detail}</pre> : <div className="more" onClick={() => setMore(true)}>查看具体内容 ⌄</div>)}
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
  const [menu, setMenu] = useState<{ kind: '/' | '@'; start: number; items: MenuItem[]; sel: number } | null>(null);
  const menuSeq = useRef(0);
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
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy && !document.querySelector('.overlay, .menu, .cmenu')) { e.preventDefault(); p.onInterrupt(); } };
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
  const updateMenu = (value: string, caret: number) => {
    const t = trigger(value, caret);
    if (!t) { setMenu(null); return; }
    const seq = ++menuSeq.current;
    (t.kind === '/' ? slashItems(p.cwd, t.q) : fileItems(p.cwd, t.q)).then((items) => {
      if (seq !== menuSeq.current) return;
      setMenu(items.length ? { kind: t.kind, start: t.start, items, sel: 0 } : null);
    });
  };
  const pick = (m: MenuItem) => {
    const el = ta.current!; const caret = el.selectionStart;
    setMenu(null); menuSeq.current++;
    if (m.run === 'clear') { setText(''); p.onClear(); return; }
    const next = text.slice(0, menu!.start) + m.insert + (menu!.kind === '/' ? ' ' : '') + text.slice(caret);
    setText(next);
    const pos = menu!.start + m.insert.length + (menu!.kind === '/' ? 1 : 0);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
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
        <textarea ref={ta} rows={1} value={text} placeholder={p.blockedReason || (busy ? 'Claude 正在工作，按 Esc 可以中断…' : '继续追问，输入 / 用命令，@ 引用文件，也可以粘贴或拖入图片')}
          onChange={(e) => { setText(e.target.value); updateMenu(e.target.value, e.target.selectionStart); }}
          onBlur={() => setTimeout(() => setMenu(null), 150)}
          onPaste={(e) => { const fl = Array.from(e.clipboardData.files || []); if (fl.length) { if (!e.clipboardData.getData('text/plain')) e.preventDefault(); add(fl); } }}
          onCompositionStart={() => (composing.current = true)} onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (menu && !composing.current) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenu({ ...menu, sel: (menu.sel + (e.key === 'ArrowDown' ? 1 : -1) + menu.items.length) % menu.items.length }); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(menu.items[menu.sel]); return; }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        {menu && (
          <div className="cmenu">
            <div className="cm-h">{menu.kind === '/' ? '命令' : '引用项目里的文件'}</div>
            {menu.items.map((m, i) => (
              <button key={m.key} className={`cm-i ${i === menu.sel ? 'on' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(m); }} onMouseEnter={() => setMenu({ ...menu, sel: i })}>
                <span className="cm-l">{m.label}</span>{m.desc && <span className="cm-d">{m.desc}</span>}
              </button>
            ))}
          </div>
        )}
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
