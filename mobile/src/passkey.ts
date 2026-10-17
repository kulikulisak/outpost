// Passkeys: after pairing once, a phone (or any device synced with the same Apple / Google account)
// can sign in with Face ID / fingerprint instead of a pairing code. Needs HTTPS.
import { api } from './api';

const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const passkeySupported = () => !(window as any).OutpostNative && !!window.PublicKeyCredential && (location.protocol === 'https:' || /^(localhost|127\.)/.test(location.hostname));

export async function registerPasskey(name: string) {
  const o = await api<any>('/api/passkey/register-options');
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(o.challenge), rp: o.rp,
      user: { ...o.user, id: fromB64u(o.user.id) },
      pubKeyCredParams: o.pubKeyCredParams, authenticatorSelection: o.authenticatorSelection, attestation: 'none',
      excludeCredentials: (o.excludeCredentials || []).map((c: any) => ({ type: 'public-key', id: fromB64u(c.id) })),
      timeout: 120000,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('已取消');
  const r = cred.response as AuthenticatorAttestationResponse;
  await api('/api/passkey/register', { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject), name });
}

export async function loginWithPasskey(deviceName: string): Promise<{ token: string; url: string | null; server: string }> {
  const o = await api<any>('/api/passkey/login-options');
  if (!o.available) throw new Error('这台服务器还没有设置通行密钥：先用配对码连接一次，再在「设置 → 通行密钥」里添加');
  const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64u(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 120000 } }) as PublicKeyCredential | null;
  if (!cred) throw new Error('已取消');
  const r = cred.response as AuthenticatorAssertionResponse;
  return api('/api/passkey/login', { id: b64u(cred.rawId), clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature), name: deviceName });
}
