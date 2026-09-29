require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Quién es quién: código UNI (se guarda en claro) + nombre de Telegram
// (getChat sobre el chat_id). La contraseña no se descifra: para
// identificar a alguien no hace falta.
async function nombreTelegram(token, chatId) {
  try {
    const { data } = await axios.get(`https://api.telegram.org/bot${token}/getChat`, { params: { chat_id: chatId } });
    const c = data.result;
    const nombre = [c.first_name, c.last_name].filter(Boolean).join(' ');
    return c.username ? `${nombre} (@${c.username})` : nombre;
  } catch (err) {
    return `? (${err.response?.data?.description || err.message})`;
  }
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_TOKEN) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o TELEGRAM_TOKEN en .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from('usuarios')
    .select('codigo_uni, chat_id, active, consecutive_failures, updated_at, created_at')
    .order('created_at');
  if (error) throw error;

  const filas = await Promise.all(
    data.map(async (u) => ({
      codigo: u.codigo_uni,
      telegram: await nombreTelegram(TELEGRAM_TOKEN, u.chat_id),
      chat_id: u.chat_id,
      activo: u.active ? 'sí' : 'no',
      fallos: u.consecutive_failures,
      ultimo_login_ok: u.updated_at.slice(0, 16).replace('T', ' '),
      registrado: u.created_at.slice(0, 10),
    })),
  );
  console.table(filas);
  console.log(`Total: ${filas.length} | activos: ${data.filter((u) => u.active).length}`);
}

main();
