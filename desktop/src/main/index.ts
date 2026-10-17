import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Remote } from './remote';
import { Desk } from './desk';
import { Relay } from './relay';
import QRCode from 'qrcode';
import os from 'node:os';
import { prefs, secrets, servers } from './store';
import type { OutFile, ServerConfig, ServerSecret, UpdateInfo } from '../shared/types';

// renamed from "Remote Claude" in 0.4.2: keep using the old data folder so saved servers and keys carry over
app.setPath('userData', path.join(app.getPath('appData'), 'Remote Claude'));

let win: BrowserWindow | null = null;
const emit = (channel: string, data: unknown) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, data); };
const remote = new Remote(emit);

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    title: 'Outpost',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

// Claude web (or any page) in an account's VPS browser: one window, one tab per account
let webWin: BrowserWindow | null = null;
function openWeb(account: string, url?: string) {
  if (webWin) {
    webWin.webContents.send('web-open', { account, url });
    if (webWin.isMinimized()) webWin.restore();
    webWin.show(); webWin.focus();
    return;
  }
  const isMac = process.platform === 'darwin';
  webWin = new BrowserWindow({
    width: 1440, height: 940, minWidth: 820, minHeight: 540, title: 'Claude 网页版',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 14 }, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  webWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: `web=${encodeURIComponent(account)}${url ? `&url=${encodeURIComponent(url)}` : ''}` });
  webWin.on('closed', () => { webWin = null; });
}
// project preview: a plain window on the tunnelled preview server; the page can't reach the app
let previewWin: BrowserWindow | null = null;
function openPreview(url: string) {
  if (!previewWin || previewWin.isDestroyed()) {
    previewWin = new BrowserWindow({ width: 1200, height: 860, minWidth: 360, minHeight: 400, title: '预览', autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    previewWin.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
    previewWin.on('closed', () => { previewWin = null; });
  }
  previewWin.loadURL(url);
  previewWin.show(); previewWin.focus();
}
const desk = new Desk(remote);
const relay = new Relay(remote);
remote.onReconnect = () => { desk.reset(); relay.reset(); };
const tmpFromData = (name: string, data: ArrayBuffer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const f = path.join(dir, path.basename(name || 'file').replace(/[\\/:*?"<>|]/g, '_'));
  fs.writeFileSync(f, Buffer.from(data));
  return f;
};

// update check: a JSON manifest {version, notes, url} or a GitHub "releases/latest" API URL
const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(force: boolean): Promise<UpdateInfo> {
  const current = app.getVersion();
  const p = prefs.get();
  if (!p.updateUrl) return { current, latest: null, error: '还没设置更新地址' };
  if (!force && p.lastUpdateCheck && Date.now() - p.lastUpdateCheck < 6 * 3600e3) return { current, latest: null };
  try {
    const r = await fetch(p.updateUrl, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const latest = String(j.version || j.tag_name || '').replace(/^v/, '');
    prefs.set({ lastUpdateCheck: Date.now() });
    if (!latest) throw new Error('更新信息里没有版本号');
    return { current, latest: newer(latest, current) ? latest : null, notes: j.notes || j.body || '', url: j.url || j.html_url || p.updateUrl };
  } catch (e: any) { return { current, latest: null, error: `检查更新失败：${e?.message || e}` }; }
}

// every handler returns { ok, data } or { ok:false, error } so errors reach the UI as text
const handle = (ch: string, fn: (...a: any[]) => any) =>
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, data: await fn(...a) }; } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  });

handle('servers:list', () => servers.list());
handle('servers:save', (cfg: ServerConfig, secret?: ServerSecret) => {
  if (secret && (secret.privateKey || secret.password)) secrets.set(cfg.id, secret);
  return servers.save(cfg);
});
handle('servers:remove', (id: string) => { if (remote.state.state !== 'idle' && 'serverId' in remote.state && remote.state.serverId === id) remote.disconnect(); servers.remove(id); });
handle('servers:hasSecret', (id: string) => !!secrets.get(id));
handle('servers:pickKeyFile', async () => {
  const r = await dialog.showOpenDialog(win!, { title: '选择私钥', properties: ['openFile', 'showHiddenFiles'], defaultPath: path.join(app.getPath('home'), '.ssh') });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

handle('conn:connect', async (id: string) => {
  const s = await remote.connect(id); prefs.set({ lastServerId: id });
  if (prefs.get().relayOnStart && !relay.running) relay.start().catch(() => {});
  return s;
});
handle('conn:disconnect', () => remote.disconnect());
handle('conn:state', () => remote.state);

handle('env:doctor', () => remote.doctor());
handle('env:install', (o: { cjkFonts?: boolean }) => remote.install(o || {}));

handle('claude:projects', () => remote.projects());
handle('claude:live', () => remote.live());
handle('claude:history', (id: string) => remote.history(id));
handle('claude:start', (o) => remote.start(o));
handle('claude:send', async (sid: string, text: string, files?: OutFile[]) => {
  const tmp: string[] = [];
  const list = (files || []).map((f) => { const local = f.path || tmpFromData(f.name, f.data!); if (!f.path) tmp.push(local); return { local, name: f.name, mime: f.mime }; });
  try { await remote.send(sid, text, list); } finally { for (const t of tmp) fs.rm(path.dirname(t), { recursive: true, force: true }, () => {}); }
});
handle('claude:subscribe', (sid: string) => remote.subscribe(sid));
handle('claude:unsubscribe', (sid: string) => remote.unsubscribe(sid));
handle('claude:answer', (sid: string, req: string, d: string, m?: string) => remote.answer(sid, req, d, m));
handle('claude:interrupt', (sid: string) => remote.interrupt(sid));
handle('claude:stop', (sid: string) => remote.stop(sid));
handle('claude:restore', (sid: string, c: string) => remote.restore(sid, c));
handle('claude:preview', async (sid: string, page?: string) => openPreview(await remote.previewUrl(sid, page || '')));

handle('mobile:status', () => remote.mobileStatus());
handle('mobile:enable', () => remote.mobileEnable());
handle('mobile:disable', () => remote.mobileDisable());
handle('mobile:tailscale', () => remote.mobileTailscale());
handle('mobile:pair', (b?: string) => remote.mobilePair(b));
handle('mobile:revoke', (id: string) => remote.mobileRevoke(id));
handle('mobile:setUrl', (u: string) => remote.mobileSetUrl(u));
handle('mobile:relay', async (on: boolean) => { prefs.set({ relayOnStart: on }); if (!on) return relay.stop(); await remote.mobileEnable(); return relay.start(); });
handle('mobile:relayStatus', () => relay.status());
handle('mobile:qr', (t: string) => QRCode.toDataURL(t, { margin: 1, width: 440, errorCorrectionLevel: 'M', color: { dark: '#18181b', light: '#ffffff' } }));

handle('auth:status', (a?: string) => remote.authStatus(a));
handle('auth:loginCode', (code?: string) => remote.loginCode(code));
handle('auth:loginStop', () => remote.loginStop());
handle('auth:logout', (a?: string) => remote.logout(a));
handle('web:open', (a: string, u?: string) => openWeb(a, u));
ipcMain.handle('desk:open', async (e, a: string, o) => { try { return { ok: true, data: await desk.open(e.sender, a, o || {}) }; } catch (err: any) { return { ok: false, error: String(err?.message || err) }; } });
ipcMain.handle('desk:release', (e, a: string) => { desk.release(e.sender, a); return { ok: true }; });
handle('desk:pages', (a: string) => desk.pages(a));
handle('desk:navigate', (a: string, u: string) => desk.navigate(a, u));
handle('desk:history', (a: string, d: -1 | 1) => desk.history(a, d));
handle('desk:reload', (a: string) => desk.reload(a));
handle('desk:newTab', (a: string, u?: string) => desk.newTab(a, u));
handle('desk:activate', (a: string, id: string) => desk.activate(a, id));
handle('desk:closeTab', (a: string, id: string) => desk.closeTab(a, id));
handle('desk:insertText', (a: string, t: string) => desk.insertText(a, t));
handle('desk:upload', async (a: string, files?: OutFile[]) => {
  let paths = (files || []).map((f) => f.path || tmpFromData(f.name, f.data!));
  if (!files?.length) {
    const r = await dialog.showOpenDialog(webWin || win!, { title: '选择要上传到网页的文件', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { count: 0 };
    paths = r.filePaths;
  }
  try { return await desk.uploadToPage(a, paths); }
  finally { for (const f of files || []) if (!f.path) { const i = (files || []).indexOf(f); fs.rm(path.dirname(paths[i]), { recursive: true, force: true }, () => {}); } }
});
handle('desk:downloads', (a: string) => desk.downloads(a));
ipcMain.handle('desk:saveDownload', async (e, p: string) => { try { return { ok: true, data: await desk.saveDownload(BrowserWindow.fromWebContents(e.sender), p) }; } catch (err: any) { return { ok: false, error: String(err?.message || err) }; } });
handle('clip:write', (t: string) => desk.writeClipboard(t));
handle('clip:read', () => desk.readClipboard());
handle('app:version', () => app.getVersion());
handle('app:checkUpdate', (force?: boolean) => checkUpdate(!!force));
handle('app:openExternal', (u: string) => { if (/^https?:/.test(u)) shell.openExternal(u); });
handle('accounts:list', (u?: boolean) => remote.accounts(u));
handle('accounts:add', (n: string) => remote.accountAdd(n));
handle('accounts:rename', (id: string, n: string) => remote.accountCmd('account-rename', id, n));
handle('accounts:use', (id: string) => remote.accountCmd('account-use', id));
handle('accounts:order', (ids: string[]) => remote.accountCmd('account-order', ids.join(',')));
handle('accounts:remove', (id: string) => remote.accountCmd('account-remove', id));
handle('accounts:clearLimit', (id: string) => remote.accountCmd('account-clear-limit', id));

handle('prefs:get', () => prefs.get());
handle('prefs:set', (p) => prefs.set(p));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { remote.disconnect(); if (process.platform !== 'darwin') app.quit(); });
