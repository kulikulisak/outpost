// "Through the desktop": a small HTTP server on the LAN that hands every request (and the VNC
// websocket) to rcc serve on the VPS through this app's SSH connection. The phone opens
// http://<this computer>:7789 on the same Wi-Fi; nothing on the VPS needs a public address.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import type { Remote } from './remote';

export class Relay {
  private srv: http.Server | null = null;
  private upstream: number | null = null; // local end of the SSH forward to the VPS's 127.0.0.1:7788
  port = 7789;

  constructor(private remote: Remote) {}

  get running() { return !!this.srv; }

  reset() { this.upstream = null; } // the SSH connection was re-made; forward again on next request

  private async target(): Promise<number> {
    if (!this.upstream) this.upstream = await this.remote.ssh.forward(await this.remote.servePort());
    return this.upstream;
  }

  async start(port = 7789) {
    if (this.srv) return this.status();
    this.port = port;
    const srv = http.createServer(async (req, res) => {
      let up: number;
      try { up = await this.target(); } catch (e: any) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`电脑端连不上 VPS：${e.message}`); return; }
      const headers = { ...req.headers, host: `127.0.0.1:${up}`, 'x-rcc-via': 'relay' };
      const p = http.request({ host: '127.0.0.1', port: up, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      p.on('error', (e) => { this.upstream = null; if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`VPS 没有响应：${e.message}`); } else res.end(); });
      req.pipe(p);
      res.on('close', () => p.destroy());
    });
    srv.keepAliveTimeout = 120000;
    srv.on('upgrade', async (req, sock, head) => {
      let up: number;
      try { up = await this.target(); } catch { sock.destroy(); return; }
      const c = net.connect(up, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^host$/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        lines.push(`Host: 127.0.0.1:${up}`);
        c.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) c.write(head);
        c.pipe(sock); sock.pipe(c);
      });
      const end = () => { c.destroy(); sock.destroy(); };
      c.on('error', end); sock.on('error', end); c.on('close', end); sock.on('close', end);
    });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(port, '0.0.0.0', () => resolve()); });
    this.srv = srv;
    return this.status();
  }

  stop() { this.srv?.close(); this.srv = null; this.upstream = null; return this.status(); }

  /** LAN addresses the phone can reach (private ranges first). */
  urls(): string[] {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.unshift(`http://${a.address}:${this.port}`);
      else if (!a.address.startsWith('169.254.')) out.push(`http://${a.address}:${this.port}`);
    }
    return out;
  }

  status() { return { running: this.running, port: this.port, urls: this.running ? this.urls() : [] }; }
}
