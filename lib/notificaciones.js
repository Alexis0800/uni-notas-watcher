const axios = require('axios');

const NOTA_APROBATORIA = 10;

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

function emojiValor(valor) {
  const n = Number(valor);
  return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
}

// Agrupa evaluaciones por curso para que el nombre del curso no se repita
// en cada línea — una vez el curso, las evaluaciones sangradas debajo.
// Cierra cada bloque con el PP y el promedio del curso que ya calcula
// INTRALU (cursosMeta[cursoKey].promedios, ver docs/GRADING-RULES.md) —
// nunca se recalcula acá, así nadie tiene que sacar la cuenta a mano. El PP
// solo se muestra si el curso tiene fórmula de prácticas (algunos no).
function agruparPorCurso(evaluaciones, cursosMeta) {
  const porCurso = new Map();
  for (const ev of evaluaciones) {
    if (!porCurso.has(ev.cursoKey)) porCurso.set(ev.cursoKey, []);
    porCurso.get(ev.cursoKey).push(ev);
  }
  const bloques = [];
  for (const [cursoKey, evs] of porCurso) {
    const lineas = evs.map((e) => `   ${emoji(e)} ${e.descripcion}: <b>${e.valor}</b>`);
    const meta = cursosMeta[cursoKey];
    const pp = meta?.formulas?.practicas ? meta?.promedios?.promedio_practicas : null;
    const final = meta?.promedios?.promedio_final;
    const lineaPP = pp != null ? `\n   📊 PP (prácticas): ${emojiValor(pp)} <b>${pp}</b>` : '';
    const lineaFinal = final != null ? `\n   📊 Promedio del curso: ${emojiValor(final)} <b>${final}</b>` : '';
    bloques.push(`📘 <b>${evs[0].curso}</b>\n${lineas.join('\n')}${lineaPP}${lineaFinal}`);
  }
  return bloques.join('\n\n');
}

// AAAA + dígito de ciclo: 1 primer ciclo, 2 segundo ciclo, 3 verano
// (confirmado por un alumno real de la universidad). Un dígito desconocido
// (ej. un hipotético "0") cae a un formato genérico en vez de inventar un
// numeral que no existe.
const ROMANOS = { '1': 'I', '2': 'II', '3': 'III' };
function etiquetaPeriodo(codper) {
  const anio = codper.slice(0, 4);
  const digito = codper.slice(4);
  return ROMANOS[digito] ? `${anio}-${ROMANOS[digito]}` : `${anio} (ciclo ${digito})`;
}

module.exports = { sendTelegram, emoji, emojiValor, agruparPorCurso, etiquetaPeriodo, NOTA_APROBATORIA };
