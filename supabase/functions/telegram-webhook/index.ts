// Edge Function que recibe los mensajes del bot de Telegram (webhook).
// Solo hace CRUD sobre la tabla `usuarios` + cifra la contraseña antes de
// guardarla. El login real contra INTRALU y el chequeo de notas viven en
// check-all-users.js (Node, corrido por GitHub Actions) — así la lógica de
// scraping existe en un solo lugar, ya probada contra el sitio real. El
// cálculo de fórmulas para /simular vive en docs/simulador.html (Mini App).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encrypt } from './crypto.ts';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const ENCRYPTION_KEY = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY')!;
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente
// en toda Edge Function, no hace falta configurarlos a mano.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Páginas estáticas en GitHub Pages (Supabase Edge Functions no puede
// servir HTML en el plan gratis).
const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;
const SIMULADOR_URL = `${PAGES_BASE}/simulador.html`;
const NOTA_APROBATORIA = 10;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// deno-lint-ignore no-explicit-any
async function sendMessage(chatId: number, text: string, replyMarkup?: any) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

async function deleteMessage(chatId: number, messageId: number) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {
    // Si no se puede borrar (mensaje muy viejo, etc.) no pasa nada grave.
  }
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

// AAAA + dígito de ciclo: 1 primer ciclo, 2 segundo ciclo, 3 verano
// (confirmado por un alumno real de la universidad). Un dígito desconocido
// cae a un formato genérico en vez de inventar un numeral que no existe.
const ROMANOS: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III' };
function etiquetaPeriodo(codper: string): string {
  const anio = codper.slice(0, 4);
  const digito = codper.slice(4);
  return ROMANOS[digito] ? `${anio}-${ROMANOS[digito]}` : `${anio} (ciclo ${digito})`;
}

// Etiqueta compacta solo para los botones de /ciclos (año de 2 dígitos +
// dígito de ciclo, ej. "26-1") — el mensaje con las notas sigue usando
// etiquetaPeriodo() completo.
function etiquetaCorta(codper: string): string {
  return `${codper.slice(2, 4)}-${codper.slice(4)}`;
}

// Responde el toque de un botón para que deje de girar en el cliente de
// Telegram. Con texto muestra un aviso nativo (toast/alerta) sin mandar un
// mensaje aparte al chat — se usa cuando el ciclo no está en caché y hay que
// esperar a que fetch-historial.yml corra, para que no parezca colgado.
async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      text ? { callback_query_id: callbackQueryId, text, show_alert: true } : { callback_query_id: callbackQueryId },
    ),
  });
}

// Dispara fetch-historial.yml (workflow aparte, revisa un solo período de
// un solo usuario) para consultar un ciclo pasado que todavía no está en
// `historial` — best-effort, mismo patrón que dispararChequeoInmediato.
async function dispararFetchHistorial(chatId: number, codper: string) {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows/fetch-historial.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { chat_id: String(chatId), codper } }),
      },
    );
    if (!res.ok) console.error('dispararFetchHistorial:', res.status, await res.text());
  } catch {
    // best-effort, no pasa nada si falla
  }
}

// deno-lint-ignore no-explicit-any
async function manejarCallbackQuery(callbackQuery: any) {
  const data = callbackQuery.data as string | undefined;
  if (!data || !data.startsWith('ciclo:')) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  const codper = data.slice('ciclo:'.length);
  const chatId = callbackQuery.from.id;

  const { data: usuario } = await supabase.from('usuarios').select('historial').eq('chat_id', chatId).maybeSingle();
  if (!usuario) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  const historial = (usuario.historial ?? {}) as Historial;
  const cursosDelPeriodo = historial[codper];

  if (cursosDelPeriodo) {
    await answerCallbackQuery(callbackQuery.id);
    const bloque = agruparPorCurso(cursosDelPeriodo);
    await sendMessage(
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiquetaPeriodo(codper)}:\n\n${bloque}`
        : `No encontré notas registradas en el ciclo ${etiquetaPeriodo(codper)}.`,
    );
  } else {
    await answerCallbackQuery(callbackQuery.id, '🔎 Buscando tus notas de ese ciclo, puede tardar un minuto...');
    await dispararFetchHistorial(chatId, codper);
  }
}

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

const AYUDA = `Notificador de notas UNI (INTRALU)

Comandos:
<b>/registrar</b> — registra o actualiza tu usuario de INTRALU (abre un formulario)
<b>/notas</b> — muestra todas tus notas registradas hasta ahora
<b>/ciclos</b> — consulta tus notas de un ciclo anterior
<b>/simular</b> — simula tu nota final de un curso con las evaluaciones que aún faltan
<b>/estado</b> — ve si estás activo y cuándo se revisó por última vez
<b>/baja</b> — borra tu registro y tu contraseña
<b>/ayuda</b> — este mensaje

🔒 Tu contraseña se guarda cifrada, nunca en texto plano. El formulario
de registro no la deja como mensaje de texto en este chat.`;

type EvaluacionCurso = {
  variable: string;
  descripcion: string;
  nota: number | null;
  anulada: boolean;
  valor: string | null;
  fecha: string | null;
};
// Ya calculado por INTRALU, nunca se recalcula acá — ver
// docs/GRADING-RULES.md#promedios-que-ya-calcula-intralu. Todo llega como
// texto (no número).
type Promedios = { promedio_final?: string; promedio_practicas?: string; nota_asistencia?: string };
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  promedios: Promedios | null;
  evaluaciones: EvaluacionCurso[];
};
// Caché permanente de ciclos pasados ya consultados por /ciclos, clave
// codper — nunca lo toca el chequeo de 5 min (ver
// docs/superpowers/specs/2026-07-16-ciclos-pasados-design.md).
type Historial = Record<string, Record<string, CursoMeta>>;

// 🟢 si el valor es un número >= 10, 🔴 en cualquier otro caso (desaprobado,
// "0A" anulada, "NSP" no se presentó). Telegram no soporta color de texto en
// sus mensajes — esto es lo más parecido que se puede hacer.
function emoji(valor: string): string {
  const n = Number(valor);
  return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
}

// Solo muestra evaluaciones ya calificadas (valor !== null — descarta las
// pendientes, mismo criterio que usa check-all-users.js para /notas y las
// notificaciones). Cierra cada curso con su PP y su promedio ya calculados
// por INTRALU (ver docs/GRADING-RULES.md#promedios-que-ya-calcula-intralu).
// El PP solo se muestra si el curso tiene fórmula de prácticas (algunos no).
function agruparPorCurso(cursos: Record<string, CursoMeta>): string {
  const bloques: string[] = [];
  for (const meta of Object.values(cursos)) {
    const evaluadas = meta.evaluaciones.filter((ev) => ev.valor !== null);
    if (evaluadas.length === 0) continue;
    const lineas = evaluadas.map((e) => `   ${emoji(e.valor!)} ${e.descripcion}: <b>${e.valor}</b>`);
    const pp = meta.formulas?.practicas ? meta.promedios?.promedio_practicas : undefined;
    const final = meta.promedios?.promedio_final;
    const lineaPP = pp != null ? `\n   📊 PP (prácticas): ${emoji(pp)} <b>${pp}</b>` : '';
    const lineaFinal = final != null ? `\n   📊 Promedio del curso: ${emoji(final)} <b>${final}</b>` : '';
    bloques.push(`📘 <b>${meta.nombre}</b>\n${lineas.join('\n')}${lineaPP}${lineaFinal}`);
  }
  return bloques.join('\n\n');
}

function formatearFecha(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-PE', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Lima',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// La fórmula es la fuente de verdad de qué variables hacen falta — no la
// lista de evaluaciones, porque a veces INTRALU todavía ni creó el
// registro de una práctica (la fórmula ya la menciona, el casillero
// todavía no existe). PP se calcula aparte, nunca se pide directamente.
function extraerVariables(formulas: CursoMeta['formulas']): string[] {
  const texto = `${formulas?.practicas ?? ''} ${formulas?.teoria ?? ''}`;
  const tokens = texto.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  const vistas = new Set<string>();
  for (const t of tokens) {
    const upper = t.toUpperCase();
    if (upper === 'MIN' || upper === 'PP') continue;
    vistas.add(upper);
  }
  return Array.from(vistas);
}

// Un curso es "simulable" si alguna variable que su fórmula necesita
// todavía no tiene fecha de registro (o ni existe como evaluación aún), o
// si el Examen Sustitutorio sigue disponible (no aparece en la fórmula,
// es una regla aparte: reemplaza tu peor nota entre Parcial y Final).
function tienePendientes(meta: CursoMeta): boolean {
  const evalPorVariable = new Map(meta.evaluaciones.map((ev) => [ev.variable.toUpperCase(), ev]));
  const faltaDeFormula = extraerVariables(meta.formulas).some((v) => {
    const ev = evalPorVariable.get(v);
    return !ev || !ev.fecha;
  });
  const es = evalPorVariable.get('ES');
  return faltaDeFormula || Boolean(es && !es.fecha);
}

function botonSimular(codcur: string) {
  return { inline_keyboard: [[{ text: '📐 Abrir simulador', web_app: { url: `${SIMULADOR_URL}?curso=${codcur}` } }]] };
}

Deno.serve(async (req) => {
  const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
  if (secretHeader !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const update = await req.json();

  if (update.callback_query) {
    await manejarCallbackQuery(update.callback_query);
    return new Response('ok');
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return new Response('ok');
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/start' || text === '/ayuda' || text === '/help') {
    await sendMessage(chatId, AYUDA, text === '/start' ? botonRegistrar() : undefined);
  } else if (text.startsWith('/registrar')) {
    const partes = text.split(/\s+/).filter(Boolean);
    const codigo = partes[1];
    const password = partes.slice(2).join(' ');

    if (!codigo || !password) {
      await sendMessage(
        chatId,
        'Toca el botón para registrarte con un formulario (recomendado), o escribe:\n/registrar CODIGO CONTRASEÑA',
        botonRegistrar(),
      );
    } else {
      const passwordEncrypted = await encrypt(password, ENCRYPTION_KEY);
      const { error } = await supabase.from('usuarios').upsert(
        {
          chat_id: chatId,
          codigo_uni: codigo.toUpperCase(),
          password_encrypted: passwordEncrypted,
          active: true,
          consecutive_failures: 0,
          last_grades: {},
          cursos: {},
          seeded: false,
        },
        { onConflict: 'chat_id' },
      );

      await deleteMessage(chatId, message.message_id);

      if (error) {
        console.error(error);
        await sendMessage(chatId, '❌ No pude guardar tu registro, intenta de nuevo en un rato.');
      } else {
        await dispararChequeoInmediato();
        await sendMessage(
          chatId,
          `✅ Registrado con código <b>${codigo.toUpperCase()}</b>.\n\nYa estoy revisando tus notas — te mando tu estado actual por acá en cuanto termine.\nSi tu código o contraseña están mal, te aviso aquí también.`,
        );
      }
    }
  } else if (text === '/baja') {
    await supabase.from('usuarios').delete().eq('chat_id', chatId);
    await sendMessage(chatId, '🗑️ Listo, borré tu registro y tu contraseña.');
  } else if (text === '/estado') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const evaluaciones = Object.keys(data.last_grades ?? {}).length;
      await sendMessage(
        chatId,
        [
          '📌 Estado de tu cuenta',
          '',
          `Código: <b>${data.codigo_uni}</b>`,
          `Activo: ${data.active ? '🟢 sí' : '🔴 no (tu contraseña parece estar mal)'}`,
          `Evaluaciones registradas: <b>${evaluaciones}</b>`,
          `Última actualización: ${formatearFecha(data.updated_at)}`,
        ].join('\n'),
        data.active ? undefined : botonRegistrar(),
      );
    }
  } else if (text === '/notas') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const cursos = (data.cursos ?? {}) as Record<string, CursoMeta>;
      const bloque = agruparPorCurso(cursos);
      if (!bloque) {
        await sendMessage(chatId, 'Todavía no tienes notas registradas.');
      } else {
        await sendMessage(chatId, `📋 Tus notas (ciclo actual):\n\n${bloque}`);
      }
    }
  } else if (text === '/ciclos') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const periodos = (data.periodos_disponibles ?? []) as string[];
      if (periodos.length === 0) {
        await sendMessage(
          chatId,
          'Todavía no tengo la lista de tus ciclos — espera al próximo chequeo (cada 5 min) e intenta de nuevo.',
        );
      } else {
        const botones = periodos.map((codper) => ({ text: etiquetaCorta(codper), callback_data: `ciclo:${codper}` }));
        const filas = [];
        for (let i = 0; i < botones.length; i += 4) filas.push(botones.slice(i, i + 4));
        await sendMessage(chatId, '📚 Elige un ciclo para ver tus notas de ese período:', { inline_keyboard: filas });
      }
    }
  } else if (text.startsWith('/simular')) {
    const partes = text.split(/\s+/).filter(Boolean);
    const codcurArg = partes[1]?.toUpperCase();

    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const cursos = (data.cursos ?? {}) as Record<string, CursoMeta>;
      const simulables = Object.entries(cursos).filter(([, meta]) => tienePendientes(meta));

      if (codcurArg) {
        const encontrado = simulables.find(([key]) => key.startsWith(`${codcurArg}-`));
        if (!encontrado) {
          await sendMessage(
            chatId,
            `No encontré "${codcurArg}" con notas pendientes para simular. Escribe /simular sin argumentos para ver la lista.`,
          );
        } else {
          const [, meta] = encontrado;
          await sendMessage(chatId, `📐 ${meta.nombre}`, botonSimular(codcurArg));
        }
      } else if (simulables.length === 0) {
        await sendMessage(chatId, 'No tengo cursos con notas pendientes para simular todavía.');
      } else {
        const botones = simulables.map(([key, meta]) => [
          { text: meta.nombre, web_app: { url: `${SIMULADOR_URL}?curso=${key.split('-')[0]}` } },
        ]);
        await sendMessage(chatId, '📐 Elige un curso para simular:', { inline_keyboard: botones });
      }
    }
  } else {
    await sendMessage(chatId, 'No entendí ese comando. Usa /ayuda para ver la lista.');
  }

  return new Response('ok');
});
