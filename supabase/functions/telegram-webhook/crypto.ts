// AES-256-GCM usando Web Crypto (mismo esquema que lib/crypto.js del lado
// Node — copiado en vez de importado porque cada Edge Function de Supabase
// se empaqueta como una unidad aislada).
const ALGO = { name: 'AES-GCM', length: 256 };

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBytes(keyB64) as BufferSource, ALGO, false, ['encrypt']);
}

export async function encrypt(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv } as AesGcmParams,
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToB64(combined);
}
