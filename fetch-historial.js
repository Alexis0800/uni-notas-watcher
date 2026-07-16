require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso, etiquetaPeriodo } = require('./lib/notificaciones');

// Corrido por .github/workflows/fetch-historial.yml, disparado por
// telegram-webhook cuando alguien pide un ciclo pasado por /ciclos que
// todavía no está en `historial`. Revisa un solo (chat_id, codper) por
// corrida — nunca un lote, para no generar una ráfaga de requests contra
// INTRALU si alguien quisiera "todo su historial" de una vez (ver
// docs/superpowers/specs/2026-07-16-ciclos-pasados-design.md).
async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    CREDENTIALS_ENCRYPTION_KEY,
    TELEGRAM_TOKEN,
    CHAT_ID,
    CODPER,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN || !CHAT_ID || !CODPER) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN, CHAT_ID o CODPER en el entorno');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const chatId = Number(CHAT_ID);

  const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
  if (error || !usuario) {
    console.error('❌ No encontré a chat_id', chatId, error?.message || '');
    process.exit(1);
  }

  try {
    const password = await decrypt(usuario.password_encrypted, CREDENTIALS_ENCRYPTION_KEY);
    const client = await login(usuario.codigo_uni, password);
    const { csrfToken, cursos } = await fetchCursosMatriculados(client, CODPER);

    const cursosMeta = {};
    const evaluacionesTodas = [];
    for (const curso of cursos) {
      const { evaluaciones, formulas, promedios } = await fetchEvaluaciones(client, csrfToken, { codper: CODPER, ...curso });
      const cursoKey = `${curso.codcur}-${curso.seccion}`;
      cursosMeta[cursoKey] = {
        nombre: curso.nombre,
        formulas,
        promedios,
        evaluaciones: evaluaciones.map((ev) => ({
          variable: ev.variable,
          descripcion: ev.descripcion,
          nota: ev.nota,
          anulada: ev.anulada,
          valor: ev.fecha ? formatearNota(ev) : null,
          fecha: ev.fecha,
        })),
      };

      for (const ev of evaluaciones) {
        if (!ev.fecha) continue;
        evaluacionesTodas.push({
          cursoKey,
          curso: curso.nombre,
          descripcion: ev.descripcion,
          nota: ev.nota,
          anulada: ev.anulada,
          valor: formatearNota(ev),
          fecha: ev.fecha,
        });
      }
    }

    const historialActualizado = { ...(usuario.historial || {}), [CODPER]: cursosMeta };
    await supabase.from('usuarios').update({ historial: historialActualizado }).eq('id', usuario.id);

    const bloque = agruparPorCurso(evaluacionesTodas, cursosMeta);
    await sendTelegram(
      TELEGRAM_TOKEN,
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiquetaPeriodo(CODPER)}:\n\n${bloque}`
        : `No encontré notas registradas en el ciclo ${etiquetaPeriodo(CODPER)}.`,
    );
    console.log(`✅ Historial de ${CODPER} guardado para chat_id ${chatId}`);
  } catch (err) {
    console.error(`❌ chat_id ${chatId}, codper ${CODPER}:`, err.message);
    await sendTelegram(
      TELEGRAM_TOKEN,
      chatId,
      `❌ No pude revisar el ciclo ${etiquetaPeriodo(CODPER)}: ${err.message}`,
    ).catch(() => {});
    process.exit(1);
  }
}

main();
