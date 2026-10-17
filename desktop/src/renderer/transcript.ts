// Turns Claude Code output (live stream-json and saved transcript .jsonl share a shape)
// plus rcc's own events into a flat list of things to draw.

export type Item =
  | { kind: 'user'; key: string; text: string; files?: { name: string; image: boolean }[]; checkpoint?: string }
  | { kind: 'changes'; key: string; checkpoint: string; files: { s: string; p: string }[]; total: number; undone?: boolean }
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
        if (c > 0) {
          historyUserTexts.set(ut, c - 1);
          const h = [...t.items].reverse().find((x) => x.kind === 'user' && x.text === ut) as Extract<Item, { kind: 'user' }> | undefined;
          if (h && ev.checkpoint) h.checkpoint = ev.checkpoint;
          break;
        }
        const files = Array.isArray(ev.attachments) ? ev.attachments.map((f: any) => ({ name: String(f.name || ''), image: /^image\//.test(f.mime || '') })) : undefined;
        t.items.push({ kind: 'user', key: k(), text: ut, files: files?.length ? files : undefined, checkpoint: ev.checkpoint || undefined });
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
        let text = textOf(content).trim().replace(/^（提示：用户刚刚把项目文件恢复到了之前的存档[^）]*）\s*/, '');
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
      case 'rcc_changes':
        if (ev.checkpoint && Array.isArray(ev.files) && ev.files.length) t.items.push({ kind: 'changes', key: k(), checkpoint: ev.checkpoint, files: ev.files, total: ev.total || ev.files.length });
        break;
      case 'rcc_restored': {
        // every turn from that checkpoint on is undone
        const at = t.items.findIndex((x) => (x.kind === 'user' || x.kind === 'changes') && x.checkpoint === ev.checkpoint);
        if (at >= 0) for (const x of t.items.slice(at)) if (x.kind === 'changes') x.undone = true;
        const u = t.items.find((x) => x.kind === 'user' && x.checkpoint === ev.checkpoint) as Extract<Item, { kind: 'user' }> | undefined;
        t.items.push({ kind: 'note', key: k(), text: u ? `已恢复到「${u.text.slice(0, 24)}${u.text.length > 24 ? '…' : ''}」之前的样子` : '已恢复到之前的存档' });
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
    case 'mcp__rcc__browser_open': return { verb: '浏览器打开', target: input.url || '' };
    case 'mcp__rcc__browser_click': return { verb: '浏览器点击', target: input.text || (input.id != null ? `#${input.id}` : '') };
    case 'mcp__rcc__browser_type': return { verb: '浏览器输入', target: input.text || '' };
    case 'mcp__rcc__browser_read': return { verb: '读取网页', target: '' };
    case 'mcp__rcc__browser_screenshot': return { verb: '网页截图', target: '' };
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

// ---------- plain-language helpers (for people who don't read code) ----------
const baseName = (p?: string) => (p || '').split('/').pop() || '';
const FRIENDLY_CMD: [RegExp, string][] = [
  [/^\s*(sudo\s+)?rm\s/, '删除文件'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b/, '安装需要的软件包'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\bhttp\.server\b|\bvite\b/, '启动预览服务'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/, '打包项目'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b/, '运行测试'],
  [/^\s*git\s+(push|commit)/, '保存到 Git'],
  [/^\s*(curl|wget)\s/, '从网上下载东西'],
  [/^\s*(mkdir)\s/, '新建文件夹'],
  [/^\s*(mv|cp)\s/, '移动或复制文件'],
  [/^\s*(python3?|node)\s/, '运行一个程序'],
];
/** One human sentence for a permission prompt, plus how careful the user should be. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
export function humanPerm(tool: string, input: any): { text: string; risk: 'low' | 'mid' | 'high' } {
  switch (tool) {
    case 'AskUserQuestion': return { text: '问你一个问题', risk: 'low' };
    case 'ExitPlanMode': return { text: '按方案开始动手', risk: 'low' };
    case 'Read': return { text: `查看文件「${baseName(input?.file_path)}」`, risk: 'low' };
    case 'Glob': case 'Grep': case 'LS': return { text: '在项目里找东西', risk: 'low' };
    case 'Task': case 'Agent': return { text: `派一个助手去${input?.description || '处理子任务'}`, risk: 'low' };
    case 'Skill': return { text: `使用技能「${input?.skill || input?.command || ''}」`, risk: 'low' };
    case 'TodoWrite': return { text: '更新计划清单', risk: 'low' };
    case 'KillShell': case 'KillBash': case 'TaskStop': return { text: '停掉一个后台任务', risk: 'low' };
    case 'BashOutput': case 'TaskOutput': case 'Monitor': return { text: '查看后台任务的输出', risk: 'low' };
    case 'PowerShell': return { text: String(input?.description || '').trim() && CJK.test(input.description) ? input.description : '在服务器上运行一条命令', risk: 'mid' };
    case 'Write': return { text: `新建或覆盖文件「${baseName(input?.file_path)}」`, risk: 'low' };
    case 'Edit': case 'MultiEdit': return { text: `修改文件「${baseName(input?.file_path)}」`, risk: 'low' };
    case 'NotebookEdit': return { text: `修改笔记本「${baseName(input?.notebook_path)}」`, risk: 'low' };
    case 'WebFetch': return { text: `打开网页 ${String(input?.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`, risk: 'low' };
    case 'WebSearch': return { text: `上网搜索「${input?.query || ''}」`, risk: 'low' };
    case 'mcp__rcc__browser_open': return { text: `用服务器浏览器打开 ${String(input?.url || '').replace(/^https?:\/\//, '').slice(0, 50)}`, risk: 'low' };
    case 'mcp__rcc__browser_read': case 'mcp__rcc__browser_screenshot': case 'mcp__rcc__browser_scroll': case 'mcp__rcc__browser_back': return { text: '看一下服务器浏览器里的页面', risk: 'low' };
    case 'mcp__rcc__browser_click': return { text: `在服务器浏览器里点「${input?.text || '一个按钮'}」`, risk: 'mid' };
    case 'mcp__rcc__browser_type': return { text: `在服务器浏览器里输入「${String(input?.text || '').slice(0, 40)}」`, risk: 'mid' };
    case 'Bash': {
      const cmd = String(input?.command || '');
      const desc = String(input?.description || '').trim();
      const hit = FRIENDLY_CMD.find(([re]) => re.test(cmd));
      const high = /(^|\s|;|&&)(sudo\s+)?rm\s+-[a-z]*r|git\s+push\s+.*(-f|--force)|\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd|\bshutdown\b|\breboot\b|curl[^|]*\|\s*(ba)?sh/.test(cmd);
      const mid = /\brm\b|git\s+push|\bsudo\b|\bapt(-get)?\b|\bsystemctl\b|\bdocker\b/.test(cmd);
      // Claude often writes the description in English: only show it when it's in the user's script
      return { text: (CJK.test(desc) && desc) || hit?.[1] || '在服务器上运行一条命令', risk: high ? 'high' : mid ? 'mid' : 'low' };
    }
    default: return { text: `使用工具「${tool.replace(/^mcp__/, '')}」`, risk: 'mid' };
  }
}
/** "新建 2 个、修改 1 个文件" */
export function changeSummary(files: { s: string; p: string }[], total = files.length): string {
  const n = (s: string) => files.filter((f) => f.s === s).length;
  const parts = [n('A') && `新建 ${n('A')} 个`, n('M') && `修改 ${n('M')} 个`, n('D') && `删除 ${n('D')} 个`].filter(Boolean) as string[];
  const more = total > files.length ? `（共 ${total} 个）` : '';
  return parts.length ? `${parts.join('、')}文件${more}` : `改动了 ${total} 个文件`;
}
/** The page to open for a preview, relative to the project folder, or null when nothing previewable changed. */
export function previewTarget(files: { s: string; p: string }[]): string | null {
  const live = files.filter((f) => f.s !== 'D');
  const html = live.filter((f) => /\.html?$/i.test(f.p)).map((f) => f.p);
  const idx = html.find((p) => /(^|\/)index\.html?$/i.test(p));
  if (idx) return idx;
  if (html.length) return html.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (live.some((f) => /\.(css|js|mjs)$/i.test(f.p) && !/(^|\/)(node_modules|scripts?)\//.test(f.p))) return 'index.html';
  return null;
}

// ---------- v0.7: link cards and file cards ----------
/** Up to `max` distinct web links in a message (markdown links and bare URLs), skipping images and code. */
export function extractLinks(text: string, max = 3): string[] {
  const src = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  const out: string[] = [];
  const re = /\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`）】」，。、]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && out.length < max) {
    let u = (m[1] || m[2]).replace(/[.,;:!?*_~]+$/, '');
    if (!m[1]) { const open = (u.match(/\(/g) || []).length, close = (u.match(/\)/g) || []).length; if (close > open) u = u.replace(/\)+$/, ''); }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
export const isLocalUrl = (u: string) => { try { return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i.test(new URL(u).hostname); } catch { return false; } };
/** Files worth a card (documents, images, media, archives) among what a turn created or changed. */
const DOC_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|mov|webm|zip|tar\.gz|epub|txt|md|key|numbers|pages)$/i;
export function docFiles(files: { s: string; p: string }[]): string[] {
  return files.filter((f) => f.s !== 'D' && DOC_RE.test(f.p) && !/(^|\/)(node_modules|\.git|dist|build|public|assets|static|src)\//.test(f.p) && !/^readme\.md$|(^|\/)(CLAUDE|README|CHANGELOG|LICENSE)\.md$/i.test(f.p)).map((f) => f.p).slice(0, 8);
}
export function fileKind(p: string): { label: string; icon: 'image' | 'doc' | 'sheet' | 'slides' | 'pdf' | 'media' | 'zip' | 'text' } {
  const e = (p.split('.').pop() || '').toLowerCase();
  if (/^(png|jpe?g|gif|webp|svg)$/.test(e)) return { label: '图片', icon: 'image' };
  if (e === 'pdf') return { label: 'PDF', icon: 'pdf' };
  if (/^(xlsx?|csv|tsv|numbers)$/.test(e)) return { label: '表格', icon: 'sheet' };
  if (/^(pptx?|key)$/.test(e)) return { label: '演示文稿', icon: 'slides' };
  if (/^(docx?|pages|epub)$/.test(e)) return { label: '文档', icon: 'doc' };
  if (/^(mp3|wav|m4a|mp4|mov|webm)$/.test(e)) return { label: '音视频', icon: 'media' };
  if (/^(zip|gz)$/.test(e)) return { label: '压缩包', icon: 'zip' };
  return { label: '文本', icon: 'text' };
}
export const fixPrompt = (err: string) => `刚才出错了：「${err.slice(0, 600)}」\n请找出原因，用一两句大白话告诉我是怎么回事，然后把它修好。`;
