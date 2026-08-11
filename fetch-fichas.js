require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchFichas, descargarFicha, CredentialError, isNetworkError } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, sendDocument } = require('./lib/notificaciones');

// Los títulos traen tildes y espacios; Telegram muestra el filename tal
// cual, así que conviene algo prolijo y sin acentos. NFD + quitar los
// diacríticos es la forma stdlib de hacerlo, sin dependencias.
function nombreArchivo(nombre) {
  const base = nombre
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}.pdf`;
}

// Corrido por .github/workflows/descargar-fichas.yml, disparado por
// telegram-webhook cuando alguien toca el botón de una ficha en /fichas.
// Baja UNA ficha de UN usuario por corrida y la manda como adjunto — nada se
// persiste, los bytes se van con el runner (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md).
//
// FICHA_ID es el último segmento de la URL de la ficha (ej.
// "ficha-academica-pdf"). Nunca se concatena a una URL: se usa para buscar
// entre las fichas que la página realmente ofrece, así que un valor basura
// no puede apuntar el scraper a ningún lado.
async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    CREDENTIALS_ENCRYPTION_KEY,
    TELEGRAM_TOKEN,
    CHAT_ID,
    FICHA_ID,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN || !CHAT_ID || !FICHA_ID) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN, CHAT_ID o FICHA_ID en el entorno');
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
    const fichas = await fetchFichas(client);
    const ficha = fichas.find((f) => f.url.endsWith(`/${FICHA_ID}`));

    // La lista de fichas cambia: el 2026-08-11 la página pasó de 7 tarjetas
    // a 6 en unas horas. Si la que pidió ya no está, se le dice qué hay
    // ahora en vez de un error seco.
    if (!ficha) {
      const disponibles = fichas.map((f) => `• ${f.nombre}`).join('\n');
      await sendTelegram(
        TELEGRAM_TOKEN,
        chatId,
        disponibles
          ? `⚠️ INTRALU ya no está ofreciendo esa ficha.\n\nAhora mismo tiene disponibles:\n${disponibles}\n\nUsa /fichas para ver los botones actualizados.`
          : '⚠️ INTRALU no está ofreciendo ninguna ficha en este momento. Intenta de nuevo más tarde.',
      );
      console.log(`⚠️ chat_id ${chatId}: ${FICHA_ID} no está en la página (${fichas.length} disponibles)`);
      return;
    }

    const pdf = await descargarFicha(client, ficha.url);
    if (!pdf) {
      await sendTelegram(
        TELEGRAM_TOKEN,
        chatId,
        `❌ INTRALU no pudo generar <b>${ficha.nombre}</b> en este momento.\n\nEsto falla del lado de ellos, no es tu cuenta — a veces la misma ficha funciona un rato después. Intenta de nuevo más tarde.`,
      );
      console.log(`❌ chat_id ${chatId}: ${ficha.nombre} no devolvió un PDF`);
      return;
    }

    await sendDocument(TELEGRAM_TOKEN, chatId, pdf, nombreArchivo(ficha.nombre), `📄 ${ficha.nombre}`);
    console.log(`✅ chat_id ${chatId}: ${ficha.nombre} enviada (${(pdf.byteLength / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error(`❌ chat_id ${chatId}:`, err.message);

    // El usuario no necesita ver "timeout of 20000ms exceeded" ni otros
    // detalles técnicos — el mensaje crudo (err.message) queda solo en el
    // log de GitHub Actions (arriba) para diagnóstico.
    let mensaje;
    if (isNetworkError(err)) {
      mensaje = '❌ No pude conectarme a INTRALU para traer esa ficha — el sitio no está respondiendo en este momento. Intenta de nuevo más tarde.';
    } else if (err instanceof CredentialError) {
      mensaje = '❌ No pude iniciar sesión en INTRALU para traer esa ficha. Revisa tu código y contraseña con /registrar.';
    } else {
      mensaje = '❌ No pude traer esa ficha. Intenta de nuevo más tarde.';
    }

    await sendTelegram(TELEGRAM_TOKEN, chatId, mensaje).catch(() => {});
    process.exit(1);
  }
}

module.exports = { nombreArchivo };

// Solo corre si lo invocan directo (`node fetch-fichas.js`), no cuando
// test/fichas.test.js lo importa para probar nombreArchivo.
if (require.main === module) main();
