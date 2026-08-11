require('dotenv').config();
const cheerio = require('cheerio');
const { login, BASE_URL } = require('./lib/session');

// Diagnóstico local (mismo patrón que login-test.js, ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md#testing):
// loguea con el .env real, lista las fichas de /informacion-academica/fichas
// y baja cada PDF para confirmar tipo y tamaño. No toca Supabase ni Telegram.

// Esta función es el scraping real que después va a lib/session.js: cada
// ficha es una tarjeta con su título y un <a> a un PDF. Se leen del HTML en
// vez de hardcodear las 7 URLs porque no sabemos si la lista es igual para
// todos los alumnos (ej. constancia de matrícula fuera de fecha).
async function fetchFichas(client) {
  const res = await client.get(`${BASE_URL}/informacion-academica/fichas`);
  const $ = cheerio.load(res.data);

  return $('a[href*="-pdf"]')
    .map((_, a) => ({
      nombre: $(a).closest('.card').find('.card-title').text().trim(),
      url: $(a).attr('href'),
    }))
    .get()
    .filter((f) => f.nombre);
}

async function main() {
  const codigo = process.env.UNI_CODIGO;
  const password = process.env.UNI_PASSWORD;
  if (!codigo || !password) {
    console.error('❌ Falta UNI_CODIGO o UNI_PASSWORD en .env');
    process.exit(1);
  }

  try {
    const client = await login(codigo, password);
    const fichas = await fetchFichas(client);
    console.log(`✅ ${fichas.length} ficha(s) encontrada(s). Descargando con la misma sesión...\n`);

    for (const ficha of fichas) {
      // arraybuffer o axios interpreta el PDF como texto UTF-8 y lo corrompe.
      // timeout propio (60s) porque INTRALU genera estos PDFs al vuelo y los
      // 20s de newClient() pueden quedarse cortos.
      const t0 = Date.now();
      const res = await client.get(ficha.url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true,
      });
      const kb = (res.data.byteLength / 1024).toFixed(0);
      const esPdf = Buffer.from(res.data.slice(0, 4)).toString() === '%PDF';
      console.log(
        `${esPdf ? '✅' : '⚠️ '} ${ficha.nombre}: ${res.status} ${res.headers['content-type']} — ${kb} KB, ${Date.now() - t0} ms${esPdf ? '' : ' (NO empieza con %PDF)'}`,
      );
    }
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

main();
