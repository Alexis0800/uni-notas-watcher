const { sendTelegram } = require('./notificaciones');

// Marca INTRALU como caído la primera vez que se detecta (el WHERE
// is_down=false hace que, entre hasta 15 checks en paralelo, solo el que
// "gana la carrera" reciba una fila de vuelta y mande el aviso — el resto
// ve 0 filas afectadas y no hace nada). Devuelve true si esta llamada fue
// la que cambió el estado.
async function markIntraluDown(supabase, telegramToken, adminChatId) {
  const { data, error } = await supabase
    .from('service_status')
    .update({ is_down: true, since: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', false)
    .select();

  if (error) {
    console.error('markIntraluDown:', error.message);
    return false;
  }
  if (!data || data.length === 0) return false;

  console.error('🔴 INTRALU no responde — marcado como caído.');
  if (adminChatId) {
    await sendTelegram(
      telegramToken,
      adminChatId,
      '🔴 INTRALU parece estar caído (no responde). Voy a avisar cuando se recupere.',
    ).catch(() => {});
  }
  return true;
}

// Marca INTRALU como recuperado la primera vez que un login tiene éxito
// después de una caída. Mismo patrón de update atómico que markIntraluDown.
async function markIntraluUp(supabase, telegramToken, adminChatId) {
  const { data, error } = await supabase
    .from('service_status')
    .update({ is_down: false, updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', true)
    .select();

  if (error) {
    console.error('markIntraluUp:', error.message);
    return;
  }
  if (!data || data.length === 0) return;

  const since = data[0].since ? new Date(data[0].since) : null;
  const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
  const msg = `🟢 INTRALU volvió a responder${mins != null ? ` (estuvo caído ~${mins} min)` : ''}.`;
  console.log(msg);
  if (adminChatId) await sendTelegram(telegramToken, adminChatId, msg).catch(() => {});
}

// Lee el estado actual sin modificarlo — lo usa main() en check-all-users.js
// al final de la corrida para decidir el ritmo de re-encadenado en GitHub
// Actions (60s si está caído, 300s si no).
async function isIntraluDown(supabase) {
  const { data, error } = await supabase.from('service_status').select('is_down').eq('service', 'intralu').maybeSingle();
  if (error) {
    console.error('isIntraluDown:', error.message);
    return false;
  }
  return data?.is_down ?? false;
}

module.exports = { markIntraluDown, markIntraluUp, isIntraluDown };
