// Local persistence. Server list and prefs are plain JSON; secrets are encrypted with
// Electron safeStorage (macOS Keychain, Windows DPAPI, libsecret on Linux).
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Prefs, ServerConfig, ServerSecret } from '../shared/types';

const file = (n: string) => path.join(app.getPath('userData'), n);
const readJson = <T>(n: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file(n), 'utf8')) as T; } catch { return fallback; }
};
const writeJson = (n: string, v: unknown, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file(n)), { recursive: true });
  fs.writeFileSync(file(n), JSON.stringify(v, null, 2), { mode });
};

export const servers = {
  list: () => readJson<ServerConfig[]>('servers.json', []),
  save(cfg: ServerConfig) {
    const all = servers.list().filter((s) => s.id !== cfg.id);
    all.push(cfg);
    writeJson('servers.json', all);
    return cfg;
  },
  remove(id: string) {
    writeJson('servers.json', servers.list().filter((s) => s.id !== id));
    secrets.remove(id);
  },
};

export const secrets = {
  available: () => safeStorage.isEncryptionAvailable(),
  get(id: string): ServerSecret | null {
    const all = readJson<Record<string, string>>('secrets.json', {});
    if (!all[id]) return null;
    try {
      if (all[id].startsWith('plain:')) return JSON.parse(Buffer.from(all[id].slice(6), 'base64').toString('utf8'));
      return JSON.parse(safeStorage.decryptString(Buffer.from(all[id], 'base64')));
    } catch { return null; }
  },
  set(id: string, s: ServerSecret) {
    const all = readJson<Record<string, string>>('secrets.json', {});
    if (safeStorage.isEncryptionAvailable()) all[id] = safeStorage.encryptString(JSON.stringify(s)).toString('base64');
    // Linux without a keyring: fall back to a file only this user can read
    else if (process.platform === 'linux') all[id] = 'plain:' + Buffer.from(JSON.stringify(s)).toString('base64');
    else throw new Error('系统钥匙串不可用，无法安全保存凭据');
    writeJson('secrets.json', all, 0o600);
  },
  remove(id: string) {
    const all = readJson<Record<string, string>>('secrets.json', {});
    delete all[id];
    writeJson('secrets.json', all, 0o600);
  },
};

const defaultPrefs: Prefs = { model: 'opus', effort: 'high', permissionMode: 'default', extraProjects: {}, hiddenProjects: {}, theme: 'system', autoSwitch: true, resendOnSwitch: true, keepBrowser: false, fontSize: 14, density: 'comfortable', updateUrl: 'https://api.github.com/repos/kulikulisak/outpost/releases/latest' };
export const prefs = {
  get: (): Prefs => ({ ...defaultPrefs, ...readJson<Partial<Prefs>>('prefs.json', {}) }),
  set(p: Partial<Prefs>): Prefs {
    const next = { ...prefs.get(), ...p };
    writeJson('prefs.json', next);
    return next;
  },
};
