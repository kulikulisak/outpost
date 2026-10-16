// Files picked on the phone. Photos are re-drawn on a canvas before upload, which drops EXIF
// (GPS position, phone model, capture time) and shrinks huge camera images.

export interface Att { id: string; name: string; mime: string; data: string; size: number; preview?: string }

const blobToB64 = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(b); });

async function cleanImage(f: File): Promise<{ blob: Blob; mime: string; name: string }> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) && !/\.(jpe?g|png|webp|heic)$/i.test(f.name)) return { blob: f, mime: f.type, name: f.name };
  try {
    const bmp = await createImageBitmap(f);
    const max = 2048;
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const png = f.type === 'image/png';
    const mime = png ? 'image/png' : 'image/jpeg';
    const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, 0.9));
    const name = (f.name || `photo-${Date.now()}`).replace(/\.(heic|heif|webp|jpe?g|png)$/i, '') + (png ? '.png' : '.jpg');
    return { blob, mime, name };
  } catch { return { blob: f, mime: f.type, name: f.name }; }
}

export async function toAtts(list: FileList | File[]): Promise<Att[]> {
  const out: Att[] = [];
  for (const f of Array.from(list)) {
    if (f.size > 30 * 1024 * 1024) throw new Error(`${f.name} 太大（上限 30 MB）`);
    const c = f.type.startsWith('image/') ? await cleanImage(f) : { blob: f, mime: f.type || 'application/octet-stream', name: f.name || 'file' };
    out.push({ id: Math.random().toString(36).slice(2), name: c.name, mime: c.mime, data: await blobToB64(c.blob), size: c.blob.size, preview: c.mime.startsWith('image/') ? URL.createObjectURL(c.blob) : undefined });
  }
  return out;
}
