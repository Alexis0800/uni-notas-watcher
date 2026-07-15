// Valida el `initData` que manda un Telegram Web App, según el algoritmo
// oficial: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// Sin esto, cualquiera podría mandar un POST directo a este endpoint
// haciéndose pasar por cualquier chat_id de Telegram.

const MAX_AGE_SECONDS = 3600; // 1 hora: initData viejo se rechaza (anti-replay).

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message) as BufferSource);
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<{ ok: true; userId: number } | { ok: false; reason: string }> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'sin hash' };
  params.delete('hash');

  const authDate = Number(params.get('auth_date') ?? '0');
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'initData vencido' };
  }

  const dataCheckString = Array.from(params.keys())
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join('\n');

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken);
  const computedHash = toHex(await hmacSha256(secretKey, dataCheckString));

  if (computedHash !== hash) return { ok: false, reason: 'hash inválido' };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'sin user' };

  try {
    const user = JSON.parse(userRaw);
    if (typeof user.id !== 'number') return { ok: false, reason: 'user.id inválido' };
    return { ok: true, userId: user.id };
  } catch {
    return { ok: false, reason: 'user no parseable' };
  }
}
