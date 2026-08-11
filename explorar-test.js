require('dotenv').config();
const fs = require('fs');
const cheerio = require('cheerio');
const { login, BASE_URL } = require('./lib/session');

// Diagnóstico local, solo lectura: recorre una vez las páginas del menú de
// INTRALU y reporta qué contenido tiene cada una (imágenes, PDFs, tablas,
// menciones a cronograma/avisos) para decidir qué más vale la pena traer al
// bot además de las fichas. No toca Supabase ni Telegram.
//
// Una sola pasada, secuencial y con pausa entre páginas: INTRALU es lento y
// se cae solo (ver docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md),
// no tiene sentido crawlearlo en paralelo por curiosidad.

// El menú lateral, sacado del HTML de /informacion-academica/fichas.
// /logout queda fuera a propósito: entrar ahí mata la sesión y el resto de
// la corrida falla.
const PAGINAS = [
  '/',
  '/informacion-academica/estadisticas',
  '/informacion-academica/tutoria',
  '/encuestas',
  '/tramites',
  '/tramites/actividades-diversas',
  '/bienestar-social/documentos',
  '/bienestar-social/datos-academicos',
  '/configuracion/datos-personales',
];

const PALABRAS = ['cronograma', 'aviso', 'comunicado', 'calendario', 'noticia', 'anuncio', 'horario', 'matrícula'];

// Imágenes del contenido, no las del tema (logo, avatares, iconos del
// template) — esas están todas bajo /assets/.
function esImagenDeContenido(src) {
  return src && !src.includes('/assets/') && !src.startsWith('data:');
}

async function explorar(client, ruta) {
  const res = await client.get(`${BASE_URL}${ruta}`, { validateStatus: () => true, timeout: 30000 });
  console.log(`\n━━━ ${ruta} → ${res.status}`);
  if (res.status !== 200 || !String(res.headers['content-type']).includes('html')) return;

  const $ = cheerio.load(res.data);
  // El template repite el menú en cada página; nos interesa solo el contenido.
  const $main = $('.content-wrapper').length ? $('.content-wrapper') : $('body');

  const titulos = $main.find('h1,h2,h3,h4,h5,.card-title').map((_, h) => $(h).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  if (titulos.length) console.log(`   📝 Títulos: ${[...new Set(titulos)].slice(0, 12).join(' | ')}`);

  const imgs = $main.find('img[src]').map((_, i) => $(i).attr('src')).get().filter(esImagenDeContenido);
  if (imgs.length) console.log(`   🖼️  Imágenes: ${[...new Set(imgs)].join(', ')}`);

  const docs = $main.find('a[href]').map((_, a) => $(a).attr('href')).get().filter((h) => /\.pdf|-pdf|\.docx?|\.xlsx?|descarga|download/i.test(h));
  if (docs.length) console.log(`   📎 Documentos: ${[...new Set(docs)].join(', ')}`);

  const filas = $main.find('table tbody tr').length;
  if (filas) console.log(`   📊 Tabla con ${filas} fila(s)`);

  const texto = $main.text().toLowerCase();
  const hits = PALABRAS.filter((p) => texto.includes(p));
  if (hits.length) console.log(`   🔎 Menciona: ${hits.join(', ')}`);

  // Muchas de estas páginas cargan sus datos por AJAX después del render;
  // las rutas quedan igual visibles en el JS inline del HTML.
  const rutas = [...String(res.data).matchAll(/url:\s*["'`]([^"'`]+)["'`]|fetch\(["'`]([^"'`]+)["'`]/g)]
    .map((m) => m[1] || m[2])
    .filter((u) => !u.includes('/assets/'));
  if (rutas.length) console.log(`   🔌 Endpoints AJAX: ${[...new Set(rutas)].join(', ')}`);

  if (!titulos.length && !imgs.length && !docs.length && !filas) console.log('   (sin contenido reconocible)');

  fs.writeFileSync(`explorar${ruta.replace(/\//g, '-') || '-home'}-debug.html`, res.data);
}

async function main() {
  const codigo = process.env.UNI_CODIGO;
  const password = process.env.UNI_PASSWORD;
  if (!codigo || !password) {
    console.error('❌ Falta UNI_CODIGO o UNI_PASSWORD en .env');
    process.exit(1);
  }

  const client = await login(codigo, password);
  console.log('✅ Login OK. Explorando el menú (una pasada, solo GET)...');

  for (const ruta of PAGINAS) {
    try {
      await explorar(client, ruta);
    } catch (err) {
      console.log(`\n━━━ ${ruta} → ❌ ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n📄 HTML de cada página guardado como explorar-*-debug.html (ignorados por git)');
}

main();
