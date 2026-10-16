// Turns Claude Code output (live stream-json and saved transcript .jsonl share a shape)
// plus rcc's own events into a flat list of things to draw.

export type Item =
  | { kind: 'user'; key: string; text: string; files?: { name: string; image: boolean }[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input: any; result?: string; isError?: boolean; done: boolean }
  | { kind: 'perm'; key: string; req: string; tool: string; input: any; outcome?: 'allow' | 'deny' }
  | { kind: 'note'; key: string; text: string; error?: boolean }
  | { kind: 'limit'; key: string; account: string; resetsAt: number | null; switchedTo?: string; auto?: boolean };

export interface Transcript {
  items: Item[];
  busy: boolean;
  resolvedModel?: string;
  claudeSessionId?: string;
  exited: boolean;
  lastError?: string;
  limit?: { account: string; resetsAt: number | null; switchedTo?: string };
}

const HIDDEN_USER = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder)>|^Caveat: /;

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
}
function resultText(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[图片]' : '')).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

export function buildTranscript(events: any[]): Transcript {
  const t: Transcript = { items: [], busy: false, exited: false };
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const perms = new Map<string, Extract<Item, { kind: 'perm' }>>();
  const seenUuid = new Set<string>();
  const historyUserTexts = new Map<string, number>(); // dedupe rcc_user against a loaded transcript
  let n = 0;
  const k = () => `i${n++}`;
  let limitOpen = false; // a quota card already explains the error lines that follow it

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.uuid) { if (seenUuid.has(ev.uuid)) continue; seenUuid.add(ev.uuid); }
    switch (ev.type) {
      case 'rcc_user': {
        const ut = String(ev.text || '').trim();
        const c = historyUserTexts.get(ut) || 0;
        if (c > 0) { historyUserTexts.set(ut, c - 1); break; }
        const files = Array.isArray(ev.attachments) ? ev.attachments.map((f: any) => ({ name: String(f.name || ''), image: /^image\//.test(f.mime || '') })) : undefined;
        t.items.push({ kind: 'user', key: k(), text: ut, files: files?.length ? files : undefined });
        t.busy = true; t.lastError = undefined; limitOpen = false;
        break;
      }
      case 'user': {
        if (ev.isMeta || ev.isCompactSummary) break;
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_result') {
              const tool = tools.get(b.tool_use_id);
              if (tool) { tool.result = resultText(b.content); tool.isError = !!b.is_error; tool.done = true; }
            }
          }
        }
        let text = textOf(content).trim();
        const isResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
        const imgs = Array.isArray(content) && !isResult ? content.filter((b: any) => b?.type === 'image').length : 0;
        if ((text || imgs) && !HIDDEN_USER.test(text) && !isResult) {
          // files sent from the desktop: images arrive as image blocks, other files as a list of VPS paths
          const files: { name: string; image: boolean }[] = Array.from({ length: imgs }, (_, i) => ({ name: `图片 ${i + 1}`, image: true }));
          const m = text.match(/(?:^|\n\n)附件（已上传到 VPS）：\n((?:- .+\n?)+)$/);
          if (m) { for (const l of m[1].trim().split('\n')) files.push({ name: l.replace(/^- /, '').split('/').pop()!.replace(/^[a-z0-9]{6,10}-/, ''), image: false }); text = text.slice(0, m.index).trim(); }
          t.items.push({ kind: 'user', key: k(), text, files: files.length ? files : undefined });
          historyUserTexts.set(text, (historyUserTexts.get(text) || 0) + 1);
        }
        break;
      }
      case 'assistant': {
        if (limitOpen && (ev.error || ev.isApiErrorMessage)) break;
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b?.type === 'text' && b.text?.trim()) t.items.push({ kind: 'text', key: k(), text: b.text });
          else if (b?.type === 'thinking' && b.thinking?.trim()) t.items.push({ kind: 'thinking', key: k(), text: b.thinking });
          else if (b?.type === 'tool_use') {
            const item = { kind: 'tool' as const, key: k(), id: b.id, name: b.name, input: b.input || {}, done: false };
            tools.set(b.id, item); t.items.push(item);
          }
        }
        break;
      }
      case 'system':
        if (ev.subtype === 'init') { t.resolvedModel = ev.model; t.claudeSessionId = ev.session_id; }
        else if (ev.subtype === 'compact_boundary') t.items.push({ kind: 'note', key: k(), text: '上下文已压缩' });
        break;
      case 'result':
        t.busy = false;
        if (ev.session_id) t.claudeSessionId = ev.session_id;
        if ((ev.is_error || (ev.subtype && ev.subtype !== 'success')) && !limitOpen) {
          const msg = typeof ev.result === 'string' && ev.result ? ev.result : `出错了（${ev.subtype}）`;
          t.lastError = msg;
          t.items.push({ kind: 'note', key: k(), text: msg, error: true });
        }
        for (const tool of tools.values()) tool.done = true;
        break;
      case 'rcc_permission_request': {
        const item = { kind: 'perm' as const, key: k(), req: ev.req, tool: ev.tool_name, input: ev.input };
        perms.set(ev.req, item); t.items.push(item);
        break;
      }
      case 'rcc_permission_result': {
        const p = perms.get(ev.req);
        if (p) p.outcome = ev.behavior === 'allow' ? 'allow' : 'deny';
        break;
      }
      case 'rcc_started':
        t.exited = false;
        break;
      case 'rcc_limit': {
        const item = { kind: 'limit' as const, key: k(), account: ev.account, resetsAt: ev.resetsAt ?? null };
        t.items.push(item); t.limit = item; t.busy = false; limitOpen = true;
        break;
      }
      case 'rcc_switch': {
        // client-side marker: the conversation moved to another account
        const last = [...t.items].reverse().find((x) => x.kind === 'limit') as Extract<Item, { kind: 'limit' }> | undefined;
        if (last && !last.switchedTo) { last.switchedTo = ev.to; last.auto = !!ev.auto; }
        else t.items.push({ kind: 'note', key: k(), text: `切换到账号「${ev.toName || ev.to}」` });
        if (t.limit) t.limit = { ...t.limit, switchedTo: ev.to };
        break;
      }
      case 'rcc_interrupt':
        t.items.push({ kind: 'note', key: k(), text: '已中断' });
        break;
      case 'rcc_exit':
        t.busy = false; t.exited = true;
        for (const tool of tools.values()) tool.done = true;
        break;
      case 'rcc_error':
        t.busy = false;
        t.items.push({ kind: 'note', key: k(), text: `启动失败：${ev.message}`, error: true });
        break;
    }
  }
  return t;
}

// ---------- helpers for tool cards ----------
export function toolTitle(name: string, input: any): { verb: string; target: string } {
  const short = (p?: string) => (p || '').replace(/^\/(root|home\/[^/]+)\//, '~/');
  switch (name) {
    case 'Edit': case 'MultiEdit': return { verb: '编辑', target: short(input.file_path) };
    case 'Write': return { verb: '写入', target: short(input.file_path) };
    case 'Read': return { verb: '读取', target: short(input.file_path) };
    case 'Bash': return { verb: '运行', target: input.command || '' };
    case 'Grep': return { verb: '搜索', target: input.pattern || '' };
    case 'Glob': return { verb: '查找', target: input.pattern || '' };
    case 'WebFetch': return { verb: '打开网页', target: input.url || '' };
    case 'WebSearch': return { verb: '搜索网页', target: input.query || '' };
    case 'Task': case 'Agent': return { verb: '子任务', target: input.description || '' };
    case 'TodoWrite': return { verb: '更新待办', target: '' };
    default: return { verb: name.replace(/^mcp__/, ''), target: '' };
  }
}

export interface DiffLine { t: ' ' | '+' | '-'; s: string }
export function toolDiff(name: string, input: any): DiffLine[] | null {
  const lines = (s: string) => (s ?? '').split('\n');
  if (name === 'Edit') return [...lines(input.old_string).map((s) => ({ t: '-' as const, s })), ...lines(input.new_string).map((s) => ({ t: '+' as const, s }))];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const out: DiffLine[] = [];
    input.edits.forEach((e: any, i: number) => {
      if (i) out.push({ t: ' ', s: '…' });
      out.push(...lines(e.old_string).map((s) => ({ t: '-' as const, s })), ...lines(e.new_string).map((s) => ({ t: '+' as const, s })));
    });
    return out;
  }
  if (name === 'Write') return lines(input.content).map((s) => ({ t: '+' as const, s }));
  return null;
}
