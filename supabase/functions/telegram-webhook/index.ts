// Edge Function que recibe los mensajes del bot de Telegram (webhook).
// Solo hace CRUD sobre la tabla `usuarios` + cifra la contraseña antes de
// guardarla. El login real contra INTRALU y el chequeo de notas viven en
// check-all-users.js (Node, corrido por GitHub Actions) — así la lógica de
// scraping existe en un solo lugar, ya probada contra el sitio real.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encrypt } from './crypto.ts';
import { evaluarFormula, minimoParaAprobar } from './formula.ts';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const ENCRYPTION_KEY = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY')!;
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente
// en toda Edge Function, no hace falta configurarlos a mano.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Página estática en GitHub Pages (Supabase Edge Functions no puede servir
// HTML en el plan gratis). El formulario le pega a registro-webapp por API.
const REGISTRO_WEBAPP_URL = 'https://alexis0800.github.io/uni-notas-watcher/registro.html';
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
/simular — calcula qué necesitas en el Examen Final para aprobar
/estado — ve si estás activo y cuándo se revisó por última vez
/baja — borra tu registro y tu contraseña
/ayuda — este mensaje

Tu contraseña se guarda cifrada, nunca en texto plano. El formulario de
registro no la deja como mensaje de texto en este chat.`;

type Evaluacion = { curso: string; descripcion: string; nota: number | null; valor: string; anulada: boolean };
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  // deno-lint-ignore no-explicit-any
  promedios: any;
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

// El "key" de cada evaluación en last_grades es "codper:codcur-seccion:camnot".
function variableDeKey(key: string): string {
  const camnot = Number(key.split(':')[2]);
  if (camnot === 13) return 'EP';
  if (camnot === 14) return 'EF';
  if (camnot === 15) return 'ES';
  return `N${camnot}`;
}

function construirVariables(
  lastGrades: Record<string, Evaluacion>,
  cursoKey: string,
): { vars: Record<string, number>; faltantes: string[] } {
  const vars: Record<string, number> = {};
  const faltantes: string[] = [];
  for (const [key, ev] of Object.entries(lastGrades)) {
    if (key.split(':')[1] !== cursoKey) continue;
    const variable = variableDeKey(key);
    if (ev.anulada) {
      vars[variable] = 0; // anulada cuenta como 0 para la fórmula
    } else if (ev.nota === null) {
      faltantes.push(variable);
    } else {
      vars[variable] = ev.nota;
    }
  }
  return { vars, faltantes };
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
    const valorArg = partes[2] !== undefined ? Number(partes[2]) : undefined;

    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    const cursos = (data?.cursos ?? {}) as Record<string, CursoMeta>;
    const lastGrades = (data?.last_grades ?? {}) as Record<string, Evaluacion>;

    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else if (!codcurArg) {
      const lineas: string[] = [];
      for (const [cursoKey, meta] of Object.entries(cursos)) {
        if (!meta.formulas?.teoria || !meta.formulas.teoria.toUpperCase().includes('EF')) continue;
        const codcur = cursoKey.split('-')[0];
        const { faltantes } = construirVariables(lastGrades, cursoKey);
        const soloFaltaEF = faltantes.length === 1 && faltantes[0] === 'EF';
        if (soloFaltaEF) lineas.push(`• ${codcur} — ${meta.nombre}: /simular ${codcur} [NOTA]`);
        else if (faltantes.length > 0) lineas.push(`• ${codcur} — ${meta.nombre}: faltan ${faltantes.join(', ')}`);
      }
      if (lineas.length === 0) {
        await sendMessage(chatId, 'No tengo cursos con Examen Final pendiente para simular todavía.');
      } else {
        await sendMessage(
          chatId,
          `Uso: /simular CODIGO_CURSO [NOTA]\n(sin NOTA te digo el mínimo que necesitas)\n\n${lineas.join('\n')}`,
        );
      }
    } else {
      const cursoKey = Object.keys(cursos).find((k) => k.startsWith(`${codcurArg}-`));
      const meta = cursoKey ? cursos[cursoKey] : null;

      if (!cursoKey || !meta) {
        await sendMessage(chatId, `No encontré el curso "${codcurArg}". Escribe /simular sin argumentos para ver la lista.`);
      } else if (!meta.formulas?.teoria || !meta.formulas.teoria.toUpperCase().includes('EF')) {
        await sendMessage(chatId, `${meta.nombre} no tiene Examen Final en su fórmula, no hay nada que simular.`);
      } else {
        const { vars, faltantes } = construirVariables(lastGrades, cursoKey);
        const faltantesSinEF = faltantes.filter((f) => f !== 'EF');

        if (faltantesSinEF.length > 0) {
          await sendMessage(chatId, `Todavía faltan notas de ${meta.nombre} para poder simular: ${faltantesSinEF.join(', ')}.`);
        } else {
          try {
            if (meta.formulas.practicas) vars.PP = evaluarFormula(meta.formulas.practicas, vars);

            if (valorArg !== undefined) {
              if (Number.isNaN(valorArg) || valorArg < 0 || valorArg > 20) {
                await sendMessage(chatId, 'La nota tiene que ser un número entre 0 y 20.');
              } else {
                const final = evaluarFormula(meta.formulas.teoria, { ...vars, EF: valorArg });
                const aprueba = final >= NOTA_APROBATORIA;
                await sendMessage(
                  chatId,
                  `📐 <b>${meta.nombre}</b>\nSi sacas <b>${valorArg}</b> en el Examen Final, tu nota final sería ` +
                    `aproximadamente <b>${final.toFixed(2)}</b> ${aprueba ? '🟢 (aprobarías)' : '🔴 (no alcanzaría)'}.\n\n` +
                    `<i>Cálculo aproximado con la fórmula de INTRALU, puede diferir un poco por redondeos del sistema.</i>`,
                );
              }
            } else {
              const sim = minimoParaAprobar(meta.formulas.teoria, vars, 'EF', NOTA_APROBATORIA);
              let texto: string;
              if (sim.yaAprobado) {
                texto = `🟢 Con lo que ya tienes en <b>${meta.nombre}</b>, apruebas pase lo que pase en el Examen Final.`;
              } else if (sim.alcanza) {
                texto = `📐 <b>${meta.nombre}</b>: necesitas al menos <b>${sim.minimo}</b> en el Examen Final para aprobar (aproximado).`;
              } else {
                texto = `🔴 <b>${meta.nombre}</b>: ni sacando 20 en el Examen Final alcanzas a aprobar (aproximado).`;
              }
              await sendMessage(chatId, texto);
            }
          } catch (err) {
            console.error(err);
            await sendMessage(chatId, 'No pude calcular la fórmula de ese curso.');
          }
        }
      }
    }
  } else {
    await sendMessage(chatId, 'No entendí ese comando. Usa /ayuda para ver la lista.');
  }

  return new Response('ok');
});
