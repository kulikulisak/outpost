// A fake push service: receives what rcc serve sends, checks the VAPID JWT signature and decrypts the payload
// the way a browser would (RFC 8291 receiver side).
import http from 'node:http';
import crypto from 'node:crypto';
process.env.RCC_HOME = '/tmp/rcc-push-test';
const { pushTo } = await import('../rcc-serve.mjs');
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
let fail = (m) => { console.log('FAIL', m); process.exit(1); };
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization || ''); if (!m) fail('no vapid header');
    const [h, p, s] = m[1].split('.');
    const pub = Buffer.from(m[2], 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) fail('bad JWT signature');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    if (claims.aud !== `http://127.0.0.1:${srv.address().port}`) fail('bad aud ' + claims.aud);
    if (req.headers['content-encoding'] !== 'aes128gcm') fail('content-encoding');
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const shared = ua.computeSecret(asPub);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    const msg = JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
    console.log(msg.title === '需要批准' ? 'PASS push roundtrip (VAPID signature ok, payload decrypted)' : 'FAIL payload');
    res.writeHead(201); res.end(); srv.close();
  });
});
srv.listen(0, '127.0.0.1', async () => {
  sub.endpoint = `http://127.0.0.1:${srv.address().port}/push/abc`;
  const st = await pushTo(sub, { kind: 'perm', title: '需要批准', body: '想运行 npm test' });
  if (st !== 201) fail('status ' + st);
});
