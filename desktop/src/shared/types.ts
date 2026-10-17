// Types shared by the main process, preload and renderer.

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'key' | 'password';
  workdir: string; // default directory for new projects, e.g. ~/code
}

export interface ServerSecret {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export type ConnState =
  | { state: 'idle' }
  | { state: 'connecting'; serverId: string }
  | { state: 'connected'; serverId: string; latencyMs?: number }
  | { state: 'error'; serverId: string; message: string };

export interface Doctor {
  node: string | null;
  tmux: string | null;
  git: string | null;
  claude: string | null;
  loggedIn: boolean;
  rccHome?: string;
  xvnc?: boolean;
  windowManager?: boolean;
  websockify?: boolean;
  chromium?: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  loginUrl?: string | null;
  codeSent?: boolean;
  [k: string]: unknown;
}

export interface Account {
  id: string;
  name: string;
  active: boolean;
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  org?: string | null;
  limitedUntil: number | null; // epoch seconds
  limitType: string | null;
  usage: { fiveHour: { utilization: number; resetsAt: string | null } | null; sevenDay: { utilization: number; resetsAt: string | null } | null } | null;
}

export interface HistorySession {
  id: string; // Claude Code session id
  title: string;
  branch: string | null;
  updatedAt: string;
}

export interface Project {
  cwd: string;
  name: string;
  exists: boolean;
  gitBranch: string | null;
  updatedAt?: string;
  sessions: HistorySession[];
}

export interface LiveSession {
  sid: string; // rcc session id
  cwd: string;
  title: string | null;
  status: 'starting' | 'running' | 'exited' | 'stopped' | 'lost';
  busy: boolean;
  model: string | null;
  resolvedModel?: string;
  effort: string | null;
  claudeSessionId: string | null;
  worktree: string | null;
  repo?: string | null;
  resume?: string | null;
  account?: string;
  limit?: { account: string; resetsAt: number | null; type: string | null } | null;
  createdAt?: string;
  updatedAt: string;
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  resume?: string;
  worktree?: string;
  base?: string;
  title?: string;
  mkdir?: boolean;
  account?: string;
  simple?: boolean;
}

export interface Prefs {
  model: string; // alias or '' for default
  effort: string;
  permissionMode: string;
  extraProjects: Record<string, string[]>; // serverId -> cwds added by hand
  hiddenProjects: Record<string, string[]>; // serverId -> cwds removed from the sidebar
  lastServerId?: string;
  theme: 'system' | 'light' | 'dark';
  autoSwitch: boolean; // switch account automatically when one runs out of quota
  resendOnSwitch: boolean;
  keepBrowser: boolean; // keep an account's VPS browser running after its window closes
  fontSize: number; // px, chat text
  density: 'comfortable' | 'compact';
  relayOnStart?: boolean; // start the LAN relay for the phone when the app connects
  updateUrl: string; // JSON manifest: {"version":"x.y.z","notes":"...","url":"..."}
  lastUpdateCheck?: number;
  simple: boolean; // plain-language mode for people who don't read code
}

export interface MobileDevice { id: string; name: string; createdAt: number | string; lastSeen: number; via: string }
export interface MobileStatus {
  running: boolean; port: number; url: string | null; web: boolean; version: string; devices: MobileDevice[];
  tailscale: { installed: boolean; state?: string; dnsName?: string | null; serving?: boolean; loginUrl?: string | null; enableUrl?: string | null; url?: string | null };
}
export interface RelayStatus { running: boolean; port: number; urls: string[] }

export interface OutFile { name: string; mime: string; path?: string; data?: ArrayBuffer; size?: number }
export interface DeskOpen { wsUrl: string; downloads: string; loginUrl: string | null }
export interface DeskPage { id: string; url: string; title: string }
export interface DeskDownloads { dir: string; files: { name: string; path: string; size: number; mtime: number }[]; partial: number }
export interface UpdateInfo { current: string; latest: string | null; notes?: string; url?: string; error?: string }

export type EnvLog = Record<string, unknown> & { type: string };

export interface SessionEventMsg {
  sid: string;
  events: any[];
}

export interface RcApi {
  servers: {
    list(): Promise<ServerConfig[]>;
    save(cfg: ServerConfig, secret?: ServerSecret): Promise<ServerConfig>;
    remove(id: string): Promise<void>;
    hasSecret(id: string): Promise<boolean>;
    pickKeyFile(): Promise<string | null>;
  };
  conn: {
    connect(id: string): Promise<ConnState>;
    disconnect(): Promise<void>;
    state(): Promise<ConnState>;
  };
  env: {
    doctor(): Promise<Doctor>;
    install(opts: { cjkFonts?: boolean }): Promise<{ ok: boolean }>;
  };
  claude: {
    projects(): Promise<Project[]>;
    live(): Promise<LiveSession[]>;
    history(id: string): Promise<any[]>;
    start(o: StartOptions): Promise<{ sid: string; cwd: string }>;
    send(sid: string, text: string, files?: OutFile[]): Promise<void>;
    subscribe(sid: string): Promise<void>;
    unsubscribe(sid: string): Promise<void>;
    answer(sid: string, req: string, decision: 'allow' | 'deny', message?: string, answers?: Record<string, string>): Promise<void>;
    interrupt(sid: string): Promise<void>;
    stop(sid: string): Promise<void>;
    restore(sid: string, checkpoint: string): Promise<void>;
    preview(sid: string, page?: string): Promise<void>;
  };
  auth: {
    status(account?: string): Promise<AuthStatus>;
    loginCode(code?: string): Promise<void>;
    loginStop(): Promise<void>;
    logout(account?: string): Promise<void>;
  };
  web: { open(account: string, url?: string): Promise<void> };
  desk: {
    open(account: string, o?: { w?: number; h?: number; scale?: number; url?: string; login?: boolean }): Promise<DeskOpen>;
    release(account: string): Promise<void>;
    pages(account: string): Promise<DeskPage[]>;
    navigate(account: string, url: string): Promise<void>;
    history(account: string, dir: -1 | 1): Promise<void>;
    reload(account: string): Promise<void>;
    newTab(account: string, url?: string): Promise<void>;
    activate(account: string, id: string): Promise<void>;
    closeTab(account: string, id: string): Promise<void>;
    insertText(account: string, text: string): Promise<void>;
    upload(account: string, files?: OutFile[]): Promise<{ count: number }>;
    downloads(account: string): Promise<DeskDownloads>;
    saveDownload(remotePath: string): Promise<string | null>;
  };
  clip: { write(text: string): Promise<void>; read(): Promise<{ text: string; hasImage: boolean }> };
  app: { version(): Promise<string>; checkUpdate(force?: boolean): Promise<UpdateInfo>; openExternal(url: string): Promise<void> };
  pathForFile(f: File): string;
  accounts: {
    list(usage?: boolean): Promise<{ active: string; accounts: Account[] }>;
    add(name: string): Promise<{ id: string }>;
    rename(id: string, name: string): Promise<void>;
    use(id: string): Promise<void>;
    order(ids: string[]): Promise<void>;
    remove(id: string): Promise<void>;
    clearLimit(id: string): Promise<void>;
  };
  mobile: {
    status(): Promise<MobileStatus>;
    enable(): Promise<MobileStatus>;
    disable(): Promise<MobileStatus>;
    tailscale(): Promise<MobileStatus['tailscale'] & { step: string; detail?: string }>;
    pair(base?: string): Promise<{ code: string; expiresAt: number; url: string | null; base: string | null }>;
    revoke(id: string): Promise<void>;
    setUrl(url: string): Promise<void>;
    relay(on: boolean): Promise<RelayStatus>;
    relayStatus(): Promise<RelayStatus>;
    qr(text: string): Promise<string>;
  };
  prefs: {
    get(): Promise<Prefs>;
    set(p: Partial<Prefs>): Promise<Prefs>;
  };
  platform: string;
  on(channel: 'conn' | 'env-log' | 'session-events' | 'web-open' | 'menu', cb: (data: any) => void): () => void;
}
