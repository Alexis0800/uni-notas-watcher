require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');

const CONCURRENCY = 5;
const FAILURE_THRESHOLD = 3;
const NOTA_APROBATORIA = 10;

async function sendTelegram(token, chatId, text) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
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

    // Primer chequeo tras registrarse: guarda el estado base sin notificar,
    // para no avisar "nota nueva" de notas que la persona ya tenía antes.
    let cambios = [];
    if (seeded) {
      const previousMap = last_grades || {};
      for (const [key, ev] of Object.entries(currentMap)) {
        const prev = previousMap[key];
        if (!prev || prev.valor !== ev.valor) cambios.push(ev);
      }
    }

    if (cambios.length > 0) {
      await sendTelegram(
        telegramToken,
        chat_id,
        `🎓 Nueva(s) nota(s) en INTRALU:\n\n${agruparPorCurso(cambios)}`,
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

    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'estado base guardado'}`);
  } catch (err) {
    const failures = (usuario.consecutive_failures || 0) + 1;
    console.error(`❌ ${chat_id} (${codigo_uni}): ${err.message}`);

    if (failures >= FAILURE_THRESHOLD) {
      await sendTelegram(
        telegramToken,
        chat_id,
        '⚠️ No pude iniciar sesión en INTRALU con tus credenciales varias veces seguidas. Te desactivé del watcher — usa /registrar para volver a intentarlo.',
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
  const { data: usuarios, error } = await supabase.from('usuarios').select('*').eq('active', true);
  if (error) throw error;

  console.log(`Revisando ${usuarios.length} usuario(s) activo(s)...`);

  for (let i = 0; i < usuarios.length; i += CONCURRENCY) {
    const batch = usuarios.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => checkUser(supabase, TELEGRAM_TOKEN, CREDENTIALS_ENCRYPTION_KEY, u)));
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
