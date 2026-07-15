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

  await sendMessage(
    chatId,
    `✅ Registrado con código ${codigo.toUpperCase()}. En los próximos minutos hago la primera revisión para guardar tu estado actual (sin avisarte nada todavía) — si tu código o contraseña están mal, te aviso aquí. Desde la revisión siguiente ya te aviso solo de notas nuevas de verdad.`,
  );

  return json({ ok: true });
});
