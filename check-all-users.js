require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota, CredentialError, isNetworkError } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso } = require('./lib/notificaciones');
const { markIntraluDown, markIntraluUp, isIntraluDown } = require('./lib/service-status');
const fs = require('fs');

const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;
const FAILURE_THRESHOLD = 3;

// Que INTRALU rechace un login NO prueba que la contraseña esté mal. El
// 2026-08-17 el sitio le contestó "Acercarse a admisión para actualizar sus
// datos" a todo el mundo — un flag que debía apuntar solo a ingresantes — y
// el watcher desactivó a todos sus usuarios en 3 minutos. Mirar el texto del
// mensaje no sirve de defensa: la universidad lo cambia cuando quiere.
//
// Lo que sí separa un caso del otro es el tiempo. Una contraseña mala no se
// arregla sola; un desperfecto del sitio sí. 48h cubre de sobra cualquier
// desperfecto (el de ese día duró ~2h) incluido uno que empiece un viernes a
// la noche y no lo toque nadie hasta el lunes. El costo de esperar es solo
// que a quien de verdad cambió su contraseña se le avisa al segundo día.
const MIN_FAILURE_WINDOW_MS = 48 * 60 * 60 * 1000;

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

// Modo usado por .github/workflows/check-new-registration.yml: en vez de la
// cola completa por antigüedad, solo revisa a los recién registrados
// (seeded=false). Lo dispara telegram-webhook/registro-webapp apenas alguien
// se registra, en un workflow aparte con su propio concurrency group — así
// no se encola detrás de la cadena de 5 min de check-grade.yml (ver
// docs/SCALING.md). Tope chico porque en la práctica son 0-1 personas a la
// vez; el tope es solo para acotar el peor caso ante una ráfaga de registros.
const SOLO_NUEVOS = process.env.SOLO_NUEVOS === 'true';
const MAX_NUEVOS = 20;

const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

// Un rechazo de login es del sitio, y no de las credenciales, si en toda la
// corrida NADIE pudo entrar. Pide al menos 2 rechazados porque con un solo
// usuario activo "no entró nadie" es exactamente lo mismo que "su contraseña
// está mal" — ahí la única señal que queda es el tiempo (debeDesactivar).
function esRechazoSistemico(rechazados, loginsOk) {
  return loginsOk === 0 && rechazados >= 2;
}

// Desactivar pide las dos cosas: varios rechazos seguidos Y que haga rato
// que no se logra entrar. Lo segundo es lo que evita que un desperfecto del
// sitio se lleve puestos a los usuarios (ver MIN_FAILURE_WINDOW_MS): el
// 2026-08-17 los 3 rechazos entraron en 3 minutos porque el ciclo corto de
// 60s los acumuló a toda velocidad.
//
// `ultimoExito` es el updated_at del usuario, que ya significa exactamente
// eso: solo lo toca el chequeo que entró bien (para alguien que nunca entró,
// es su fecha de registro). Por eso esto no necesita columna nueva.
function debeDesactivar(failures, ultimoExito, ahora = Date.now()) {
  if (failures < FAILURE_THRESHOLD || !ultimoExito) return false;
  return ahora - new Date(ultimoExito).getTime() >= MIN_FAILURE_WINDOW_MS;
}

async function checkUser(supabase, telegramToken, encryptionKey, usuario) {
  const { id, chat_id, codigo_uni, password_encrypted, last_grades, seeded } = usuario;

  try {
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const { codper, csrfToken, cursos, periodos } = await fetchCursosMatriculados(client);

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
          cursoKey,
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
          `🎓 Nueva(s) nota(s) en INTRALU:\n\n${agruparPorCurso(cambios, cursosMeta)}`,
        );
      }
    } else {
      const todas = Object.values(currentMap);
      await sendTelegram(
        telegramToken,
        chat_id,
        todas.length > 0
          ? `📋 Estas son tus notas actuales en INTRALU:\n\n${agruparPorCurso(todas, cursosMeta)}\n\nDesde ahora te aviso cuando aparezca algo nuevo.`
          : 'Todavía no tienes notas registradas en INTRALU para este ciclo. Desde ahora te aviso cuando aparezca algo nuevo.',
      );
    }

    await supabase
      .from('usuarios')
      .update({
        last_grades: currentMap,
        cursos: cursosMeta,
        periodos_disponibles: periodos,
        seeded: true,
        consecutive_failures: 0,
        network_issue_notified: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    await markIntraluUp(supabase, telegramToken, process.env.ADMIN_CHAT_ID);

    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'snapshot inicial enviado'}`);
    return 'ok';
  } catch (err) {
    if (isNetworkError(err)) {
      // INTRALU inalcanzable (ECONNREFUSED, timeout, DNS) — no es culpa del
      // usuario ni cuenta hacia la desactivación. El cron siguiente lo
      // reintenta solo (no se toca updated_at, ver cola en main()). A
      // diferencia de un error desconocido, esto sí se avisa: al admin
      // siempre (deduplicado), y al usuario una sola vez si es su primer
      // chequeo tras registrarse.
      console.error(`🔴 ${chat_id} (${codigo_uni}): ${err.message}`);
      await markIntraluDown(supabase, telegramToken, process.env.ADMIN_CHAT_ID);

      if (!seeded) {
        // Update atómico como filtro de carrera (mismo patrón que
        // markIntraluDown/markIntraluUp): check-grade.yml y
        // check-new-registration.yml corren en concurrency groups
        // separados, así que pueden revisar al mismo usuario nuevo casi
        // simultáneamente. Solo la corrida cuyo UPDATE efectivamente
        // cambió la fila (data no vacío) manda el mensaje — la otra ve
        // 0 filas y no avisa dos veces.
        const { data } = await supabase
          .from('usuarios')
          .update({ network_issue_notified: true })
          .eq('id', id)
          .eq('network_issue_notified', false)
          .select();
        if (data && data.length > 0) {
          await sendTelegram(
            telegramToken,
            chat_id,
            '⏳ INTRALU no está respondiendo en este momento (a veces tarda horas en normalizarse). Te aviso apenas pueda revisar tus notas — no hace falta que hagas nada.',
          ).catch(() => {});
        }
      }
      return null;
    }

    if (!(err instanceof CredentialError)) {
      // Timeout de otro tipo, HTML cambiado, etc. — no es un fallo de
      // credenciales ni de red, así que no cuenta hacia la desactivación. El
      // cron siguiente lo reintenta solo (ver comentario sobre la cola en main()).
      console.error(`⏳ ${chat_id} (${codigo_uni}): ${err.message}`);
      return null;
    }

    // El sitio contestó (nos redirigió a /login), así que está en pie aunque
    // no nos deje entrar. Sin esto, una tanda entera de rechazos deja
    // is_down=true colgado y check-grade.yml se queda encadenando corridas
    // cada 60s para siempre. Los rechazos no se resuelven acá: recién al
    // final de la corrida se sabe si fueron de las credenciales o del sitio.
    await markIntraluUp(supabase, telegramToken, process.env.ADMIN_CHAT_ID);
    console.error(`❌ ${chat_id} (${codigo_uni}): ${err.message}`);
    return 'rechazado';
  }
}

// Resuelve los logins que INTRALU rechazó, una vez que terminó toda la
// corrida y se sabe si alguien más sí pudo entrar.
async function aplicarStrikes(supabase, telegramToken, resultados) {
  const rechazados = resultados.filter((r) => r.resultado === 'rechazado');
  if (rechazados.length === 0) return;

  const loginsOk = resultados.filter((r) => r.resultado === 'ok').length;
  const sistemico = esRechazoSistemico(rechazados.length, loginsOk);
  if (sistemico) {
    // ponytail: solo queda en el log. Si esto se repite corrida tras
    // corrida durante días, es que INTRALU invalidó las credenciales de
    // todos en serio y hay que ir a mirar — avisar al admin sin spamear
    // cada 5 min pide otra máquina de estados como la de service_status.
    console.error(
      `🟠 INTRALU rechazó a los ${rechazados.length} usuario(s) revisados y no dejó entrar a nadie: parece un problema del sitio, no de sus credenciales. No se desactiva a nadie.`,
    );
  }

  const ahora = Date.now();
  for (const { usuario } of rechazados) {
    const failures = (usuario.consecutive_failures || 0) + 1;
    const desactivar = !sistemico && debeDesactivar(failures, usuario.updated_at, ahora);

    if (desactivar) {
      await sendTelegram(
        telegramToken,
        usuario.chat_id,
        '⚠️ Llevo dos días sin poder iniciar sesión en INTRALU con tus credenciales. Te desactivé del watcher — si cambiaste tu contraseña, usa /registrar para volver a activarlo.',
        botonRegistrar(),
      ).catch(() => {});
    }

    await supabase
      .from('usuarios')
      .update({ consecutive_failures: failures, ...(desactivar ? { active: false } : {}) })
      .eq('id', usuario.id);
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
  const query = supabase.from('usuarios').select('*').eq('active', true);
  const { data: usuarios, error } = SOLO_NUEVOS
    ? await query.eq('seeded', false).limit(MAX_NUEVOS)
    : await query.order('seeded', { ascending: true }).order('updated_at', { ascending: true }).limit(MAX_BATCH_SIZE);
  if (error) throw error;

  console.log(
    SOLO_NUEVOS
      ? `Revisando ${usuarios.length} usuario(s) recién registrado(s)...`
      : totalActivos > usuarios.length
        ? `Revisando los ${usuarios.length} más atrasados de ${totalActivos} usuario(s) activo(s)...`
        : `Revisando ${usuarios.length} usuario(s) activo(s)...`,
  );

  const start = Date.now();
  const resultados = [];
  for (let i = 0; i < usuarios.length; i += CONCURRENCY) {
    const batch = usuarios.slice(i, i + CONCURRENCY);
    const res = await Promise.all(batch.map((u) => checkUser(supabase, TELEGRAM_TOKEN, CREDENTIALS_ENCRYPTION_KEY, u)));
    resultados.push(...res.map((resultado, j) => ({ usuario: batch[j], resultado })));
  }

  await aplicarStrikes(supabase, TELEGRAM_TOKEN, resultados);

  // Tiempo real por usuario de esta corrida — para poder recalibrar
  // SECONDS_PER_USER/RUN_WINDOW_SECONDS con datos reales según crezca la
  // base de usuarios, en vez de asumirlo (ver docs/SCALING.md).
  const elapsedSeconds = (Date.now() - start) / 1000;
  if (usuarios.length > 0) {
    console.log(`Listo en ${elapsedSeconds.toFixed(1)}s (${(elapsedSeconds / usuarios.length).toFixed(1)}s/usuario).`);
  } else {
    console.log('Listo (sin usuarios que revisar).');
  }

  // Le dice al step "Encadenar la siguiente corrida" de check-grade.yml si
  // debe usar el ciclo corto (60s) en vez del normal (300s) — ver ese
  // workflow. GITHUB_OUTPUT no existe corriendo local (ej. pnpm run
  // check-all a mano), así que esto es un no-op fuera de Actions.
  const down = await isIntraluDown(supabase);
  console.log(down ? '🔴 INTRALU sigue caído.' : '🟢 INTRALU está respondiendo.');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `intralu_down=${down}\n`);
  }
}

module.exports = { esRechazoSistemico, debeDesactivar, FAILURE_THRESHOLD, MIN_FAILURE_WINDOW_MS };

// Solo corre si lo invocan directo, no cuando test/desactivacion.test.js lo
// importa para probar las funciones puras.
if (require.main === module) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
