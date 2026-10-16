// Talks to rcc serve on the VPS (directly over HTTPS, or through the desktop's LAN relay).
// Same origin always: the page is served by whatever the phone connected to.

const TOKEN_KEY = 'rcc.token';
export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set(t: string | null) {
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
    navigator.serviceWorker?.controller?.postMessage({ type: 'token', token: t });
    navigator.serviceWorker?.ready.then((r) => r.active?.postMessage({ type: 'token', token: t })).catch(() => {});
  },
};

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(path: string, body?: unknown, opts: { method?: string; timeout?: number } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 30000);
  try {
    const r = await fetch(path, {
      method: opts.method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = { error: text }; }
    if (r.status === 401 && path !== '/api/pair') onUnauthorized?.();
    if (!r.ok) throw new ApiError(j?.error || `请求失败（${r.status}）`, r.status);
    return j as T;
  } catch (e: any) {
    if (e.name === 'AbortError') throw new ApiError('连接超时', 0);
    if (e instanceof ApiError) throw e;
    throw new ApiError('连不上服务器', 0);
  } finally { clearTimeout(timer); }
}

/** EventSource that reconnects by itself and resumes from the last byte offset. */
export function stream(sid: string, from: number, onEvents: (events: any[], offset: number) => void, onState?: (ok: boolean) => void) {
  let es: EventSource | null = null, dead = false, offset = from, retry: any;
  const open = () => {
    if (dead) return;
    es = new EventSource(`/api/events?sid=${encodeURIComponent(sid)}&from=${offset}&t=${encodeURIComponent(auth.token || '')}`);
    es.onopen = () => onState?.(true);
    es.onmessage = (m) => { try { const d = JSON.parse(m.data); offset = d.offset; onEvents(d.events, d.offset); } catch { /* ignore */ } };
    es.onerror = () => { onState?.(false); es?.close(); clearTimeout(retry); retry = setTimeout(open, 2000); };
  };
  open();
  const vis = () => { if (document.visibilityState === 'visible' && (!es || es.readyState === 2)) { clearTimeout(retry); open(); } };
  document.addEventListener('visibilitychange', vis);
  return () => { dead = true; clearTimeout(retry); es?.close(); document.removeEventListener('visibilitychange', vis); };
}

export function feed(onSessions: (list: LiveSession[]) => void, onState?: (ok: boolean) => void) {
  let es: EventSource | null = null, dead = false, retry: any;
  const open = () => {
    if (dead) return;
    es = new EventSource(`/api/feed?t=${encodeURIComponent(auth.token || '')}`);
    es.onopen = () => onState?.(true);
    es.addEventListener('sessions', (m: MessageEvent) => { try { onSessions(JSON.parse(m.data)); } catch { /* ignore */ } });
    es.onerror = () => { onState?.(false); es?.close(); clearTimeout(retry); retry = setTimeout(open, 3000); };
  };
  open();
  const vis = () => { if (document.visibilityState === 'visible' && (!es || es.readyState === 2)) { clearTimeout(retry); open(); } };
  document.addEventListener('visibilitychange', vis);
  return () => { dead = true; clearTimeout(retry); es?.close(); document.removeEventListener('visibilitychange', vis); };
}

export interface LiveSession {
  sid: string; cwd: string; title: string | null; status: string; busy: boolean; model: string | null; resolvedModel?: string | null;
  effort: string | null; claudeSessionId: string | null; worktree: string | null; repo: string | null; account: string;
  resume: string | null; createdAt: string; updatedAt: string; bytes: number; firstText: string | null; lastText: string | null; lastError?: boolean;
  permissionMode?: string; pending: { req: string; tool: string; text: string }[];
}
export interface Project { cwd: string; name: string; exists: boolean; gitBranch: string | null; updatedAt: string; sessions: { id: string; title: string; branch: string | null; updatedAt: string }[] }
export interface Account {
  id: string; name: string; active: boolean; loggedIn: boolean; email: string | null; plan: string | null; limitedUntil: number | null;
  usage: { fiveHour: { utilization: number; resetsAt: string | null } | null } | null;
}
export interface Me { device: { id: string; name: string }; server: string; version: string; url: string | null; pushKey: string; node: string }
