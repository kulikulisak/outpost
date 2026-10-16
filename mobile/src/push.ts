import { api, auth } from './api';

export const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

export async function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const t = auth.token;
    (reg.active || reg.installing || reg.waiting)?.postMessage({ type: 'token', token: t });
    navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'token', token: auth.token }));
    return reg;
  } catch { return null; }
}

const b64ToBytes = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

export async function pushState(): Promise<'unsupported' | 'need-install' | 'denied' | 'off' | 'on'> {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'need-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush(key: string, prefs: Record<string, boolean>) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('没有获得通知权限');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW());
  if (!reg) throw new Error('这个浏览器不支持后台通知');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('/api/push/subscribe', { subscription: sub.toJSON(), prefs });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}
