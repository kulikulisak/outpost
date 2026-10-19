#!/usr/bin/env node
// rcc-serve — the phone's way into Claude Code on this VPS. Zero dependencies, Node >= 18.
// Listens on 127.0.0.1 only; reach it through Tailscale Serve (HTTPS on your tailnet), any HTTPS
// reverse proxy, or the desktop app's LAN relay. Every request needs a device token from pairing.
//
//   rcc serve start [--port 7788]     run in tmux (rcc-serve)
//   rcc serve stop | status           status is JSON: running, port, url, devices, tailscale
//   rcc serve pair [--base URL]       one-time pairing code (10 min) + link; prints a QR on a terminal
//   rcc pair                          same as `serve pair`, always prints the QR
//   rcc serve devices | revoke ID     paired phones
//   rcc serve url [URL]               public URL the phone opens (auto-detected with Tailscale)
//   rcc serve tailscale [--step up|serve]  install Tailscale, log in (prints login URL), publish HTTPS
//   (internal) rcc serve run

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const ROOT = process.env.RCC_HOME || path.join(os.homedir(), '.rcc');
const MROOT = path.join(ROOT, 'mobile');
const SESS = path.join(ROOT, 'sessions');
const RCC = process.env.RCC_BIN || (fs.existsSync(path.join(HERE, 'rcc')) ? path.join(HERE, 'rcc') : path.join(HERE, 'rcc.mjs'));
const WEB_DIRS = [path.join(MROOT, 'web'), path.join(HERE, 'web')];
const VERSION = '0.7.10';
const F = { cfg: path.join(MROOT, 'config.json'), dev: path.join(MROOT, 'devices.json'), pair: path.join(MROOT, 'pair.json'), subs: path.join(MROOT, 'push.json') };

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const die = (msg, code = 1) => { process.stderr.write(JSON.stringify({ error: msg }) + '\n'); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = n; i++; } }
    else a._.push(k);
  }
  return a;
}

// ---------- config, VAPID keys ----------
function cfg() {
  let c = readJ(F.cfg, null);
  if (!c || !c.vapid) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    c = { port: 7788, url: null, ...(c || {}), vapid: { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), privateJwk: privateKey.export({ format: 'jwk' }), subject: 'mailto:rcc@localhost' } };
    writeJ(F.cfg, c);
  }
  return c;
}
const saveCfg = (patch) => { const c = { ...cfg(), ...patch }; writeJ(F.cfg, c); return c; };

// ---------- devices & pairing ----------
const devices = () => readJ(F.dev, []);
function newPair(ttlMs = 10 * 60 * 1000) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  const p = { code, exp: Date.now() + ttlMs, tries: 0 };
  writeJ(F.pair, p);
  return p;
}
// OUTPOST_PAIR_CODE: a fixed pairing password set in the container's environment (Docker / Zeabur).
// It never expires, so it must be long; wrong guesses still count against the caller's IP.
function staticPairOk(code) {
  const want = String(process.env.OUTPOST_PAIR_CODE || '');
  if (want.length < 8) return false;
  const a = Buffer.from(sha(String(code || '').trim())), b = Buffer.from(sha(want));
  return crypto.timingSafeEqual(a, b);
}
function issueDevice(name, via) {
  const token = b64u(crypto.randomBytes(32));
  const dev = { id: crypto.randomBytes(4).toString('hex'), name: String(name || '手机').slice(0, 40), tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now(), via: via || 'direct' };
  writeJ(F.dev, [...devices(), dev]);
  devCache.at = 0;
  return { token, device: { id: dev.id, name: dev.name } };
}
function redeemPair(code, name, via) {
  if (staticPairOk(code)) return issueDevice(name, via);
  const p = readJ(F.pair, null);
  if (!p || Date.now() > p.exp) return { error: '配对码已过期，请重新生成' };
  if (p.tries >= 5) return { error: '尝试次数过多，请重新生成配对码' };
  const given = Buffer.from(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(8, '#').slice(0, 8));
  if (!crypto.timingSafeEqual(given, Buffer.from(p.code))) { p.tries++; writeJ(F.pair, p); return { error: '配对码不对' }; }
  fs.rmSync(F.pair, { force: true });
  return issueDevice(name, via);
}
let devCache = { at: 0, list: [] };
function authDevice(token) {
  if (!token) return null;
  if (Date.now() - devCache.at > 2000) devCache = { at: Date.now(), list: devices() };
  const h = sha(token);
  const d = devCache.list.find((x) => crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
  if (d && Date.now() - (d.lastSeen || 0) > 60000) {
    const all = devices(); const me = all.find((x) => x.id === d.id);
    if (me) { me.lastSeen = Date.now(); writeJ(F.dev, all); d.lastSeen = me.lastSeen; }
  }
  return d || null;
}
function revoke(id) {
  writeJ(F.dev, devices().filter((d) => d.id !== id));
  writeJ(F.subs, readJ(F.subs, []).filter((s) => s.deviceId !== id));
  devCache.at = 0;
}


// ---------- passkeys (WebAuthn): sign a new phone in without a pairing code ----------
// Minimal verifier: attestation "none" is accepted (we only need the public key), ES256 and RS256.
F.keys = path.join(MROOT, 'passkeys.json');
const challenges = new Map(); // challenge(b64u) -> { exp, kind, deviceId? }
function cborDecode(buf) {
  let i = 0;
  const rd = () => {
    const ib = buf[i++]; const mt = ib >> 5; let ai = ib & 31; let len;
    if (ai < 24) len = ai; else if (ai === 24) len = buf[i++]; else if (ai === 25) { len = buf.readUInt16BE(i); i += 2; } else if (ai === 26) { len = buf.readUInt32BE(i); i += 4; } else if (ai === 27) { len = Number(buf.readBigUInt64BE(i)); i += 8; } else throw new Error('cbor: indefinite length');
    switch (mt) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: { const v = buf.subarray(i, i + len); i += len; return v; }
      case 3: { const v = buf.subarray(i, i + len).toString('utf8'); i += len; return v; }
      case 4: { const v = []; for (let k = 0; k < len; k++) v.push(rd()); return v; }
      case 5: { const v = new Map(); for (let k = 0; k < len; k++) { const key = rd(); v.set(key, rd()); } return v; }
      case 7: return ai === 20 ? false : ai === 21 ? true : null;
      default: throw new Error('cbor: unsupported type');
    }
  };
  const v = rd();
  return { value: v, end: i };
}
function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } }) };
  if (kty === 3 && alg === -257) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } }) };
  throw new Error('不支持的通行密钥类型');
}
function rpOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  return { id: host.replace(/:\d+$/, ''), origin: `${proto}://${host}` };
}
function newChallenge(kind, extra = {}) {
  const c = b64u(crypto.randomBytes(32));
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  challenges.set(c, { exp: Date.now() + 5 * 60 * 1000, kind, ...extra });
  return c;
}
function checkClient(req, clientDataB64, type) {
  const cd = JSON.parse(Buffer.from(clientDataB64, 'base64url').toString('utf8'));
  const ch = challenges.get(cd.challenge);
  if (!ch || ch.exp < Date.now() || ch.kind !== type) throw new Error('验证已过期，再试一次');
  challenges.delete(cd.challenge);
  if (cd.type !== (type === 'reg' ? 'webauthn.create' : 'webauthn.get')) throw new Error('bad clientData type');
  const rp = rpOf(req);
  if (cd.origin !== rp.origin) throw new Error(`来源不匹配：${cd.origin}`);
  return { ch, rp };
}
function passkeyRegOptions(req, dev) {
  const rp = rpOf(req);
  const mine = readJ(F.keys, []);
  return { challenge: newChallenge('reg', { deviceId: dev.id }), rp: { id: rp.id, name: 'Outpost' }, user: { id: b64u(Buffer.from('outpost-owner')), name: 'outpost', displayName: `Outpost · ${process.env.OUTPOST_NAME || os.hostname()}` }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none', excludeCredentials: mine.filter((k) => k.rpId === rp.id).map((k) => ({ type: 'public-key', id: k.id })) };
}
function passkeyRegister(req, body, dev) {
  const { rp } = checkClient(req, body.clientDataJSON, 'reg');
  const att = cborDecode(Buffer.from(body.attestationObject, 'base64url')).value;
  const auth = att.get('authData');
  if (!auth.subarray(0, 32).equals(crypto.createHash('sha256').update(rp.id).digest())) throw new Error('rpId 不匹配');
  const flags = auth[32];
  if (!(flags & 0x01) || !(flags & 0x40)) throw new Error('通行密钥数据不完整');
  const credLen = auth.readUInt16BE(53);
  const credId = auth.subarray(55, 55 + credLen);
  const cose = cborDecode(auth.subarray(55 + credLen)).value;
  const { alg, key } = coseToKey(cose);
  const keys = readJ(F.keys, []).filter((k) => k.id !== b64u(credId));
  keys.push({ id: b64u(credId), rpId: rp.id, alg, pem: key.export({ type: 'spki', format: 'pem' }), name: String(body.name || dev.name || '通行密钥').slice(0, 40), createdAt: Date.now(), by: dev.id, signCount: auth.readUInt32BE(33) });
  writeJ(F.keys, keys);
  return { ok: true };
}
function passkeyLoginOptions(req) {
  const rp = rpOf(req);
  const keys = readJ(F.keys, []).filter((k) => k.rpId === rp.id);
  return { challenge: newChallenge('get'), rpId: rp.id, userVerification: 'required', allowCredentials: [], available: keys.length > 0 };
}
function passkeyLogin(req, body) {
  const { rp } = checkClient(req, body.clientDataJSON, 'get');
  const keys = readJ(F.keys, []);
  const k = keys.find((x) => x.id === body.id && x.rpId === rp.id);
  if (!k) throw new Error('这个通行密钥不是这台服务器的');
  const auth = Buffer.from(body.authenticatorData, 'base64url');
  if (!auth.subarray(0, 32).equals(crypto.createHash('sha256').update(rp.id).digest())) throw new Error('rpId 不匹配');
  if (!(auth[32] & 0x01)) throw new Error('需要验证身份');
  const data = Buffer.concat([auth, crypto.createHash('sha256').update(Buffer.from(body.clientDataJSON, 'base64url')).digest()]);
  const ok = crypto.verify('sha256', data, k.alg === -7 ? { key: k.pem, dsaEncoding: 'der' } : k.pem, Buffer.from(body.signature, 'base64url'));
  if (!ok) throw new Error('通行密钥验证失败');
  k.signCount = auth.readUInt32BE(33); k.lastUsed = Date.now(); writeJ(F.keys, keys);
  return issueDevice(body.name || '通行密钥登录', 'passkey');
}

// ---------- calling rcc ----------
function rcc(args, stdin, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [RCC, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let so = '', se = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`rcc ${args[0]} 超时`)); }, timeoutMs);
    p.stdout.on('data', (b) => (so += b)); p.stderr.on('data', (b) => (se += b));
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve(so);
      let msg = se.trim(); try { msg = JSON.parse(msg).error; } catch { /* plain */ }
      reject(new Error(msg || `rcc ${args[0]} 失败`));
    });
    p.stdin.end(stdin || '');
  });
}
const rccJ = async (args, stdin) => JSON.parse(await rcc(args, stdin));

// ---------- image privacy: drop EXIF/XMP (APP1) and comments from JPEGs ----------
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf; // malformed, keep as is
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // start of scan: rest is image data
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    if (!(marker === 0xe1 || marker === 0xfe || (marker >= 0xe2 && marker <= 0xef && marker !== 0xee))) parts.push(seg);
    i += 2 + len;
  }
  return buf;
}
function stripPng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) return buf;
  const parts = [sig]; let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i); const type = buf.toString('latin1', i + 4, i + 8);
    const chunk = buf.subarray(i, i + 12 + len);
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) parts.push(chunk);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

// ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID), no libraries ----------
export function vapidAuth(endpoint) {
  const c = cfg();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: c.vapid.subject }));
  const key = crypto.createPrivateKey({ key: c.vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${c.vapid.publicKey}`;
}
export function encryptPush(payload, p256dh, auth, fixed = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.asPrivate) ecdh.setPrivateKey(Buffer.from(fixed.asPrivate, 'base64url')); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ? Buffer.from(fixed.salt, 'base64url') : crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}
export async function pushTo(sub, msg) {
  const body = encryptPush(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { TTL: '86400', Urgency: msg.urgent ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(sub.endpoint) },
    signal: AbortSignal.timeout(15000),
  });
  return r.status;
}
async function pushAll(msg) {
  const subs = readJ(F.subs, []);
  const keep = [];
  for (const s of subs) {
    if (s.prefs && s.prefs[msg.kind] === false) { keep.push(s); continue; }
    // Safari drops a subscription after silent pushes, so never send it the "close" kind
    if (msg.kind === 'close' && /push\.apple\.com/.test(s.sub.endpoint)) { keep.push(s); continue; }
    try { const st = await pushTo(s.sub, msg); if (st !== 404 && st !== 410) keep.push(s); } catch { keep.push(s); }
  }
  if (keep.length !== subs.length) writeJ(F.subs, keep);
}

// ---------- watcher: turn session output into notifications ----------
const watch = new Map(); // sid -> { off, title, cwd }
function metaOf(sid) { return readJ(path.join(SESS, sid, 'meta.json'), {}); }
function sessTitle(m) { return m.title || (m.cwd ? path.basename(m.cwd) : '会话'); }
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
function toolLine(name, input = {}) {
  if (name === 'AskUserQuestion') return String(input.questions?.[0]?.question || '有个问题想问你').slice(0, 140);
  if (name === 'ExitPlanMode') return '方案写好了，等你同意后开始动手';
  if (name === 'Bash') return CJK.test(String(input.description || '')) ? `想要${String(input.description).slice(0, 80)}` : `想运行 ${String(input.command || '').slice(0, 120)}`;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') return `想修改 ${String(input.file_path || '').replace(/^\/(root|home\/[^/]+)\//, '~/')}`;
  if (name === 'WebFetch') return `想打开 ${input.url || ''}`;
  if (name === 'mcp__rcc__browser_open') return `想用服务器浏览器打开 ${String(input.url || '').slice(0, 100)}`;
  if (/^mcp__rcc__browser_/.test(name)) return { browser_read: '想看一下浏览器里的页面', browser_click: `想在浏览器里点「${input.text || '一个按钮'}」`, browser_type: `想在浏览器里输入「${String(input.text || '').slice(0, 40)}」`, browser_scroll: '想滚动浏览器页面', browser_back: '想让浏览器后退', browser_screenshot: '想给浏览器截个图' }[name.slice(10)] || '想操作服务器浏览器';
  return `想使用 ${String(name).replace(/^mcp__/, '')}`;
}
let lastUserText = new Map();
function scanOnce(first) {
  if (!fs.existsSync(SESS)) return;
  for (const sid of fs.readdirSync(SESS)) {
    const file = path.join(SESS, sid, 'out.jsonl');
    let size; try { size = fs.statSync(file).size; } catch { continue; }
    let w = watch.get(sid);
    if (!w) { w = { off: first ? size : 0 }; watch.set(sid, w); }
    if (size < w.off) w.off = 0;
    if (size === w.off) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size - w.off, 4 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, w.off); fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) continue;
    w.off += Buffer.byteLength(text.slice(0, lastNl + 1));
    const m = metaOf(sid);
    for (const line of text.slice(0, lastNl).split('\n')) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'rcc_user') lastUserText.set(sid, String(ev.text || ''));
      if (ev.type === 'rcc_permission_request' && (ev.tool_name === 'AskUserQuestion' || ev.tool_name === 'ExitPlanMode')) pushAll({ kind: 'ask', urgent: true, sid, req: ev.req, title: `${sessTitle(m)} · ${ev.tool_name === 'AskUserQuestion' ? '等你选择' : '等你确认方案'}`, body: toolLine(ev.tool_name, ev.input), tag: `perm-${ev.req}` }).catch(() => {});
      else if (ev.type === 'rcc_permission_request') pushAll({ kind: 'perm', urgent: true, sid, req: ev.req, title: `${sessTitle(m)} · 需要批准`, body: toolLine(ev.tool_name, ev.input), tag: `perm-${ev.req}` }).catch(() => {});
      else if (ev.type === 'rcc_permission_result') pushAll({ kind: 'close', tag: `perm-${ev.req}` }).catch(() => {});
      else if (ev.type === 'result') {
        const ok = !ev.is_error && (!ev.subtype || ev.subtype === 'success');
        const r = typeof ev.result === 'string' ? ev.result.replace(/\s+/g, ' ').trim() : '';
        pushAll({ kind: 'done', sid, title: `${sessTitle(m)} · ${ok ? '已完成' : '出错了'}`, body: (r || lastUserText.get(sid) || '').slice(0, 140), tag: `done-${sid}` }).catch(() => {});
      } else if (ev.type === 'rcc_limit') pushAll({ kind: 'limit', urgent: true, sid, title: '额度已用完', body: `账号「${ev.account}」的额度用完了${ev.resetsAt ? '，' + new Date(ev.resetsAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 恢复' : ''}`, tag: `limit-${ev.account}` }).catch(() => {});
    }
  }
}

// ---------- CDP (VPS browser) ----------
const cdpSocks = new Map();
async function cdpBase(account) {
  const slot = readJ(path.join(ROOT, 'accounts.json'), {}).accounts?.[account]?.slot;
  const port = readJ(path.join(ROOT, `desk-${account}.json`), {}).cdp || (typeof slot === 'number' ? 9310 + slot : null);
  if (!port) throw new Error('这个账号的 VPS 浏览器还没打开');
  return `http://127.0.0.1:${port}`;
}
async function cdpPages(account) {
  const r = await fetch(`${await cdpBase(account)}/json`, { signal: AbortSignal.timeout(4000) });
  return (await r.json()).filter((p) => p.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(p.url)).map((p) => ({ id: p.id, url: p.url, title: p.title || p.url }));
}
async function cdpCmd(account, method, params = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('Node 版本太旧，无法控制浏览器（需要 Node 22，或用 --experimental-websocket 启动）');
  const pages = await cdpPages(account);
  if (!pages.length) throw new Error('VPS 浏览器里没有打开的页面');
  const key = account + '\0' + pages[0].id;
  let s = cdpSocks.get(key);
  if (!s || s.ws.readyState > 1) {
    const ws = new WebSocket(`${(await cdpBase(account)).replace('http', 'ws')}/devtools/page/${pages[0].id}`);
    s = { ws, seq: 0, pending: new Map() };
    s.ready = new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('连不上浏览器调试接口'))); });
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } const p = s.pending.get(m.id); if (p) { s.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    ws.addEventListener('close', () => { cdpSocks.delete(key); for (const p of s.pending.values()) p.rej(new Error('调试连接已关闭')); });
    cdpSocks.set(key, s);
  }
  await s.ready;
  const id = ++s.seq;
  return new Promise((res, rej) => { s.pending.set(id, { res, rej }); s.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (s.pending.delete(id)) rej(new Error(`${method} 超时`)); }, 15000); });
}
async function deskCmd(account, op, arg) {
  const base = await cdpBase(account);
  switch (op) {
    case 'tabs': return cdpPages(account);
    case 'navigate': {
      let url = String(arg || '').trim(); if (!url) return {};
      if (!/^[a-z]+:\/\//i.test(url)) url = /^[^\s]+\.[^\s]{2,}$/.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      return cdpCmd(account, 'Page.navigate', { url });
    }
    case 'back': return cdpCmd(account, 'Runtime.evaluate', { expression: 'history.back()' });
    case 'forward': return cdpCmd(account, 'Runtime.evaluate', { expression: 'history.forward()' });
    case 'reload': return cdpCmd(account, 'Page.reload', {});
    case 'insert': return cdpCmd(account, 'Input.insertText', { text: String(arg || '') });
    case 'key': {
      const keys = { Enter: [13, '\r'], Backspace: [8, ''], Tab: [9, ''], Escape: [27, ''], ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''] };
      const k = keys[arg]; if (!k) throw new Error('unknown key');
      await cdpCmd(account, 'Input.dispatchKeyEvent', { type: k[1] ? 'keyDown' : 'rawKeyDown', key: arg, code: arg, windowsVirtualKeyCode: k[0], text: k[1] || undefined });
      return cdpCmd(account, 'Input.dispatchKeyEvent', { type: 'keyUp', key: arg, code: arg, windowsVirtualKeyCode: k[0] });
    }
    case 'newtab': await fetch(`${base}/json/new?${encodeURI(String(arg || 'https://claude.ai/new'))}`, { method: 'PUT' }); return {};
    case 'activate': await fetch(`${base}/json/activate/${encodeURIComponent(arg)}`); return {};
    case 'close': { const ps = await cdpPages(account); if (ps.length <= 1) await fetch(`${base}/json/new?https://claude.ai/new`, { method: 'PUT' }); await fetch(`${base}/json/close/${encodeURIComponent(arg)}`); return {}; }
    default: throw new Error(`unknown op ${op}`);
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
function send(res, code, obj, extra = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'object' && !Buffer.isBuffer(obj) ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra });
  res.end(body);
}
async function peekBody(req) { if (!req._body) req._body = await readBody(req); return req._body; }
function readBody(req, max = 40 * 1024 * 1024) {
  if (req._body) return Promise.resolve(req._body);
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function tokenOf(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('t') || null;
}
function serveStatic(req, res, pathname) {
  const root = WEB_DIRS.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (!root) return send(res, 503, '手机端网页还没安装：在电脑端「设置 → 手机」里点一次开启，或运行 vps-setup/install.sh');
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.join(root, rel);
  if (!file.startsWith(root) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const ext = path.extname(file);
  const cache = /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SEC, ...(ext === '.html' ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'" } : {}) });
  fs.createReadStream(file).pipe(res);
}

// previews: an unguessable per-open token in the path (iframes and new tabs can't send our auth header);
// the page itself is sandboxed by the preview server's CSP so it can't read this origin's storage
const previews = new Map(); // token -> { sid, port, exp }
function proxyPreview(req, res, url) {
  const m = url.pathname.match(/^\/preview\/([0-9a-f]{24})(\/.*)?$/);
  const pv = m && previews.get(m[1]);
  if (!pv || pv.exp < Date.now()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('预览链接已过期，回到对话里再点一次「预览」'); }
  if (!m[2]) { res.writeHead(302, { Location: `/preview/${m[1]}/` }); return res.end(); }
  if (pv.raw) { lastRaw.set(clientIp(req), { tok: m[1], at: Date.now() }); return proxyRaw(req, res, pv, m[2] + url.search, m[1]); }
  const up = http.request({ host: '127.0.0.1', port: pv.port, path: `/s/${pv.sid}${m[2]}${url.search}`, method: 'GET' }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end('预览服务没响应'); });
  up.end();
}

// a dev server Claude started (localhost:5173…): pages ask for /assets/… at the root, so requests whose
// Referer is a raw preview are sent to that preview's port too
function proxyRaw(req, res, pv, pathQs, tok) {
  const headers = { ...req.headers, host: `127.0.0.1:${pv.port}` };
  delete headers.authorization; delete headers.cookie; delete headers.referer; delete headers.origin;
  const up = http.request({ host: '127.0.0.1', port: pv.port, path: pathQs, method: req.method, headers }, (r) => {
    const h = { ...r.headers };
    if (h.location && /^\//.test(h.location)) h.location = `/preview/${tok}${h.location}`;
    delete h['set-cookie'];
    h['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-modals';
    res.writeHead(r.statusCode || 502, h); r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`127.0.0.1:${pv.port} 上没有服务在运行（可能已经停了），让 Claude 重新启动一下`); });
  req.pipe(up);
}
// the preview page runs sandboxed (opaque origin, so it can't read this app's storage); its requests for
// /assets/… arrive as cross-site with only our origin as Referer. Send those to the preview this client opened last.
const lastRaw = new Map(); // client ip -> { tok, at }
function rawPreviewFor(req, ip) {
  const m = String(req.headers.referer || '').match(/\/preview\/([0-9a-f]{24})\//);
  let tok = m && m[1];
  if (!tok && req.headers['sec-fetch-site'] === 'cross-site' && (!req.headers.referer || /^https?:\/\/[^/]+\/?$/.test(String(req.headers.referer)))) { const l = lastRaw.get(ip); if (l && Date.now() - l.at < 30 * 60 * 1000) tok = l.tok; }
  const pv = tok && previews.get(tok);
  return pv && pv.raw && pv.exp > Date.now() ? { pv, tok } : null;
}

const failures = new Map(); // ip -> { n, until }
// behind Zeabur / Cloudflare every request comes from the proxy; RCC_TRUST_PROXY=1 reads the real address
function clientIp(req) {
  if (process.env.RCC_TRUST_PROXY === '1') {
    const v = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (v) return String(v);
  }
  return req.socket.remoteAddress;
}
function publicBase(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!host || /^(127\.|localhost|\[::1\]|10\.|192\.168\.)/.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}
function limited(ip) { const f = failures.get(ip); return f && f.until > Date.now(); }
function fail(ip) { const f = failures.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= 10) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; } failures.set(ip, f); }

async function api(req, res, url, dev) {
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k);
  const M = req.method;
  if (p === '/api/me') {
    const c = cfg();
    return send(res, 200, { device: { id: dev.id, name: dev.name }, server: os.hostname(), version: VERSION, url: c.url, pushKey: c.vapid.publicKey, node: process.version });
  }
  if (p === '/api/sessions') return send(res, 200, await rccJ(['list']));
  if (p === '/api/projects') return send(res, 200, await rccJ(['projects']));
  if (p === '/api/accounts') return send(res, 200, await rccJ(['accounts', ...(q('usage') ? ['--usage'] : [])]));
  if (p === '/api/accounts/use' && M === 'POST') { const b = await readBody(req); return send(res, 200, await rccJ(['account-use', String(b.id)])); }
  if (p === '/api/history') return send(res, 200, (await rcc(['history', String(q('id'))], '', 60000)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  if (p === '/api/start' && M === 'POST') {
    const b = await readBody(req);
    if (!b.cwd) return send(res, 400, { error: '缺少目录' });
    const args = ['start', '--cwd', String(b.cwd)];
    for (const k of ['model', 'effort', 'resume', 'title', 'account']) if (b[k]) args.push(`--${k}`, String(b[k]));
    if (b.permissionMode) args.push('--permission-mode', String(b.permissionMode));
    if (b.worktree) args.push('--worktree', String(b.worktree), '--base', String(b.base || 'HEAD'));
    if (b.mkdir) args.push('--mkdir');
    if (b.simple) args.push('--simple');
    if (b.browser === false) args.push('--no-browser');
    return send(res, 200, await rccJ(args));
  }
  if (p === '/api/send' && M === 'POST') {
    const b = await readBody(req);
    const files = [];
    if (Array.isArray(b.files) && b.files.length) {
      const { dir } = await rccJ(['upload-dir']);
      for (const f of b.files.slice(0, 10)) {
        let buf = Buffer.from(String(f.data || ''), 'base64');
        const mime = String(f.mime || 'application/octet-stream');
        if (mime === 'image/jpeg') buf = stripJpeg(buf); else if (mime === 'image/png') buf = stripPng(buf);
        const name = String(f.name || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 80);
        const fp = path.join(dir, `${Date.now().toString(36)}-${name}`);
        fs.writeFileSync(fp, buf);
        files.push({ path: fp, name, mime });
      }
    }
    await rcc(['send', String(b.sid), '--json'], JSON.stringify({ text: String(b.text || ''), files }));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/answer' && M === 'POST') { const b = await readBody(req); await rcc(['answer', String(b.sid), String(b.req), b.decision === 'allow' ? 'allow' : 'deny', ...(b.message ? [String(b.message)] : []), ...(b.rule ? ['--rule', String(b.rule)] : []), ...(b.answers ? ['--answers', JSON.stringify(b.answers)] : [])]); return send(res, 200, { ok: true }); }
  if (p === '/api/push/prefs' && M === 'POST') { const b = await readBody(req); const subs = readJ(F.subs, []); for (const s of subs) if (s.deviceId === dev.id) s.prefs = b.prefs || null; writeJ(F.subs, subs); return send(res, 200, { ok: true }); }
  if (p === '/api/restore' && M === 'POST') { const b = await readBody(req); return send(res, 200, await rccJ(['restore', String(b.sid), String(b.checkpoint)])); }
  if (p === '/api/preview' && M === 'POST' && (await peekBody(req)).port) {
    const b = req._body; const port = Number(b.port);
    if (!(port > 0 && port < 65536) || [Number(cfg().port || 7788), 6099].includes(port)) return send(res, 400, { error: 'bad port' });
    const tok = crypto.randomBytes(12).toString('hex');
    previews.set(tok, { raw: true, port, exp: Date.now() + 12 * 3600 * 1000 });
    return send(res, 200, { url: `/preview/${tok}${String(b.path || '/').startsWith('/') ? String(b.path || '/') : '/'}` });
  }
  if (p === '/api/preview' && M === 'POST') {
    const b = await readBody(req); const sid = String(b.sid || '');
    if (!/^[0-9a-f]{6,20}$/.test(sid)) return send(res, 400, { error: 'bad sid' });
    const r = await rccJ(['preview', sid]);
    const tok = crypto.randomBytes(12).toString('hex');
    previews.set(tok, { sid, port: r.port, exp: Date.now() + 12 * 3600 * 1000 });
    return send(res, 200, { url: `/preview/${tok}/` });
  }
  if (p === '/api/interrupt' && M === 'POST') { const b = await readBody(req); await rcc(['interrupt', String(b.sid)]); return send(res, 200, { ok: true }); }
  if (p === '/api/stop' && M === 'POST') { const b = await readBody(req); await rcc(['stop', String(b.sid)]); return send(res, 200, { ok: true }); }
  if (p === '/api/events') return sse(req, res, String(q('sid')), Number(q('from') || 0));
  if (p === '/api/feed') return feed(req, res);
  if (p === '/api/push/subscribe' && M === 'POST') {
    const b = await readBody(req);
    if (!b.subscription?.endpoint || !b.subscription?.keys?.p256dh) return send(res, 400, { error: 'bad subscription' });
    const subs = readJ(F.subs, []).filter((s) => s.sub.endpoint !== b.subscription.endpoint);
    subs.push({ deviceId: dev.id, sub: b.subscription, prefs: b.prefs || null, at: Date.now() });
    writeJ(F.subs, subs);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && M === 'POST') { const b = await readBody(req); writeJ(F.subs, readJ(F.subs, []).filter((s) => s.sub.endpoint !== b.endpoint)); return send(res, 200, { ok: true }); }
  if (p === '/api/push/test' && M === 'POST') {
    const mine = readJ(F.subs, []).filter((s) => s.deviceId === dev.id);
    if (!mine.length) return send(res, 400, { error: '这台手机还没开通知' });
    const st = await Promise.all(mine.map((s) => pushTo(s.sub, { kind: 'test', title: 'Outpost', body: '通知已打通 ✓', tag: 'test' }).catch((e) => String(e.message))));
    return send(res, 200, { ok: true, status: st });
  }
  // --- desktop over the web address: the same rcc commands the ssh connection runs ---
  if (p === '/api/rcc' && M === 'POST') {
    const b = await readBody(req, 8 * 1024 * 1024);
    const argv = Array.isArray(b.argv) ? b.argv.map(String) : [];
    if (!RCC_ALLOWED.has(argv[0]) || (argv[0] === 'serve' && !['status', 'pair', 'devices', 'revoke', 'url'].includes(argv[1]))) return send(res, 403, { error: `不允许的命令：${argv[0] || ''}` });
    try { return send(res, 200, { stdout: await rcc(argv, b.stdin == null ? '' : String(b.stdin), Math.min(Number(b.timeout) || 60000, 600000)) }); }
    catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }
  if (p === '/api/file' && M === 'GET') {
    const fp = readable(q('path'));
    if (!fp || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { error: '文件不存在' });
    const inline = q('inline') === '1';
    const mime = inline ? FMIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(fp).size, 'Cache-Control': 'no-store', ...SEC, 'Content-Security-Policy': 'sandbox', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(fp))}` });
    return fs.createReadStream(fp).pipe(res);
  }
  if (p === '/api/file' && M === 'PUT') {
    const fp = insideRoot(q('path'));
    if (!fp || !fp.startsWith(path.join(ROOT, 'uploads') + path.sep)) return send(res, 403, { error: '只能上传到 uploads 目录' });
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    await new Promise((resolve, reject) => { const w = fs.createWriteStream(fp); req.pipe(w); w.on('finish', resolve); w.on('error', reject); req.on('error', reject); });
    return send(res, 200, { ok: true, path: fp });
  }
  if (p === '/api/passkey/register-options') return send(res, 200, passkeyRegOptions(req, dev));
  if (p === '/api/passkey/register' && M === 'POST') { try { return send(res, 200, passkeyRegister(req, await readBody(req, 65536), dev)); } catch (e) { return send(res, 400, { error: String(e.message || e) }); } }
  if (p === '/api/passkeys') return send(res, 200, readJ(F.keys, []).map(({ pem, ...k }) => k));
  if (p === '/api/passkeys/remove' && M === 'POST') { const b = await readBody(req); writeJ(F.keys, readJ(F.keys, []).filter((k) => k.id !== b.id)); return send(res, 200, { ok: true }); }
  if (p === '/api/devices') return send(res, 200, devices().map(({ tokenHash, ...d }) => ({ ...d, me: d.id === dev.id })));
  if (p === '/api/devices/revoke' && M === 'POST') { const b = await readBody(req); revoke(String(b.id)); return send(res, 200, { ok: true }); }
  if (p === '/api/desk/open' && M === 'POST') {
    const b = await readBody(req);
    const args = ['desk', '--account', String(b.account || 'default')];
    if (b.w && b.h) args.push('--w', String(Math.round(b.w)), '--h', String(Math.round(b.h)));
    if (b.scale) args.push('--scale', String(Math.round(b.scale * 100) / 100), '--soft-scale');
    if (b.url) args.push('--url', String(b.url));
    const r = await rccJ(args);
    return send(res, 200, { token: r.token, downloads: r.downloads });
  }
  if (p === '/api/desk/cmd' && M === 'POST') { const b = await readBody(req); return send(res, 200, (await deskCmd(String(b.account || 'default'), String(b.op), b.arg)) || {}); }
  if (p === '/api/desk/stop' && M === 'POST') { const b = await readBody(req); await rcc(['desk-stop', '--account', String(b.account || 'default')]); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'not found' });
}

function sse(req, res, sid, from) {
  const file = path.join(SESS, sid.replace(/[^\w-]/g, ''), 'out.jsonl');
  if (!fs.existsSync(file)) return send(res, 404, { error: 'no such session' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC });
  res.write('retry: 2000\n\n');
  let pos = from, closed = false, beat = Date.now();
  const tick = () => {
    if (closed) return;
    try {
      const size = fs.statSync(file).size;
      if (size < pos) pos = 0;
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(size - pos, 2 * 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
        const s = buf.toString('utf8'); const nl = s.lastIndexOf('\n');
        if (nl >= 0) {
          const chunk = s.slice(0, nl + 1);
          pos += Buffer.byteLength(chunk);
          const events = chunk.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          res.write(`data: ${JSON.stringify({ offset: pos, events })}\n\n`); beat = Date.now();
        }
      }
      if (Date.now() - beat > 15000) { res.write(': ping\n\n'); beat = Date.now(); }
    } catch { /* file vanished */ }
    let more = false; try { more = pos < fs.statSync(file).size; } catch { /* gone */ }
    setTimeout(tick, more ? 0 : 200);
  };
  req.on('close', () => { closed = true; });
  tick();
}

function feed(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC });
  res.write('retry: 3000\n\n');
  let last = '', closed = false, beat = Date.now();
  const tick = async () => {
    if (closed) return;
    try {
      const list = await rccJ(['list']);
      // pending permission prompts per session: request without a result yet
      for (const s of list) s.pending = pendingPerms(s.sid);
      const sig = JSON.stringify(list.map((s) => [s.sid, s.status, s.busy, s.bytes, s.pending.length, s.title]));
      if (sig !== last) { last = sig; res.write(`event: sessions\ndata: ${JSON.stringify(list)}\n\n`); beat = Date.now(); }
      else if (Date.now() - beat > 15000) { res.write(': ping\n\n'); beat = Date.now(); }
    } catch { /* keep trying */ }
    setTimeout(tick, 1500);
  };
  req.on('close', () => { closed = true; });
  tick();
}
const permCache = new Map();
function pendingPerms(sid) {
  const file = path.join(SESS, sid, 'out.jsonl');
  let size; try { size = fs.statSync(file).size; } catch { return []; }
  const c = permCache.get(sid) || { off: 0, open: new Map() };
  if (size < c.off) { c.off = 0; c.open.clear(); }
  if (size > c.off) {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - c.off); fs.readSync(fd, buf, 0, buf.length, c.off); fs.closeSync(fd);
    const s = buf.toString('utf8'); const nl = s.lastIndexOf('\n');
    if (nl >= 0) {
      c.off += Buffer.byteLength(s.slice(0, nl + 1));
      for (const line of s.slice(0, nl).split('\n')) {
        if (!line.includes('rcc_permission') && !line.includes('rcc_exit')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'rcc_permission_request') c.open.set(ev.req, { req: ev.req, tool: ev.tool_name, text: toolLine(ev.tool_name, ev.input) });
        else if (ev.type === 'rcc_permission_result') c.open.delete(ev.req);
        else if (ev.type === 'rcc_exit') c.open.clear();
      }
    }
    permCache.set(sid, c);
  }
  return [...c.open.values()];
}

const RCC_ALLOWED = new Set(['doctor', 'auth', 'projects', 'list', 'history', 'start', 'send', 'answer', 'interrupt', 'stop', 'restore', 'checkpoints', 'preview',
  'accounts', 'account-add', 'account-rename', 'account-use', 'account-order', 'account-remove', 'account-clear-limit',
  'login-start', 'login-status', 'login-code', 'login-stop', 'logout', 'browse', 'browser-close', 'desk', 'desk-open', 'desk-stop', 'desk-list', 'downloads', 'upload-dir', 'serve',
  'unfurl', 'files', 'commands', 'memory', 'finfo', 'thumb', 'sched-list', 'sched-put', 'sched-remove', 'sched-run']);
const SECRET_RE = /(^|\/)(\.ssh|\.gnupg|\.credentials\.json|\.netrc|\.rcc\/mobile|\.aws|\.docker\/config\.json)(\/|$)/;
// files a paired device may read: anything in the home folder (Claude can read it anyway), never secrets
function readable(p) {
  if (!p) return null;
  const fp = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
  const home = path.resolve(os.homedir());
  if (!(fp.startsWith(home + path.sep) || fp.startsWith(path.resolve(ROOT) + path.sep))) return null;
  return SECRET_RE.test(fp) ? null : fp;
}
const FMIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.html': 'text/plain; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip' };
function insideRoot(p) {
  if (!p) return null;
  const fp = path.resolve(String(p));
  return fp.startsWith(path.resolve(ROOT) + path.sep) ? fp : null;
}

// Chrome DevTools of an account's VPS browser, for the desktop app over the web address:
//   /cdp/<device token>/<account>/json...   and   ws(s)://…/cdp/<device token>/<account>/devtools/page/<id>
function cdpPath(url) {
  const m = url.pathname.match(/^\/cdp\/([^/]+)\/([\w-]+)(\/.*)$/);
  return m ? { token: decodeURIComponent(m[1]), account: m[2], rest: m[3] + url.search } : null;
}
async function proxyCdpHttp(req, res, url, ip) {
  const c = cdpPath(url);
  if (!c || limited(ip) || !authDevice(c.token)) { fail(ip); return send(res, 401, { error: '需要重新配对' }); }
  if (!/^\/json(\/|$)/.test(c.rest)) return send(res, 404, { error: 'not found' });
  const base = await cdpBase(c.account);
  const r = await fetch(base + c.rest, { method: req.method === 'PUT' ? 'PUT' : 'GET', signal: AbortSignal.timeout(8000) });
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', ...SEC });
  res.end(Buffer.from(await r.arrayBuffer()));
}
async function upgradeCdp(req, socket, head, url, ip) {
  const c = cdpPath(url);
  if (!c || limited(ip) || !authDevice(c.token) || !/^\/devtools\/(page|browser)\/[\w-]+$/.test(c.rest.split('?')[0])) { fail(ip); socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  let port; try { port = Number(new URL(await cdpBase(c.account)).port); } catch { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const up = net.connect(port, '127.0.0.1', () => {
    const lines = [`GET ${c.rest} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i]; if (!/^(host|origin)$/i.test(k)) lines.push(`${k}: ${req.rawHeaders[i + 1]}`); }
    lines.push(`Host: 127.0.0.1:${port}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
}

// websocket to the VPS screen: authenticate, then hand the raw socket to websockify
function upgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  if (url.pathname.startsWith('/cdp/')) return upgradeCdp(req, socket, head, url, ip);
  if (url.pathname !== '/vnc' || limited(ip) || !authDevice(url.searchParams.get('t'))) { if (url.pathname === '/vnc') fail(ip); socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const account = String(url.searchParams.get('account') || 'default').replace(/[^\w-]/g, '');
  const up = net.connect(Number(process.env.RCC_NOVNC_PORT || 6099), '127.0.0.1', () => {
    const lines = [`GET /websockify?token=${encodeURIComponent(account)} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i]; if (!/^(host|origin)$/i.test(k)) lines.push(`${k}: ${req.rawHeaders[i + 1]}`); }
    lines.push('Host: 127.0.0.1');
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
}

async function runServer(a) {
  const c = cfg();
  const port = Number(a.port || c.port || 7788);
  if (port !== c.port) saveCfg({ port });
  if (process.env.OUTPOST_URL && !c.url) saveCfg({ url: String(process.env.OUTPOST_URL).replace(/\/+$/, '') });
  const host = process.env.RCC_SERVE_HOST || '127.0.0.1';
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    if (process.env.RCC_SERVE_LOG && url.pathname.startsWith('/api/')) { const t0 = Date.now(); res.on('finish', () => process.stdout.write(`${Date.now()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms\n`)); process.stdout.write(`> ${Date.now()} ${req.method} ${url.pathname}\n`); }
    try {
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (limited(ip)) return send(res, 429, { error: '尝试太频繁，5 分钟后再试' });
        const b = await readBody(req, 4096);
        const r = redeemPair(b.code, b.name, req.headers['x-rcc-via'] === 'relay' ? 'relay' : 'direct');
        if (r.error) { fail(ip); return send(res, 400, r); }
        // first pairing through a public address (Zeabur, Cloudflare…): remember it for QR codes and links
        const pb = publicBase(req);
        if (!cfg().url && pb && req.headers['x-rcc-via'] !== 'relay') saveCfg({ url: pb });
        return send(res, 200, { ...r, url: cfg().url, server: process.env.OUTPOST_NAME || os.hostname() });
      }
      if (url.pathname.startsWith('/preview/')) return proxyPreview(req, res, url);
      if (!url.pathname.startsWith('/api/')) { const rp = rawPreviewFor(req, ip); if (rp) return proxyRaw(req, res, rp.pv, url.pathname + url.search, rp.tok); }
      if (url.pathname === '/api/passkey/login-options') return send(res, 200, passkeyLoginOptions(req));
      if (url.pathname === '/api/passkey/login' && req.method === 'POST') {
        if (limited(ip)) return send(res, 429, { error: '尝试太频繁，5 分钟后再试' });
        try { const r = passkeyLogin(req, await readBody(req, 16384)); return send(res, 200, { ...r, url: cfg().url, server: process.env.OUTPOST_NAME || os.hostname() }); }
        catch (e) { fail(ip); return send(res, 400, { error: String(e.message || e) }); }
      }
      if (url.pathname.startsWith('/cdp/')) return await proxyCdpHttp(req, res, url, ip);
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION });
      if (url.pathname.startsWith('/api/')) {
        if (limited(ip)) return send(res, 429, { error: '尝试太频繁，5 分钟后再试' });
        const dev = authDevice(tokenOf(req, url));
        if (!dev) { fail(ip); return send(res, 401, { error: '需要重新配对' }); }
        return await api(req, res, url, dev);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); else res.end();
    }
  });
  // proxies and tunnels in front (Tailscale Serve, the desktop relay, ssh -L) reuse idle connections;
  // closing them after Node's default 5 s races with a request already on its way and stalls it
  srv.keepAliveTimeout = 120000; srv.headersTimeout = 125000; srv.requestTimeout = 0;
  srv.on('upgrade', upgrade);
  srv.listen(port, host, () => {
    out({ ok: true, listening: `${host}:${port}`, version: VERSION });
    // containers have no terminal to run `rcc pair` in: print a code in the log while nothing is paired yet
    if (process.env.OUTPOST_PRINT_PAIR === '1' && !devices().length) {
      const p = newPair(24 * 3600 * 1000);
      process.stdout.write(`\n  ==== Outpost 配对码：${p.code.slice(0, 4)} ${p.code.slice(4)}  （24 小时内有效，用一次就失效；重启会换新的）====\n`);
      if (process.env.OUTPOST_PAIR_CODE) process.stdout.write('  也可以用你在环境变量 OUTPOST_PAIR_CODE 里设置的配对密码。\n');
      process.stdout.write('\n');
    }
  });
  scanOnce(true);
  setInterval(() => { try { scanOnce(false); } catch { /* keep going */ } }, 1000);
  // scheduled tasks: one tick a minute
  setInterval(() => { const c = spawn(process.execPath, [RCC, 'sched-tick'], { stdio: 'ignore', env: { ...process.env, OUTPOST_IN_SERVE: '1' } }); c.on('error', () => {}); }, 60000);
}

// ---------- tailscale ----------
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
const sudo = () => (process.getuid?.() === 0 ? [] : ['sudo', '-n']);
function tsStatus() {
  if (!has('tailscale')) return { installed: false };
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  let j = {}; try { j = JSON.parse(r.stdout); } catch { /* not running */ }
  const dns = (j.Self?.DNSName || '').replace(/\.$/, '') || null;
  const sv = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
  let serving = false; try { serving = JSON.stringify(JSON.parse(sv.stdout || '{}')).includes(`127.0.0.1:${cfg().port}`); } catch { /* old version */ }
  const log = (() => { try { return fs.readFileSync(path.join(MROOT, 'tailscale.log'), 'utf8'); } catch { return ''; } })();
  const loginUrl = j.BackendState === 'NeedsLogin' ? (j.AuthURL || (log.match(/https:\/\/login\.tailscale\.com\/[^\s]+/g) || []).pop() || null) : null;
  const enableUrl = !serving ? ((log.match(/https:\/\/login\.tailscale\.com\/f\/serve[^\s]*/g) || []).pop() || null) : null;
  return { installed: true, state: j.BackendState || 'Stopped', dnsName: dns, serving, loginUrl, enableUrl, url: dns ? `https://${dns}` : null };
}
async function tailscale(a) {
  fs.mkdirSync(MROOT, { recursive: true });
  const logf = path.join(MROOT, 'tailscale.log');
  if (!has('tailscale')) {
    const r = spawnSync('bash', ['-c', `curl -fsSL https://tailscale.com/install.sh | ${sudo().join(' ')} sh`], { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) die(`安装 Tailscale 失败：${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`);
  }
  let st = tsStatus();
  if (st.state !== 'Running') {
    // `tailscale up` blocks until the login finishes; run it in the background and read the URL from its log
    spawnSync('bash', ['-c', `${sudo().join(' ')} systemctl enable --now tailscaled >/dev/null 2>&1 || true`]);
    if (!spawnSync('pgrep', ['-f', 'tailscale up']).stdout?.length) {
      const p = spawn('bash', ['-c', `${sudo().join(' ')} tailscale up --hostname=${os.hostname().replace(/[^\w-]/g, '-').toLowerCase()} >${JSON.stringify(logf)} 2>&1`], { detached: true, stdio: 'ignore' });
      p.unref();
    }
    for (let i = 0; i < 40; i++) { await sleep(500); st = tsStatus(); if (st.state === 'Running' || st.loginUrl) break; }
    if (st.state !== 'Running') return out({ ...st, step: 'login' });
  }
  if (!st.serving) {
    const r = spawnSync('bash', ['-c', `${sudo().join(' ')} timeout 20 tailscale serve --bg --https=443 http://127.0.0.1:${cfg().port} >>${JSON.stringify(logf)} 2>&1`], { encoding: 'utf8' });
    st = tsStatus();
    if (!st.serving) return out({ ...st, step: 'enable-https', detail: r.status === 0 ? null : '需要在 Tailscale 后台开启 HTTPS 证书' });
  }
  if (st.url) saveCfg({ url: st.url });
  out({ ...st, step: 'done' });
}

// ---------- CLI ----------
function tmuxAlive() { return spawnSync('tmux', ['has-session', '-t', 'rcc-serve'], { stdio: 'ignore' }).status === 0; }
async function pingLocal(port) { try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function status() {
  const c = cfg();
  const ts = tsStatus();
  if (ts.url && !c.url) saveCfg({ url: ts.url });
  out({ running: await pingLocal(c.port), port: c.port, url: c.url || ts.url || null, web: WEB_DIRS.some((d) => fs.existsSync(path.join(d, 'index.html'))), devices: devices().map(({ tokenHash, ...d }) => d), tailscale: ts, version: VERSION });
}
async function startSrv(a) {
  const c = a.port ? saveCfg({ port: Number(a.port) }) : cfg();
  if (await pingLocal(c.port)) return out({ ok: true, running: true, port: c.port });
  spawnSync('tmux', ['kill-session', '-t', 'rcc-serve'], { stdio: 'ignore' });
  const major = Number(process.versions.node.split('.')[0]);
  const flags = typeof WebSocket === 'undefined' && major >= 20 ? '--experimental-websocket ' : '';
  const log = path.join(MROOT, 'serve.log');
  const envs = ['HOME', 'PATH', 'RCC_HOME', 'RCC_CLAUDE', 'RCC_NOVNC_PORT', 'RCC_SERVE_HOST', 'RCC_SERVE_LOG', 'RCC_TRUST_PROXY', 'OUTPOST_PAIR_CODE'].filter((k) => process.env[k] !== undefined).map((k) => `${k}=${JSON.stringify(process.env[k])}`).join(' ');
  const cmd = `while true; do env ${envs} ${JSON.stringify(process.execPath)} ${flags}${JSON.stringify(SELF)} run --port ${c.port} >>${JSON.stringify(log)} 2>&1; sleep 2; done`;
  const r = spawnSync('tmux', ['new-session', '-d', '-s', 'rcc-serve', cmd], { encoding: 'utf8' });
  if (r.status !== 0) die(`tmux failed: ${(r.stderr || '').trim()}`);
  for (let i = 0; i < 30; i++) { if (await pingLocal(c.port)) return out({ ok: true, running: true, port: c.port }); await sleep(200); }
  let tailLog = ''; try { tailLog = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { /* none */ }
  die(`服务没起来：${tailLog || '没有日志'}`);
}
function pair(a, forceQr) {
  const c = cfg();
  const base = String(a.base || c.url || tsStatus().url || '').replace(/\/+$/, '');
  const p = newPair();
  const link = base ? `${base}/#pair=${p.code}` : null;
  if (forceQr || a.qr || process.stdout.isTTY) {
    if (link && has('qrencode')) spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '2', link], { stdio: 'inherit' });
    process.stdout.write(`\n  配对码：${p.code.slice(0, 4)} ${p.code.slice(4)}   （10 分钟内有效，只能用一次）\n`);
    if (link) process.stdout.write(`  链接：${link}\n`);
    else process.stdout.write('  还没有手机能访问的地址：先运行 rcc serve tailscale，或 rcc serve url https://你的域名\n');
    if (link && !has('qrencode')) process.stdout.write('  （装上 qrencode 就能在这里显示二维码：apt install qrencode）\n');
    process.stdout.write('\n');
    return;
  }
  out({ code: p.code, expiresAt: p.exp, url: link, base: base || null });
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SELF); } catch { return false; } })();
const a = parseArgs(isMain ? process.argv.slice(2) : ['__lib']);
const [cmd, arg] = a._;
if (isMain) switch (cmd) {
  case 'run': await runServer(a); break;
  case 'start': await startSrv(a); break;
  case 'stop': spawnSync('tmux', ['kill-session', '-t', 'rcc-serve'], { stdio: 'ignore' }); out({ ok: true }); break;
  case 'status': case undefined: await status(); break;
  case 'pair': pair(a, !!a['force-qr']); break;
  case 'devices': out(devices().map(({ tokenHash, ...d }) => d)); break;
  case 'revoke': revoke(String(arg)); out({ ok: true }); break;
  case 'url': if (arg !== undefined) saveCfg({ url: arg ? String(arg).replace(/\/+$/, '') : null }); out({ url: cfg().url }); break;
  case 'tailscale': await tailscale(a); break;
  case 'push-test': await pushAll({ kind: 'test', title: 'Outpost', body: '通知已打通 ✓', tag: 'test' }); out({ ok: true }); break;
  default: die(`unknown serve command: ${cmd}`);
}
