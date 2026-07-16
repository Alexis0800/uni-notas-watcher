require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');

const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;
const FAILURE_THRESHOLD = 3;
const NOTA_APROBATORIA = 10;

// Medido desde corridas reales de GitHub Actions (no desde una máquina
// local — la ruta de red hacia alumnos.uni.edu.pe es más lenta desde ahí):
// 26-32s por usuario en 5 corridas con 1 solo usuario activo, ver
// docs/SCALING.md#cómo-se-midió-esto. El main() de abajo loggea el tiempo
// real de cada corrida para poder seguir ajustando esto según crezca la
// base de usuarios.
const SECONDS_PER_USER = 30;
// Margen bajo los 5 min del cron. El overhead real de checkout + setup-node
// + pnpm install medido en GitHub Actions es de solo ~5s (no los ~90s que
// se asumían antes de medirlo) — 270s deja margen de sobra para eso más
// variación normal.
const RUN_WINDOW_SECONDS = 270;
// Cuántos usuarios caben en una pasada sin que la corrida se pase de
// RUN_WINDOW_SECONDS. Si hay más usuarios activos que esto, no se revisan
// todos en cada corrida — se toma a los más atrasados (ver main()).
const MAX_BATCH_SIZE = Math.max(1, Math.floor((RUN_WINDOW_SECONDS / SECONDS_PER_USER) * CONCURRENCY));

const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

async function sendTelegram(token, chatId, text, replyMarkup) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// 🟢 si aprobó (>=10), 🔴 si desaprobó, anuló (0A) o no se presentó (NSP).
// Telegram no soporta color de texto en sus mensajes — esto es lo más
// parecido que se puede hacer.
function emoji(ev) {
  if (!ev.anulada && ev.nota !== null && ev.nota >= NOTA_APROBATORIA) return '🟢';
  return '🔴';
}

// Agrupa evaluaciones por curso para que el nombre del curso no se repita
// en cada línea — una vez el curso, las evaluaciones sangradas debajo.
function agruparPorCurso(evaluaciones) {
  const porCurso = new Map();
  for (const ev of evaluaciones) {
    if (!porCurso.has(ev.curso)) porCurso.set(ev.curso, []);
    porCurso.get(ev.curso).push(ev);
  }
  const bloques = [];
  for (const [curso, evs] of porCurso) {
    const lineas = evs.map((e) => `   ${emoji(e)} ${e.descripcion}: <b>${e.valor}</b>`);
    bloques.push(`📘 <b>${curso}</b>\n${lineas.join('\n')}`);
  }
  return bloques.join('\n\n');
}

async function checkUser(supabase, telegramToken, encryptionKey, usuario) {
  const { id, chat_id, codigo_uni, password_encrypted, last_grades, seeded } = usuario;

  try {
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const { codper, csrfToken, cursos } = await fetchCursosMatriculados(client);

    const currentMap = {};
    const cursosMeta = {};
    for (const curso of cursos) {
      const { evaluaciones, formulas, promedios } = await fetchEvaluaciones(client, csrfToken, { codper, ...curso });
      const cursoKey = `${curso.codcur}-${curso.seccion}`;
      // Lista completa (con y sin fecha) para el simulador: las que ya
      // tienen fecha quedan fijas, las que no, son las editables ahí.
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
        // Solo evaluaciones con fecha de registro: descarta los casilleros
        // vacíos (ej. "Examen Sustitutorio" que nunca se rindió) de las
        // notificaciones y de /notas.
        if (!ev.fecha) continue;
        const key = `${codper}:${cursoKey}:${ev.camnot}`;
        currentMap[key] = {
          curso: curso.nombre,
          descripcion: ev.descripcion,
          nota: ev.nota,
          anulada: ev.anulada,
          valor: formatearNota(ev),
          fecha: ev.fecha,
        };
      }
    }

    // Primer chequeo tras registrarse: en vez de guardar el estado en
    // silencio, manda un snapshot de las notas que ya hay hasta ahora.
    let cambios = [];
    if (seeded) {
      const previousMap = last_grades || {};
      for (const [key, ev] of Object.entries(currentMap)) {
        const prev = previousMap[key];
        if (!prev || prev.valor !== ev.valor) cambios.push(ev);
      }
      if (cambios.length > 0) {
        await sendTelegram(
          telegramToken,
          chat_id,
          `🎓 Nueva(s) nota(s) en INTRALU:\n\n${agruparPorCurso(cambios)}`,
        );
      }
    } else {
      const todas = Object.values(currentMap);
      await sendTelegram(
        telegramToken,
        chat_id,
        todas.length > 0
          ? `📋 Estas son tus notas actuales en INTRALU:\n\n${agruparPorCurso(todas)}\n\nDesde ahora te aviso cuando aparezca algo nuevo.`
          : 'Todavía no tienes notas registradas en INTRALU para este ciclo. Desde ahora te aviso cuando aparezca algo nuevo.',
      );
    }

    await supabase
      .from('usuarios')
      .update({
        last_grades: currentMap,
        cursos: cursosMeta,
        seeded: true,
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'snapshot inicial enviado'}`);
  } catch (err) {
    const failures = (usuario.consecutive_failures || 0) + 1;
    console.error(`❌ ${chat_id} (${codigo_uni}): ${err.message}`);

    if (failures >= FAILURE_THRESHOLD) {
      await sendTelegram(
        telegramToken,
        chat_id,
        '⚠️ No pude iniciar sesión en INTRALU con tus credenciales varias veces seguidas. Te desactivé del watcher — usa /registrar para volver a intentarlo.',
        botonRegistrar(),
      ).catch(() => {});
      await supabase.from('usuarios').update({ active: false, consecutive_failures: failures }).eq('id', id);
    } else {
      await supabase.from('usuarios').update({ consecutive_failures: failures }).eq('id', id);
    }
  }
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY o TELEGRAM_TOKEN en .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { count: totalActivos, error: countError } = await supabase
    .from('usuarios')
    .select('*', { count: 'exact', head: true })
    .eq('active', true);
  if (countError) throw countError;

  // Cola por antigüedad: primero los que nunca se revisaron (seeded=false,
  // para no atrasar su primer chequeo), después los más atrasados por
  // updated_at. Un usuario que falla en checkUser() no toca updated_at, así
  // que vuelve a quedar primero en la cola y se reintenta la próxima
  // corrida — no hace falta esperar un "ciclo" completo para reintentarlo.
  // Esto reemplaza el sharding por franjas de tiempo: no depende de que
  // GitHub Actions dispare el cron exactamente cada 5 min (si se atrasa o
  // se salta una corrida, los más atrasados simplemente esperan un poco
  // más, en vez de perderse una franja entera), y no hay nada que se
  // desincronice si el número de usuarios activos cambia entre corridas.
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('active', true)
    .order('seeded', { ascending: true })
    .order('updated_at', { ascending: true })
    .limit(MAX_BATCH_SIZE);
  if (error) throw error;

  console.log(
    totalActivos > usuarios.length
      ? `Revisando los ${usuarios.length} más atrasados de ${totalActivos} usuario(s) activo(s)...`
      : `Revisando ${usuarios.length} usuario(s) activo(s)...`,
  );

  const start = Date.now();
  for (let i = 0; i < usuarios.length; i += CONCURRENCY) {
    const batch = usuarios.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => checkUser(supabase, TELEGRAM_TOKEN, CREDENTIALS_ENCRYPTION_KEY, u)));
  }

  // Tiempo real por usuario de esta corrida — para poder recalibrar
  // SECONDS_PER_USER/RUN_WINDOW_SECONDS con datos reales según crezca la
  // base de usuarios, en vez de asumirlo (ver docs/SCALING.md).
  const elapsedSeconds = (Date.now() - start) / 1000;
  if (usuarios.length > 0) {
    console.log(`Listo en ${elapsedSeconds.toFixed(1)}s (${(elapsedSeconds / usuarios.length).toFixed(1)}s/usuario).`);
  } else {
    console.log('Listo (sin usuarios que revisar).');
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
