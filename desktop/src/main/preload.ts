import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { RcApi } from '../shared/types';

const call = async (ch: string, ...a: unknown[]) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

const api: RcApi = {
  servers: {
    list: () => call('servers:list'),
    save: (c, s) => call('servers:save', c, s),
    remove: (id) => call('servers:remove', id),
    hasSecret: (id) => call('servers:hasSecret', id),
    pickKeyFile: () => call('servers:pickKeyFile'),
  },
  conn: {
    connect: (id) => call('conn:connect', id),
    disconnect: () => call('conn:disconnect'),
    state: () => call('conn:state'),
  },
  env: {
    doctor: () => call('env:doctor'),
    install: (o) => call('env:install', o),
  },
  claude: {
    projects: () => call('claude:projects'),
    live: () => call('claude:live'),
    history: (id) => call('claude:history', id),
    start: (o) => call('claude:start', o),
    send: (sid, t, f) => call('claude:send', sid, t, f),
    subscribe: (sid) => call('claude:subscribe', sid),
    unsubscribe: (sid) => call('claude:unsubscribe', sid),
    answer: (sid, r, d, m) => call('claude:answer', sid, r, d, m),
    interrupt: (sid) => call('claude:interrupt', sid),
    stop: (sid) => call('claude:stop', sid),
    restore: (sid, c) => call('claude:restore', sid, c),
    preview: (sid, p) => call('claude:preview', sid, p),
  },
  auth: {
    status: (a) => call('auth:status', a),
    loginCode: (code) => call('auth:loginCode', code),
    loginStop: () => call('auth:loginStop'),
    logout: (a) => call('auth:logout', a),
  },
  web: { open: (a, u) => call('web:open', a, u) },
  desk: {
    open: (a, o) => call('desk:open', a, o),
    release: (a) => call('desk:release', a),
    pages: (a) => call('desk:pages', a),
    navigate: (a, u) => call('desk:navigate', a, u),
    history: (a, d) => call('desk:history', a, d),
    reload: (a) => call('desk:reload', a),
    newTab: (a, u) => call('desk:newTab', a, u),
    activate: (a, id) => call('desk:activate', a, id),
    closeTab: (a, id) => call('desk:closeTab', a, id),
    insertText: (a, t) => call('desk:insertText', a, t),
    upload: (a, f) => call('desk:upload', a, f),
    downloads: (a) => call('desk:downloads', a),
    saveDownload: (p) => call('desk:saveDownload', p),
  },
  clip: { write: (t) => call('clip:write', t), read: () => call('clip:read') },
  app: { version: () => call('app:version'), checkUpdate: (f) => call('app:checkUpdate', f), openExternal: (u) => call('app:openExternal', u) },
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  accounts: {
    list: (u) => call('accounts:list', u),
    add: (n) => call('accounts:add', n),
    rename: (id, n) => call('accounts:rename', id, n),
    use: (id) => call('accounts:use', id),
    order: (ids) => call('accounts:order', ids),
    remove: (id) => call('accounts:remove', id),
    clearLimit: (id) => call('accounts:clearLimit', id),
  },
  mobile: {
    status: () => call('mobile:status'),
    enable: () => call('mobile:enable'),
    disable: () => call('mobile:disable'),
    tailscale: () => call('mobile:tailscale'),
    pair: (b) => call('mobile:pair', b),
    revoke: (id) => call('mobile:revoke', id),
    setUrl: (u) => call('mobile:setUrl', u),
    relay: (on) => call('mobile:relay', on),
    relayStatus: () => call('mobile:relayStatus'),
    qr: (t) => call('mobile:qr', t),
  },
  prefs: {
    get: () => call('prefs:get'),
    set: (p) => call('prefs:set', p),
  },
  platform: process.platform,
  on(channel, cb) {
    const fn = (_e: unknown, d: unknown) => cb(d);
    ipcRenderer.on(channel, fn);
    return () => { ipcRenderer.removeListener(channel, fn); };
  },
};

contextBridge.exposeInMainWorld('rc', api);
