// API llamada desde la Mini App de Telegram (docs/registro.html, servida por
// GitHub Pages — Supabase Edge Functions no puede servir HTML en el plan
// gratis). Recibe { codigo, password, initData } y valida el initData que
// firma Telegram para confirmar que el chat_id es realmente de esa persona.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encrypt } from './crypto.ts';
import { verifyInitData } from './init-data.ts';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const ENCRYPTION_KEY = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// Dispara check-new-registration.yml (workflow aparte de la cadena de 5
// min de check-grade.yml, con su propio concurrency group) para revisar
// ya mismo solo a los recién registrados — best-effort: si falla (falta
// el secret, GitHub no responde), el registro ya se guardó bien igual, y
// la cadena normal de check-grade.yml lo recoge de todas formas más tarde
// (ver docs/SCALING.md).
async function dispararChequeoInmediato() {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows/check-new-registration.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );
    if (!res.ok) console.error('dispararChequeoInmediato:', res.status, await res.text());
  } catch {
    // best-effort, no pasa nada si falla
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method not allowed' }, 405);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'JSON inválido' }, 400);

  const { codigo, password, initData } = body as { codigo?: string; password?: string; initData?: string };
  if (!codigo || !password || !initData) {
    return json({ ok: false, error: 'Faltan campos' }, 400);
  }

  const verificacion = await verifyInitData(initData, TELEGRAM_TOKEN);
  if (!verificacion.ok) {
    return json({ ok: false, error: 'No se pudo verificar tu sesión de Telegram, abre el formulario de nuevo.' }, 401);
  }

  const chatId = verificacion.userId;
  const passwordEncrypted = await encrypt(password, ENCRYPTION_KEY);

  const { error } = await supabase.from('usuarios').upsert(
    {
      chat_id: chatId,
      codigo_uni: codigo.toUpperCase(),
      password_encrypted: passwordEncrypted,
      active: true,
      consecutive_failures: 0,
      last_grades: {},
      seeded: false,
    },
    { onConflict: 'chat_id' },
  );

  if (error) {
    console.error(error);
    return json({ ok: false, error: 'No pude guardar tu registro, intenta de nuevo en un rato.' }, 500);
  }

  await dispararChequeoInmediato();
  await sendMessage(
    chatId,
    `✅ Registrado con código <b>${codigo.toUpperCase()}</b>.\n\nYa estoy revisando tus notas — te mando tu estado actual por acá en cuanto termine.\nSi tu código o contraseña están mal, te aviso aquí también.`,
  );

  return json({ ok: true });
});
