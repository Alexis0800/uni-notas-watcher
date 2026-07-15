// AES-256-GCM usando Web Crypto (disponible como global en Node 20+ y en Deno,
// sin imports — el mismo esquema lo usa la Edge Function de Supabase).
const ALGO = { name: 'AES-GCM', length: 256 };

function importKey(keyB64) {
  const raw = Buffer.from(keyB64, 'base64');
  return crypto.subtle.importKey('raw', raw, ALGO, false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext, keyB64) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]).toString('base64');
}

async function decrypt(payloadB64, keyB64) {
  const key = await importKey(keyB64);
  const combined = Buffer.from(payloadB64, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return Buffer.from(plaintextBuf).toString('utf8');
}

function generateKeyB64() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

module.exports = { encrypt, decrypt, generateKeyB64 };
