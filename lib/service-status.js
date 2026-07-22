const { sendTelegram } = require('./notificaciones');

// No avisamos apenas se detecta la caída: la mayoría dura menos de esto y
// se recupera sola (ver historial de blips de 0-1 min). Solo avisamos si
// sigue caído pasado el umbral.
const DOWN_NOTIFY_THRESHOLD_MS = 10 * 60 * 1000;

// Marca INTRALU como caído la primera vez que se detecta (el WHERE
// is_down=false hace que, entre hasta 15 checks en paralelo, solo el que
// "gana la carrera" reciba una fila de vuelta y toque `since` — el resto
// ve 0 filas afectadas y no hace nada). No avisa todavía: eso lo hace
// maybeNotifyDown una vez que la caída cruza el umbral mínimo. Devuelve
// true si esta llamada fue la que cambió el estado a caído.
async function markIntraluDown(supabase, telegramToken, adminChatId) {
  const { data, error } = await supabase
    .from('service_status')
    .update({ is_down: true, since: new Date().toISOString(), down_notified: false, updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', false)
    .select();

  if (error) {
    console.error('markIntraluDown:', error.message);
    return false;
  }
  if (data && data.length > 0) {
    console.error('🔴 INTRALU no responde — marcado como caído (esperando confirmación antes de avisar).');
    return true;
  }

  // Ya estaba caído: ver si esta vez toca avisar.
  await maybeNotifyDown(supabase, telegramToken, adminChatId);
  return false;
}

// Avisa al admin una sola vez por caída, y solo si la caída ya lleva más
// del umbral mínimo — el WHERE (is_down=true, down_notified=false, since
// suficientemente vieja) hace que, entre checks en paralelo, solo uno gane
// la carrera y mande el aviso.
async function maybeNotifyDown(supabase, telegramToken, adminChatId) {
  const cutoff = new Date(Date.now() - DOWN_NOTIFY_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('service_status')
    .update({ down_notified: true, updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', true)
    .eq('down_notified', false)
    .lte('since', cutoff)
    .select();

  if (error) {
    console.error('maybeNotifyDown:', error.message);
    return;
  }
  if (!data || data.length === 0) return;

  const since = data[0].since ? new Date(data[0].since) : null;
  const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
  const msg = `🔴 INTRALU lleva caído${mins != null ? ` ~${mins} min` : ' un rato'} (no responde). Voy a avisar cuando se recupere.`;
  console.error(msg);
  if (adminChatId) await sendTelegram(telegramToken, adminChatId, msg).catch(() => {});
}

// Marca INTRALU como recuperado la primera vez que un login tiene éxito
// después de una caída. Mismo patrón de update atómico que markIntraluDown.
// Si la caída nunca cruzó el umbral (down_notified sigue false), se
// resetea el estado en silencio — nunca se avisó que cayó, así que no
// tiene sentido avisar que se recuperó.
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

  if (!data[0].down_notified) {
    console.log('INTRALU se recuperó de un blip corto (no se había avisado la caída).');
    return;
  }

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
