import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, stream, type Account, type LiveSession } from './api';
import { buildTranscript, changeSummary, docFiles, extractLinks, fixPrompt, humanPerm, previewTarget, toolDiff, toolTitle, type Item } from '@desktop/transcript';
import { FileCards, LinkCards, fileItems, native, slashItems, trigger, type MenuItem } from './Cards';

const Ctx = createContext<{ cwd: string; busy: boolean; onFix(err: string): void; onServerBrowser(url: string): void; lastKey?: string }>({ cwd: '', busy: false, onFix() {}, onServerBrowser() {} });
import { EFFORTS, MODELS, PERMS, prettyModel } from '@desktop/options';
import { I, Markdown, Sheet, base, short, toast } from './ui';
import { OptionsSheet, isSimple, loadOpts, saveOpts, type Open, type RunOpts } from './Lists';
import { toAtts, type Att } from './files';

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export function Chat({ open, sessions, accounts, onBack, onSwitch, onWeb, onNewChat }: {
  open: Open; sessions: LiveSession[] | null; accounts: Account[]; onBack(): void; onSwitch(sid: string): void; onWeb(account: string, url: string): void; onNewChat(cwd: string): void;
}) {
  const sid = 'sid' in open ? open.sid : null;
  const meta = sid ? sessions?.find((s) => s.sid === sid) : undefined;
  const [hist, setHist] = useState<any[]>([]);
  const [live, setLive] = useState<any[]>([]);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const resumeId = 'resumeId' in open ? open.resumeId : meta?.resume || null;

  // history of a resumed Claude session, then the live rcc stream on top
  useEffect(() => {
    let dead = false;
    setHist([]); setLive([]); setLoading(true);
    const loadHist = resumeId ? api<any[]>(`/api/history?id=${encodeURIComponent(resumeId)}`, undefined, { timeout: 60000 }).catch(() => []) : Promise.resolve([]);
    let stop = () => {};
    loadHist.then((h) => {
      if (dead) return;
      setHist(h); setLoading(false);
      if (sid) stop = stream(sid, 0, (evs) => setLive((l) => l.concat(evs)), setOnline);
    });
    return () => { dead = true; stop(); };
  }, [sid, resumeId]);

  const t = useMemo(() => buildTranscript([...hist, ...live]), [hist, live]);
  // a user bubble, then everything Claude did until the next user message as one turn under its avatar
  const groups = useMemo(() => {
    const out: { user: boolean; items: Item[] }[] = [];
    for (const it of t.items) {
      if (it.kind === 'user') out.push({ user: true, items: [it] });
      else if (it.kind === 'note' && !it.error) out.push({ user: true, items: [it] });
      else { const last = out[out.length - 1]; if (last && !last.user) last.items.push(it); else out.push({ user: false, items: [it] }); }
    }
    if (t.busy && (!out.length || out[out.length - 1].user)) out.push({ user: false, items: [] });
    return out;
  }, [t.items, t.busy]);
  const running = !!sid && (meta ? meta.status === 'running' || meta.status === 'starting' : !t.exited);
  const cwd = 'cwd' in open ? open.cwd : meta?.cwd || '';
  const title = 'title' in open ? open.title : meta?.title || meta?.firstText || base(cwd);

  // scroll: stick to the bottom unless the user scrolled up to read
  const sc = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { if (stick.current && sc.current) sc.current.scrollTop = sc.current.scrollHeight; }, [t.items.length, t.busy, loading, live.length]);
  const onScroll = () => { const el = sc.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };

  // permission prompts: pop the newest unanswered one as a sheet
  const pendingPerm = [...t.items].reverse().find((x) => x.kind === 'perm' && !x.outcome) as Extract<Item, { kind: 'perm' }> | undefined;
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const showPerm = pendingPerm && pendingPerm.tool !== 'AskUserQuestion' && pendingPerm.tool !== 'ExitPlanMode' && !dismissed.has(pendingPerm.req) && !answered.has(pendingPerm.req);
  const answer = async (req: string, decision: 'allow' | 'deny', extra: { message?: string; rule?: string } = {}) => {
    setAnswered((s) => new Set(s).add(req));
    try { await api('/api/answer', { sid, req, decision, ...extra }); }
    catch (e: any) { toast(e.message); setAnswered((s) => { const n = new Set(s); n.delete(req); return n; }); }
  };

  // composer
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [sending, setSending] = useState(false);
  const [opts, setOpts] = useState<RunOpts>(() => ({ ...loadOpts(), ...(meta ? { model: meta.model || '', effort: meta.effort || loadOpts().effort, permissionMode: meta.permissionMode || 'default', account: meta.account } : {}) }));
  const [showOpts, setShowOpts] = useState(false);
  const optsAtOpen = useRef<RunOpts | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (meta) setOpts((o) => ({ ...o, model: meta.model || '', effort: meta.effort || o.effort, permissionMode: meta.permissionMode || o.permissionMode, account: meta.account })); }, [meta?.sid]);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(160, el.scrollHeight) + 'px'; } }, [text]);

  const startWith = async (o: RunOpts, resume: string | null) => {
    const r = await api<{ sid: string }>('/api/start', { cwd, model: o.model || undefined, effort: o.effort, permissionMode: o.permissionMode, account: o.account || undefined, resume: resume || undefined, title: title?.slice(0, 40), simple: isSimple(), browser: localStorage.getItem('rcc.browser') !== '0' });
    await new Promise((res) => setTimeout(res, 500));
    return r.sid;
  };
  const sendTo = async (target: string, body: { text: string; files: { name: string; mime: string; data: string }[] }) => {
    for (let i = 0; ; i++) {
      try { await api('/api/send', { sid: target, ...body }, { timeout: 120000 }); return; }
      catch (e: any) { if (i >= 10 || !/fifo|attached/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 500)); }
    }
  };
  const submit = async (override?: string) => {
    const msg = (override ?? text).trim();
    if ((!msg && !atts.length) || sending) return;
    setSending(true);
    const body = { text: msg, files: override ? [] : atts.map(({ name, mime, data }) => ({ name, mime, data })) };
    try {
      if (running && sid) { await sendTo(sid, body); }
      else {
        // not live (history, or the session ended): continue it as a new run that resumes the conversation
        const nsid = await startWith(opts, t.claudeSessionId || resumeId);
        await sendTo(nsid, body);
        onSwitch(nsid);
      }
      if (!override) { setText(''); setAtts([]); } stick.current = true;
    } catch (e: any) { toast(e.message); }
    setSending(false);
  };
  const interrupt = () => sid && api('/api/interrupt', { sid }).catch((e) => toast(e.message));

  // changing model / effort / permission / account on a running session restarts it on the same conversation
  const applyOpts = async (o: RunOpts) => {
    const before = optsAtOpen.current; optsAtOpen.current = null;
    saveOpts(o);
    if (!before || !sid || !running) return;
    const changed = before.model !== o.model || before.effort !== o.effort || before.permissionMode !== o.permissionMode || (o.account && before.account !== o.account);
    if (!changed) return;
    if (t.busy) { toast('等这一轮结束再切换'); setOpts(before); return; }
    try {
      await api('/api/stop', { sid });
      const nsid = await startWith(o, t.claudeSessionId || resumeId);
      onSwitch(nsid);
      toast('已切换，接着同一段对话');
    } catch (e: any) { toast(e.message); }
  };

  // voice input (the phone's own speech engine; only text reaches the VPS)
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR(); recRef.current = rec;
    rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false;
    const start = text;
    rec.onresult = (e: any) => { let s = ''; for (const r of e.results) s += r[0].transcript; setText(start + s); };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start(); setListening(true);
  };

  // limit card: switch to another account and send the last message again
  const lastUserText = [...t.items].reverse().find((x) => x.kind === 'user') as Extract<Item, { kind: 'user' }> | undefined;
  const switchAccount = async (acc: string) => {
    try {
      if (sid && running) await api('/api/stop', { sid });
      const o = { ...opts, account: acc }; setOpts(o); saveOpts(o);
      const nsid = await startWith(o, t.claudeSessionId || resumeId);
      if (lastUserText?.text) await sendTo(nsid, { text: lastUserText.text, files: [] });
      onSwitch(nsid);
    } catch (e: any) { toast(e.message); }
  };

  const [menu, setMenu] = useState(false);
  const [cm, setCm] = useState<{ kind: '/' | '@'; start: number; items: MenuItem[] } | null>(null);
  const cmSeq = useRef(0);
  const onType = (v: string, caret: number) => {
    setText(v);
    const tr = trigger(v, caret);
    if (!tr || !cwd) { setCm(null); return; }
    const seq = ++cmSeq.current;
    (tr.kind === '/' ? slashItems(cwd, tr.q) : fileItems(cwd, tr.q)).then((items) => { if (seq === cmSeq.current) setCm(items.length ? { kind: tr.kind, start: tr.start, items } : null); });
  };
  const pickCm = (m: MenuItem) => {
    const el = ta.current!; const caret = el.selectionStart;
    setCm(null); cmSeq.current++;
    if (m.run === 'clear') { setText(''); onNewChat(cwd); return; }
    const add = m.insert + (cm!.kind === '/' ? ' ' : '');
    setText(text.slice(0, cm!.start) + add + text.slice(caret));
    const pos = cm!.start + add.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };
  const ctx = { cwd, busy: t.busy, onFix: (err: string) => submit(fixPrompt(err)), onServerBrowser: (url: string) => onWeb(opts.account || meta?.account || accounts.find((a) => a.active)?.id || 'default', url), lastKey: t.items[t.items.length - 1]?.key };
  const simple = isSimple();
  const resolved = prettyModel(t.resolvedModel || meta?.resolvedModel);
  const modelLabel = (resolved && (!opts.model || resolved.toLowerCase().startsWith(opts.model)) ? resolved : opts.model ? MODELS.find((m) => m.id === opts.model)?.label : null) || '默认模型';
  const effortLabel = EFFORTS.find((e) => e.id === opts.effort)?.label || '';
  const permLabel = PERMS.find((p) => p.id === opts.permissionMode)?.label || '';
  const sub = [base(meta?.repo || cwd), meta?.worktree || null].filter(Boolean).join(' · ');

  return (
    <div className="page">
      <div className="ch">
        <button className="ib" onClick={onBack} aria-label="返回">{I.back}</button>
        <div className="tt"><b>{title || '对话'}</b><span>{!online && running ? '重新连接中…' : sub}</span></div>
        <button className="ib" onClick={() => setMenu(true)} aria-label="更多">{I.more}</button>
      </div>
      <Ctx.Provider value={ctx}>
      <div className="scroll" ref={sc} onScroll={onScroll}>
        <div className="msgs">
          {loading && <div className="note">正在读取对话…</div>}
          {!loading && !t.items.length && <div className="note">{/\/chat$/.test(cwd) ? '随便问：查资料、写东西、做表格、整理想法都行' : sid ? '会话已就绪，说点什么吧' : '这段对话还没有内容'}</div>}
          {groups.map((g, gi) => g.user
            ? <Row key={g.items[0].key} it={g.items[0]} answered={answered} onAnswer={answer} accounts={accounts} onSwitchAccount={switchAccount} currentAccount={opts.account || meta?.account} cwd={cwd} />
            : <div key={g.items[0]?.key || 'busy'} className="turn">
                <div className="who"><span className="claude">{I.spark}</span>Claude</div>
                <div className="tb">
                  {simple
                    ? <SimpleTurn items={g.items} live={gi === groups.length - 1 && t.busy && running} row={(it) => <Row key={it.key} it={it} answered={answered} onAnswer={answer} accounts={accounts} onSwitchAccount={switchAccount} currentAccount={opts.account || meta?.account} cwd={cwd} sid={sid} busy={t.busy} />} />
                    : g.items.map((it) => <Row key={it.key} it={it} answered={answered} onAnswer={answer} accounts={accounts} onSwitchAccount={switchAccount} currentAccount={opts.account || meta?.account} cwd={cwd} sid={sid} busy={t.busy} />)}
                  {!simple && gi === groups.length - 1 && t.busy && running && <div className="think"><span className="dots"><i /><i /><i /></span>{t.items.length && t.items[t.items.length - 1].kind === 'tool' ? '正在处理' : '思考中'}</div>}
                </div>
              </div>)}
          {!running && sid && !loading && <div className="note">会话已结束，继续发消息会接着这段对话</div>}
        </div>
      </div>
      </Ctx.Provider>
      <div className="comp">
        <div className="box">
          {cm && <div className="cmenu"><div className="cm-h">{cm.kind === '/' ? '命令' : '引用项目里的文件'}</div>{cm.items.map((m) => <button key={m.key} className="cm-i" onMouseDown={(e) => e.preventDefault()} onClick={() => pickCm(m)}><b>{m.label}</b>{m.desc && <span>{m.desc}</span>}</button>)}</div>}
          {atts.length > 0 && <div className="atts">{atts.map((a) => <div key={a.id} className="att">{a.preview ? <img src={a.preview} alt="" /> : <span>{a.name}</span>}<button onClick={() => setAtts((l) => l.filter((x) => x.id !== a.id))}>×</button></div>)}</div>}
          <textarea ref={ta} rows={1} value={text} onChange={(e) => onType(e.target.value, e.target.selectionStart)} onBlur={() => setTimeout(() => setCm(null), 200)} placeholder={running ? '继续说点什么… / 用命令，@ 引用文件' : '发消息，接着这段对话'}
            onPaste={async (e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); try { setAtts([...atts, ...(await toAtts(fs))]); } catch (er: any) { toast(er.message); } } }} />
          <div className="bar">
            <button className="mic" onClick={() => fileIn.current?.click()} aria-label="附件">{I.clip}</button>
            <button className="sel" onClick={() => { optsAtOpen.current = opts; setShowOpts(true); }}>
              <span>{modelLabel}</span>{effortLabel && <em>{effortLabel}</em>}
              {opts.permissionMode !== 'default' && <em className={opts.permissionMode === 'bypassPermissions' ? 'warn' : ''}>{permLabel}</em>}
              {I.down}
            </button>
            {SR && !t.busy && <button className={`mic ${listening ? 'on' : ''}`} style={{ marginLeft: 'auto' }} onClick={toggleMic} aria-label="语音输入">{I.mic}</button>}
            {t.busy && running && !text.trim() && !atts.length
              ? <button className="stop" onClick={interrupt} aria-label="停止"><i /></button>
              : <button className="send" style={SR && !t.busy ? { marginLeft: 0 } : undefined} disabled={(!text.trim() && !atts.length) || sending} onClick={() => submit()} aria-label="发送">{sending ? <span className="spin" style={{ borderTopColor: '#fff' }} /> : I.up}</button>}
          </div>
        </div>
        <input ref={fileIn} type="file" multiple hidden onChange={async (e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) { try { setAtts([...atts, ...(await toAtts(f))]); } catch (er: any) { toast(er.message); } } }} />
      </div>

      {showPerm && pendingPerm && <PermSheet it={pendingPerm} title={title || ''} onClose={() => setDismissed((s) => new Set(s).add(pendingPerm.req))} onAnswer={answer} />}
      {showOpts && <OptionsSheet value={opts} accounts={accounts} onChange={setOpts} onClose={() => { setShowOpts(false); applyOpts(opts); }} title={running ? '模型与账号（会接着当前对话重启）' : '模型与账号'} />}
      {menu && (
        <Sheet onClose={() => setMenu(false)}>
          <h2>{title}</h2>
          <div className="sub">{short(cwd)}{meta?.claudeSessionId ? ` · ${meta.claudeSessionId.slice(0, 8)}` : ''}</div>
          <div className="btns">
            {running && <button className="btn" onClick={async () => { setMenu(false); try { await api('/api/stop', { sid }); toast('会话已停止'); } catch (e: any) { toast(e.message); } }}>停止这个会话</button>}
            <button className="btn" onClick={() => { setMenu(false); navigator.clipboard?.writeText(cwd).then(() => toast('已复制目录')); }}>复制项目目录</button>
            <button className="btn dark" onClick={() => setMenu(false)}>关闭</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** Simple mode: steps fold into one line; Claude's last words, open questions and what changed stay visible. */
function SimpleTurn({ items, live, row }: { items: Item[]; live: boolean; row(it: Item): any }) {
  const [open, setOpen] = useState(false);
  const final = live ? undefined : [...items].reverse().find((x) => x.kind === 'text');
  const isStep = (x: Item) => x.kind === 'tool' || x.kind === 'thinking' || (x.kind === 'text' && x !== final) || (x.kind === 'perm' && !!x.outcome);
  const steps = items.filter(isStep);
  const rest = items.filter((x) => !isStep(x) && x !== final);
  const tools = steps.filter((x) => x.kind === 'tool') as Extract<Item, { kind: 'tool' }>[];
  const cur = live ? [...tools].reverse().find((x) => !x.done) : undefined;
  const label = live ? (cur ? `正在${stepWord(cur)}` : '正在思考') : `做了 ${tools.length} 步`;
  return <>
    {(steps.length > 0 || live) && (
      <div className="steps">
        <button className="steps-h" onClick={() => setOpen((o) => !o)}>
          {live ? <span className="dots"><i /><i /><i /></span> : <span className="ok">✓</span>}<span>{label}</span>
          {steps.length > 0 && <span className="cv">{open ? '收起' : '查看过程'}</span>}
        </button>
        {open && <div className="steps-b">{steps.map(row)}</div>}
      </div>
    )}
    {rest.filter((x) => x.kind === 'perm').map(row)}
    {final && row(final)}
    {rest.filter((x) => x.kind !== 'perm').map(row)}
  </>;
}
function stepWord(t: Extract<Item, { kind: 'tool' }>) {
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

function Changes({ it, sid, busy }: { it: Extract<Item, { kind: 'changes' }>; sid: string | null; busy: boolean }) {
  const [list, setList] = useState(false);
  const [doing, setDoing] = useState(false);
  const ctxCwd = useContext(Ctx).cwd;
  const page = previewTarget(it.files);
  if (it.undone) return <div className="changes undone">✓ 这一轮的改动已撤销</div>;
  const preview = async () => {
    if (!sid) return toast('会话已结束，发一条消息后再预览');
    if (native) { try { const r = await api<{ url: string }>('/api/preview', { sid }); native.openUrl(r.url + page!.split('/').map(encodeURIComponent).join('/')); } catch (e: any) { toast(e.message); } return; }
    const w = window.open('about:blank', '_blank');
    try { const r = await api<{ url: string }>('/api/preview', { sid }); const u = r.url + page!.split('/').map(encodeURIComponent).join('/'); if (w) w.location.href = u; else location.href = u; }
    catch (e: any) { w?.close(); toast(e.message); }
  };
  const undo = async () => {
    if (!sid) return toast('会话已结束，重新打开后再撤销');
    if (!confirm('撤销这一轮的改动？项目文件会回到这条消息发出之前的样子，之后各轮的改动也一起撤销。撤销前会自动再存一份。')) return;
    setDoing(true);
    try { await api('/api/restore', { sid, checkpoint: it.checkpoint }, { timeout: 120000 }); toast('已撤销'); } catch (e: any) { toast(e.message); }
    setDoing(false);
  };
  return (
    <div className="changes">
      <div className="crow">
        <button className="ct" onClick={() => setList((l) => !l)}>{changeSummary(it.files, it.total)} <span className="cv">{list ? '⌃' : '⌄'}</span></button>
        {page && <button className="lk y" onClick={preview}>预览</button>}
        <button className="lk" disabled={doing || busy} onClick={undo}>{doing ? '正在撤销…' : '撤销'}</button>
      </div>
      {list && <div className="cl mono">{it.files.map((f) => <div key={f.p}><span className={`fs ${f.s}`}>{f.s === 'A' ? '新建' : f.s === 'D' ? '删除' : '修改'}</span>{f.p}</div>)}</div>}
      <FileCards paths={docFiles(it.files)} cwd={ctxCwd} />
    </div>
  );
}

function Row({ it, answered, onAnswer, accounts, onSwitchAccount, currentAccount, cwd = '', sid = null, busy = false }: {
  sid?: string | null; busy?: boolean;
  cwd?: string; it: Item; answered: Set<string>; onAnswer(req: string, d: 'allow' | 'deny', extra?: any): void; accounts: Account[]; onSwitchAccount(id: string): void; currentAccount?: string;
}) {
  const [openTool, setOpenTool] = useState(false);
  const ctx = useContext(Ctx);
  const rel = (x: string) => { const c = short(cwd); return c && x.startsWith(c + '/') ? x.slice(c.length + 1) : x; };
  switch (it.kind) {
    case 'user':
      return <div className="u">{it.text}{it.files?.length ? <div className="files">{it.files.map((f, i) => <span key={i}>{f.image ? I.img : I.clip}{f.name}</span>)}</div> : null}</div>;
    case 'text': return <><Markdown text={it.text} /><LinkCards urls={extractLinks(it.text)} onServerBrowser={ctx.onServerBrowser} /></>;
    case 'thinking': return <details className="thinkbox"><summary>思考过程</summary><div>{it.text}</div></details>;
    case 'note': return it.error ? <ErrCard text={it.text} last={ctx.lastKey === it.key} /> : <div className="note">{it.text}</div>;
    case 'changes': return <Changes it={it} sid={sid} busy={busy} />;
    case 'perm': {
      const done = it.outcome || answered.has(it.req);
      if (it.tool === 'AskUserQuestion') return <AskCard it={it} done={!!done} onAnswer={onAnswer} />;
      if (it.tool === 'ExitPlanMode') {
        if (done) return <div className={`permdone ${it.outcome === 'deny' ? 'no' : ''}`}>{it.outcome === 'deny' ? '方案未通过' : '已同意方案'}</div>;
        return (
          <div className="permcard">
            <div><b>方案写好了</b> · 同意后开始动手</div>
            {it.input?.plan && <div style={{ marginTop: 8 }}><Markdown text={String(it.input.plan)} /></div>}
            <div className="acts"><button onClick={() => onAnswer(it.req, 'deny', { message: '用户想先改改方案，请问问他哪里需要调整。' })}>再改改</button><button className="y" onClick={() => onAnswer(it.req, 'allow')}>开始做</button></div>
          </div>
        );
      }
      const hp = humanPerm(it.tool, it.input || {});
      void rel;
      if (done) return <div className={`permdone ${it.outcome === 'deny' ? 'no' : ''}`}>{it.outcome === 'deny' ? '已拒绝' : '已允许'} · {hp.text}</div>;
      return (
        <div className={`permcard ${hp.risk}`}>
          <div><b>需要你同意</b> · Claude 想要{hp.text}</div>
          {!done && <div className="acts"><button onClick={() => onAnswer(it.req, 'deny')}>拒绝</button><button className="y" onClick={() => onAnswer(it.req, 'allow')}>允许</button></div>}
        </div>
      );
    }
    case 'limit': {
      const others = accounts.filter((a) => a.id !== (currentAccount || it.account) && a.loggedIn && !(a.limitedUntil && a.limitedUntil * 1000 > Date.now()));
      const name = accounts.find((a) => a.id === it.account)?.name || it.account;
      return (
        <div className="limit">
          <b>「{name}」的额度用完了</b>{it.resetsAt ? `，${new Date(it.resetsAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 恢复` : ''}
          {it.switchedTo ? <div>已切到「{accounts.find((a) => a.id === it.switchedTo)?.name || it.switchedTo}」继续</div>
            : others.length > 0 && <div className="sugg" style={{ marginTop: 8 }}>{others.map((a) => <button key={a.id} className="chip" onClick={() => onSwitchAccount(a.id)}>换到「{a.name}」继续</button>)}</div>}
        </div>
      );
    }
    case 'tool': {
      if (it.name === 'TodoWrite' && Array.isArray(it.input?.todos)) {
        return <div className="todo">{it.input.todos.map((td: any, i: number) => <div key={i} className={`x ${td.status === 'completed' ? 'd' : td.status === 'in_progress' ? 'n' : ''}`}><i /><span>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span></div>)}</div>;
      }
      const tt = toolTitle(it.name, it.input || {});
      const diff = toolDiff(it.name, it.input || {});
      const adds = diff?.filter((d) => d.t === '+').length || 0, dels = diff?.filter((d) => d.t === '-').length || 0;
      return (
        <div className="tool">
          <button className="h" onClick={() => setOpenTool((o) => !o)}>
            <b>{tt.verb}</b><span className="tg">{rel(tt.target)}</span>
            <span className="r">{!it.done ? <span className="spin" /> : it.isError ? <span className="bad">失败</span> : diff ? <span className="ok">+{adds} −{dels}</span> : <span className="ok">✓</span>}</span>
          </button>
          {diff && (openTool || diff.length <= 8) && <div className="diff mono">{diff.slice(0, 400).map((d, i) => <div key={i} className={d.t === '+' ? 'p' : d.t === '-' ? 'm' : ''}>{d.t} {d.s}</div>)}</div>}
          {!diff && openTool && it.result != null && <pre className="res">{String(it.result).slice(0, 6000)}</pre>}
        </div>
      );
    }
  }
  return null;
}

function ErrCard({ text, last }: { text: string; last: boolean }) {
  const ctx = useContext(Ctx);
  const [more, setMore] = useState(false);
  const [sent, setSent] = useState(false);
  const plain = /overloaded|529/i.test(text) ? 'Claude 那边现在太忙了，稍等再试' : /context|too long/i.test(text) ? '对话太长了，输入 /compact 压缩一下' : /max_turns/i.test(text) ? '步骤太多，做到一半停下了' : '这一步没做成';
  return (
    <div className="errcard">
      <b>{plain}</b>
      {more ? <pre className="res">{text}</pre> : <button className="more" onClick={() => setMore(true)}>查看原始信息 ⌄</button>}
      {last && !sent && <div className="acts"><button className="y" disabled={ctx.busy} onClick={() => { setSent(true); ctx.onFix(text); }}>让 Claude 修好</button></div>}
    </div>
  );
}

function AskCard({ it, done, onAnswer }: { it: Extract<Item, { kind: 'perm' }>; done: boolean; onAnswer(req: string, d: 'allow' | 'deny', extra?: any): void }) {
  const qs: any[] = Array.isArray(it.input?.questions) ? it.input.questions : [];
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  if (done) return <div className={`permdone ${it.outcome === 'deny' ? 'no' : ''}`}>{it.outcome === 'deny' ? '已跳过' : '已回答'} · {qs.map((q) => q.question).join('；').slice(0, 60)}</div>;
  const toggle = (q: any, l: string) => setPick((p) => { const c = p[q.question] || []; return { ...p, [q.question]: q.multiSelect ? (c.includes(l) ? c.filter((x) => x !== l) : [...c, l]) : [l] }; });
  const val = (q: any) => [...(pick[q.question] || []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(', ');
  const ready = qs.length > 0 && qs.every((q) => val(q));
  return (
    <div className="permcard ask">
      {qs.map((q, i) => (
        <div key={i} className="askq">
          <b>{q.question}</b>
          {(q.options || []).map((o: any) => <button key={o.label} className={`opt ${(pick[q.question] || []).includes(o.label) ? 'on' : ''}`} onClick={() => toggle(q, o.label)}><span>{o.label}</span>{o.description && <em>{o.description}</em>}</button>)}
          <input className="field" placeholder="都不是？直接写你的想法" value={other[q.question] || ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />
        </div>
      ))}
      <div className="acts">
        <button onClick={() => onAnswer(it.req, 'deny', { message: '用户跳过了这个问题，请按你认为最合适的方式继续，或者用文字再问一次。' })}>跳过</button>
        <button className="y" disabled={!ready} onClick={() => onAnswer(it.req, 'allow', { answers: Object.fromEntries(qs.map((q) => [q.question, val(q)])) })}>回答</button>
      </div>
    </div>
  );
}

function PermSheet({ it, title, onClose, onAnswer }: { it: Extract<Item, { kind: 'perm' }>; title: string; onClose(): void; onAnswer(req: string, d: 'allow' | 'deny', extra?: any): void }) {
  const [why, setWhy] = useState<string | null>(null);
  const input = it.input || {};
  const tt = toolTitle(it.tool, input);
  const body = it.tool === 'Bash' ? `$ ${input.command || ''}${input.description ? `\n# ${input.description}` : ''}`
    : it.tool === 'Edit' || it.tool === 'MultiEdit' || it.tool === 'Write' ? (toolDiff(it.tool, input) || []).slice(0, 60).map((d) => `${d.t} ${d.s}`).join('\n')
    : JSON.stringify(input, null, 2).slice(0, 2000);
  const prefix = it.tool === 'Bash' ? String(input.command || '').trim().split(/\s+/).slice(0, 2).join(' ') : '';
  const hp = humanPerm(it.tool, input);
  const [more, setMore] = useState(false);
  return (
    <Sheet onClose={onClose}>
      <h2>Claude 想要{hp.text}，可以吗？</h2>
      <div className="sub">{title}</div>
      {hp.risk === 'high' && <div className="risk">这一步可能删掉东西或改动服务器，不确定就点拒绝。</div>}
      {more ? <div className="cmd mono">{body}</div> : <button className="more" onClick={() => setMore(true)}>查看具体内容 ⌄</button>}
      {why === null ? (
        <div className="btns">
          <button className="btn pri" onClick={() => { onAnswer(it.req, 'allow'); onClose(); }}>允许一次</button>
          <button className="btn" onClick={() => { onAnswer(it.req, 'allow', { rule: prefix ? `Bash:${prefix}` : it.tool }); onClose(); }}>这个会话里同类操作都允许</button>
          <button className="btn ghost" onClick={() => setWhy('')}>拒绝并告诉它原因</button>
        </div>
      ) : (
        <>
          <textarea className="field" rows={3} autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="比如：别动数据库，先给我看迁移内容" style={{ resize: 'none', marginTop: 14 }} />
          <div className="btns"><button className="btn dark" onClick={() => { onAnswer(it.req, 'deny', why.trim() ? { message: why.trim() } : {}); onClose(); }}>拒绝</button></div>
        </>
      )}
    </Sheet>
  );
}
