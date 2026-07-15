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

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

const AYUDA = `Notificador de notas UNI (INTRALU)

Comandos:
/registrar — registra o actualiza tu usuario de INTRALU (abre un formulario)
/notas — muestra todas tus notas registradas hasta ahora
/simular — simula tu nota final de un curso con las evaluaciones que aún faltan
/estado — ve si estás activo y cuándo se revisó por última vez
/baja — borra tu registro y tu contraseña
/ayuda — este mensaje

Tu contraseña se guarda cifrada, nunca en texto plano. El formulario de
registro no la deja como mensaje de texto en este chat.`;

type Evaluacion = { curso: string; descripcion: string; nota: number | null; valor: string; anulada: boolean };
type EvaluacionCurso = { variable: string; descripcion: string; nota: number | null; anulada: boolean; fecha: string | null };
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  evaluaciones: EvaluacionCurso[];
};

// 🟢 si el valor es un número >= 10, 🔴 en cualquier otro caso (desaprobado,
// "0A" anulada, "NSP" no se presentó). Telegram no soporta color de texto en
// sus mensajes — esto es lo más parecido que se puede hacer.
function emoji(valor: string): string {
  const n = Number(valor);
  return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
}

function agruparPorCurso(evaluaciones: Evaluacion[]): string {
  const porCurso = new Map<string, Evaluacion[]>();
  for (const ev of evaluaciones) {
    if (!porCurso.has(ev.curso)) porCurso.set(ev.curso, []);
    porCurso.get(ev.curso)!.push(ev);
  }
  const bloques: string[] = [];
  for (const [curso, evs] of porCurso) {
    const lineas = evs.map((e) => `   ${emoji(e.valor)} ${e.descripcion}: <b>${e.valor}</b>`);
    bloques.push(`📘 <b>${curso}</b>\n${lineas.join('\n')}`);
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
        await sendMessage(
          chatId,
          `✅ Registrado con código ${codigo.toUpperCase()}. En los próximos minutos hago la primera revisión para guardar tu estado actual (sin avisarte nada todavía) — si tu código o contraseña están mal, te aviso aquí. Desde la revisión siguiente ya te aviso solo de notas nuevas de verdad.`,
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
          `Código: ${data.codigo_uni}`,
          `Activo: ${data.active ? 'sí' : 'no (tu contraseña parece estar mal, usa /registrar de nuevo)'}`,
          `Evaluaciones registradas: ${evaluaciones}`,
          `Última actualización: ${formatearFecha(data.updated_at)}`,
        ].join('\n'),
      );
    }
  } else if (text === '/notas') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const evaluaciones = Object.values(data.last_grades ?? {}) as Evaluacion[];
      if (evaluaciones.length === 0) {
        await sendMessage(chatId, 'Todavía no tienes notas registradas.');
      } else {
        await sendMessage(chatId, `📋 Tus notas (ciclo actual):\n\n${agruparPorCurso(evaluaciones)}`);
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
