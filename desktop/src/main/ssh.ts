// Thin wrapper over ssh2: exec, streaming exec, SFTP upload and local port forwarding.
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface ExecResult { code: number | null; stdout: string; stderr: string }

export class Ssh extends EventEmitter {
  private client: Client | null = null;
  private servers: net.Server[] = [];
  ready = false;

  connect(cfg: ConnectConfig): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const c = new Client();
      let settled = false;
      c.on('ready', () => { this.ready = true; settled = true; resolve(); })
        .on('error', (e) => { if (!settled) { settled = true; reject(e); } else this.emit('lost', e.message); })
        .on('close', () => { const was = this.ready; this.ready = false; if (was) this.emit('lost', 'connection closed'); })
        .connect({ readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 4, ...cfg });
      this.client = c;
    });
  }

  close() {
    for (const s of this.servers) s.close();
    this.servers = [];
    if (this.client) { this.ready = false; this.client.removeAllListeners('close'); this.client.end(); this.client = null; }
  }

  private get c(): Client {
    if (!this.client || !this.ready) throw new Error('未连接到服务器');
    return this.client;
  }

  exec(cmd: string, stdin?: string, timeoutMs = 120000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.c.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        const out: Buffer[] = [], errb: Buffer[] = [];
        const t = setTimeout(() => { ch.close(); reject(new Error(`命令超时：${cmd.slice(0, 60)}`)); }, timeoutMs);
        ch.on('data', (d: Buffer) => out.push(d));
        ch.stderr.on('data', (d: Buffer) => errb.push(d));
        ch.on('close', (code: number | null) => {
          clearTimeout(t);
          resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8') });
        });
        if (stdin !== undefined) ch.end(stdin); else ch.end();
      });
    });
  }

  /** Run a long command and receive raw stdout chunks. Returns a function that stops it. */
  stream(cmd: string, onData: (b: Buffer) => void, onClose: (code: number | null) => void, onErr?: (s: string) => void, stdin?: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.c.exec(cmd, (err, ch: ClientChannel) => {
        if (err) return reject(err);
        ch.on('data', onData);
        ch.stderr.on('data', (d: Buffer) => onErr?.(d.toString('utf8')));
        ch.on('close', onClose);
        if (stdin !== undefined) ch.end(stdin);
        resolve(() => { try { ch.signal('TERM'); } catch { /* ignore */ } ch.close(); });
      });
    });
  }

  upload(content: Buffer | string, remotePath: string, mode = 0o644): Promise<void> {
    return new Promise((resolve, reject) => {
      this.c.sftp((err, sftp) => {
        if (err) return reject(err);
        const ws = sftp.createWriteStream(remotePath, { mode });
        ws.on('close', () => { sftp.end(); resolve(); });
        ws.on('error', (e: Error) => { sftp.end(); reject(e); });
        ws.end(content);
      });
    });
  }

  private sftpOp<T>(fn: (sftp: any, done: (e?: Error | null, v?: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      this.c.sftp((err, sftp) => {
        if (err) return reject(err);
        fn(sftp, (e, v) => { sftp.end(); if (e) reject(e); else resolve(v as T); });
      });
    });
  }
  putFile(local: string, remote: string) { return this.sftpOp<void>((s, done) => s.fastPut(local, remote, (e: Error | null) => done(e))); }
  getFile(remote: string, local: string) { return this.sftpOp<void>((s, done) => s.fastGet(remote, local, (e: Error | null) => done(e))); }

  /** Forward a random local port to 127.0.0.1:remotePort on the server. */
  forward(remotePort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        this.c.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, ch) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(ch).pipe(sock);
          sock.on('error', () => ch.close());
          ch.on('error', () => sock.destroy());
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.servers.push(server);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }
}
