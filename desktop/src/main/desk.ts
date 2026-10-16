// Per-account browsers on the VPS: the screen arrives over a VNC websocket (drawn by the renderer),
// and the browser itself is driven over the Chrome DevTools Protocol through an SSH tunnel.
import { app, clipboard, dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Remote } from './remote';
import { prefs } from './store';
import type { DeskDownloads, DeskOpen, DeskPage } from '../shared/types';

interface Sock { ws: WebSocket; seq: number; pending: Map<number, { res: (v: any) => void; rej: (e: Error) => void }>; ready: Promise<void> }

export class Desk {
  private socks = new Map<string, Sock>();          // key: account + targetId
  private refs = new Map<string, Map<number, number>>(); // account -> webContents id -> count
  private stopTimers = new Map<string, NodeJS.Timeout>();

  constructor(private remote: Remote) {}

  reset() { for (const s of this.socks.values()) try { s.ws.close(); } catch { /* ignore */ } this.socks.clear(); }

  async open(wc: WebContents, account: string, o: { w?: number; h?: number; scale?: number; url?: string; login?: boolean }): Promise<DeskOpen> {
    clearTimeout(this.stopTimers.get(account));
    const r = await this.remote.deskOpen(account, o);
    const byWc = this.refs.get(account) || new Map<number, number>();
    byWc.set(wc.id, (byWc.get(wc.id) || 0) + 1);
    this.refs.set(account, byWc);
    if (!(wc as any).__deskHooked) {
      (wc as any).__deskHooked = true;
      wc.once('destroyed', () => { for (const acc of [...this.refs.keys()]) this.dropWc(acc, wc.id); });
    }
    return r;
  }

  release(wc: WebContents, account: string) {
    const byWc = this.refs.get(account);
    if (!byWc) return;
    const n = (byWc.get(wc.id) || 1) - 1;
    if (n <= 0) byWc.delete(wc.id); else byWc.set(wc.id, n);
    this.maybeStop(account);
  }

  private dropWc(account: string, wcId: number) {
    const byWc = this.refs.get(account);
    if (!byWc) return;
    byWc.delete(wcId);
    this.maybeStop(account);
  }

  // no window shows this account any more: stop its VPS browser unless the user wants it kept
  private maybeStop(account: string) {
    const byWc = this.refs.get(account);
    if (byWc && byWc.size) return;
    this.refs.delete(account);
    if (prefs.get().keepBrowser) return;
    clearTimeout(this.stopTimers.get(account));
    this.stopTimers.set(account, setTimeout(() => {
      if (this.refs.get(account)?.size) return;
      for (const k of [...this.socks.keys()]) if (k.startsWith(account + '\0')) { try { this.socks.get(k)!.ws.close(); } catch { /* ignore */ } this.socks.delete(k); }
      this.remote.deskStop(account).catch(() => { /* connection gone */ });
    }, 4000));
  }

  // ---------- CDP ----------
  private async base(account: string) { return `http://127.0.0.1:${await this.remote.cdpPort(account)}`; }

  async pages(account: string): Promise<DeskPage[]> {
    const r = await fetch(`${await this.base(account)}/json`, { signal: AbortSignal.timeout(4000) });
    const list = (await r.json()) as any[];
    return list.filter((p) => p.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(p.url)).map((p) => ({ id: p.id, url: p.url, title: p.title || p.url }));
  }
  private async active(account: string) {
    const ps = await this.pages(account);
    if (!ps.length) throw new Error('VPS 浏览器里没有打开的页面');
    return ps[0];
  }

  private async sock(account: string, targetId: string): Promise<Sock> {
    const key = account + '\0' + targetId;
    const have = this.socks.get(key);
    if (have && have.ws.readyState <= 1) { await have.ready; return have; }
    const port = await this.remote.cdpPort(account);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const s: Sock = { ws, seq: 0, pending: new Map(), ready: Promise.resolve() };
    s.ready = new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('连不上 VPS 浏览器的调试接口')));
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && s.pending.has(m.id)) {
        const p = s.pending.get(m.id)!; s.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      }
    });
    ws.addEventListener('close', () => { this.socks.delete(key); for (const p of s.pending.values()) p.rej(new Error('调试连接已关闭')); s.pending.clear(); });
    this.socks.set(key, s);
    await s.ready;
    return s;
  }

  async cmd(account: string, method: string, params: Record<string, unknown> = {}, targetId?: string): Promise<any> {
    const id = targetId || (await this.active(account)).id;
    const s = await this.sock(account, id);
    const n = ++s.seq;
    return new Promise((res, rej) => {
      s.pending.set(n, { res, rej });
      s.ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => { if (s.pending.delete(n)) rej(new Error(`${method} 超时`)); }, 15000);
    });
  }

  async navigate(account: string, input: string) {
    let url = input.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = /^[^\s]+\.[^\s]{2,}$/.test(url) && !/\s/.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    await this.cmd(account, 'Page.navigate', { url });
  }
  history = (account: string, dir: -1 | 1) => this.cmd(account, 'Runtime.evaluate', { expression: dir < 0 ? 'history.back()' : 'history.forward()' });
  reload = (account: string) => this.cmd(account, 'Page.reload', {});
  async newTab(account: string, url = 'https://claude.ai/new') { await fetch(`${await this.base(account)}/json/new?${encodeURI(url)}`, { method: 'PUT' }); }
  async activate(account: string, id: string) { await fetch(`${await this.base(account)}/json/activate/${id}`); }
  async closeTab(account: string, id: string) {
    const ps = await this.pages(account);
    if (ps.length <= 1) { await this.newTab(account); }
    await fetch(`${await this.base(account)}/json/close/${id}`);
  }

  // text typed with the local IME or pasted from the local clipboard goes in as real text, any language
  insertText = (account: string, text: string) => this.cmd(account, 'Input.insertText', { text });

  // put local files into the page's file picker (claude.ai's attach button), via the VPS
  async uploadToPage(account: string, localPaths: string[]) {
    if (!localPaths.length) return { count: 0 };
    const dir = await this.remote.uploadDir();
    const remotes: string[] = [];
    for (const lp of localPaths) {
      const rp = `${dir}/${Date.now().toString(36)}-${path.basename(lp).replace(/[^\w.\-\u4e00-\u9fff]/g, '_')}`;
      await this.remote.ssh.putFile(lp, rp);
      remotes.push(rp);
    }
    const page = await this.active(account);
    const doc = await this.cmd(account, 'DOM.getDocument', { depth: -1, pierce: true }, page.id);
    const found = await this.cmd(account, 'DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, page.id);
    const ids: number[] = found.nodeIds || [];
    if (!ids.length) throw new Error('这个页面没有可用的上传入口；文件已传到 VPS：' + remotes.join('，'));
    await this.cmd(account, 'DOM.setFileInputFiles', { files: remotes, nodeId: ids[ids.length - 1] }, page.id);
    return { count: remotes.length };
  }

  downloads = (account: string): Promise<DeskDownloads> => this.remote.deskDownloads(account);
  async saveDownload(win: Electron.BrowserWindow | null, remotePath: string) {
    const name = path.basename(remotePath);
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), name) });
    if (r.canceled || !r.filePath) return null;
    await this.remote.ssh.getFile(remotePath, r.filePath);
    return r.filePath;
  }

  async writeClipboard(text: string) { await clipboard.writeText(text); }
  async readClipboard() { return { text: await clipboard.readText(), hasImage: false }; }
}
