const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const BASE_URL = 'https://alumnos.uni.edu.pe';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Nombres reales de los campos del form de login (sacados de DevTools el 2026-07-15).
// El sitio tiene reCAPTCHA v3 invisible. Hasta 2026-09 el backend no lo
// validaba y mandar el campo vacío bastaba; desde entonces sí lo valida, y
// login() cae a loginConNavegador() para conseguir un token real.
const FIELD_CODIGO = 'txt-codigo';
const FIELD_PASSWORD = 'txt-password';

// Distingue "INTRALU rechazó estas credenciales" (confirmado: redirigió de
// vuelta a /login tras el POST) de cualquier otro error — timeout, sitio
// caído, HTML cambiado — que check-all-users.js NO debe tratar como
// credenciales malas.
class CredentialError extends Error {}

// INTRALU rechazó el login por el reCAPTCHA, no por las credenciales. Desde
// fines de septiembre de 2026 el sitio contesta "Por favor complete el
// reCAPTCHA" cuando el campo g-recaptcha-response llega vacío (hasta
// entonces no lo validaba, ver FIELD_CODIGO). Va separado de CredentialError
// para que check-all-users.js no le cuente strikes al usuario: su
// contraseña no tiene nada que ver.
class CaptchaError extends Error {}

// Mirar el texto del error es frágil (la universidad lo cambia cuando
// quiere), pero acá el error solo puede ir en la dirección segura: si deja
// de matchear, el rechazo vuelve a contarse como credenciales malas, que es
// el comportamiento de antes.
function esRechazoPorCaptcha(errorMsg) {
  return /recaptcha|captcha/i.test(errorMsg || '');
}

// Distingue una falla de red/transporte (INTRALU inalcanzable, timeout, DNS)
// de cualquier otro error — ni credenciales malas (CredentialError) ni un
// cambio de HTML inesperado. check-all-users.js la usa para no tratar una
// caída del sitio como si fuera culpa del usuario.
function isNetworkError(err) {
  return (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(err.code) ||
    (err.isAxiosError === true && !err.response) ||
    // Las mismas fallas vistas desde Chromium (loginConNavegador).
    /net::ERR_/.test(err.message || '')
  );
}

function newClient(jar = new CookieJar(), ua = UA) {
  return wrapper(axios.create({ jar, withCredentials: true, timeout: 20000, headers: { 'User-Agent': ua } }));
}

function errorDeRechazo(errorMsg) {
  if (esRechazoPorCaptcha(errorMsg)) {
    return new CaptchaError(`Login bloqueado por reCAPTCHA: ${errorMsg}`);
  }
  return new CredentialError(`Login falló: ${errorMsg || 'motivo desconocido'}`);
}

// Primero prueba el login por HTTP puro, que es rápido y no necesita
// navegador. Si INTRALU lo rechaza por el reCAPTCHA, repite el login con
// Chromium para que la propia página genere el token. Así, si algún día el
// sitio vuelve a no validarlo, el navegador deja de usarse solo.
async function login(codigo, password) {
  try {
    return await loginHttp(codigo, password);
  } catch (err) {
    if (!(err instanceof CaptchaError)) throw err;
    return loginConNavegador(codigo, password);
  }
}

async function loginHttp(codigo, password, baseUrl = BASE_URL) {
  const client = newClient();

  const loginPage = await client.get(`${baseUrl}/login`);
  const $ = cheerio.load(loginPage.data);
  const token = $('input[name="_token"]').val();
  if (!token) {
    throw new Error('No se encontró el token CSRF en la página de login (¿cambió el HTML del sitio?).');
  }

  const params = new URLSearchParams();
  params.append('_token', token);
  params.append(FIELD_CODIGO, codigo);
  params.append(FIELD_PASSWORD, password);
  params.append('g-recaptcha-response', '');

  const res = await client.post(`${baseUrl}/login`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${baseUrl}/login`,
    },
    maxRedirects: 0,
    validateStatus: () => true,
  });

  const redirectedToLogin = res.status === 302 && (res.headers.location || '').endsWith('/login');
  if (redirectedToLogin) {
    const failPage = await client.get(`${baseUrl}/login`);
    const $$ = cheerio.load(failPage.data);
    throw errorDeRechazo($$('.invalid-feedback, .alert, .swal2-html-container').text().trim());
  }

  return client;
}

// Login con Chromium headless: llena el form y lo envía como una persona,
// así el JS de la página ejecuta grecaptcha (v3, invisible: no hay casilla
// que marcar) y manda un token real. Después copia las cookies de sesión a
// un cliente axios normal, así que el resto del código no se entera.
//
// Usa el Google Chrome que ya viene instalado en los runners de GitHub
// (channel 'chrome'), sin descargar nada. CHROME_PATH permite apuntar a
// otro binario para correrlo local.
//
// Un navegador por login a propósito: con pocos usuarios activos no vale
// la pena compartirlo, y así no queda un proceso colgando que haya que
// cerrar desde cada script.
async function loginConNavegador(codigo, password, baseUrl = BASE_URL) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
  );
  try {
    // El UA por defecto del headless dice "HeadlessChrome", y reCAPTCHA v3
    // le baja el puntaje. Mismo navegador, sin esa marca.
    const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
    const context = await browser.newContext({ userAgent: ua, locale: 'es-PE' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
    // reCAPTCHA v3 puntúa mejor si la página tuvo un momento de vida antes
    // del submit. Si el script no carga, igual se intenta: el backend dirá.
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    await page.fill(`[name="${FIELD_CODIGO}"]`, codigo);
    await page.fill(`[name="${FIELD_PASSWORD}"]`, password);
    // Enter dispara el submit implícito del form, que pasa por el mismo
    // click del botón que usaría una persona, sin depender de su selector.
    await page.press(`[name="${FIELD_PASSWORD}"]`, 'Enter');

    const salio = await page
      .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!salio) {
      const errorMsg = (await page.locator('.invalid-feedback, .alert, .swal2-html-container').allInnerTexts())
        .join(' ')
        .trim();
      // Sin mensaje no hay rechazo confirmado (puede ser el sitio lento):
      // error genérico, que check-all-users.js no cuenta como strike.
      if (!errorMsg) throw new Error('El login con navegador no salió de /login y no mostró ningún error.');
      throw errorDeRechazo(errorMsg);
    }

    const jar = new CookieJar();
    for (const c of await context.cookies()) {
      // Playwright marca con punto inicial las cookies de dominio; las que
      // no lo tienen son host-only y van sin atributo Domain.
      const partes = [`${c.name}=${c.value}`, `Path=${c.path}`];
      if (c.domain.startsWith('.')) partes.push(`Domain=${c.domain}`);
      if (c.secure) partes.push('Secure');
      const origen = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}`;
      await jar.setCookie(partes.join('; '), origen);
    }
    return newClient(jar, ua);
  } finally {
    await browser.close();
  }
}

// Devuelve { codper, csrfToken, cursos: [{ codcur, seccion, nombre }],
// periodos } para un período dado (o el actual, el que aparece
// seleccionado por defecto en INTRALU, si no se pasa `codper`). `periodos`
// es la lista completa de códigos de período que ofrece el selector de
// INTRALU (ej. ["20261","20252",...]) — confirmado contra el sitio real
// que `?codper=X` sí devuelve los cursos de un período pasado (ver
// docs/GRADING-RULES.md).
async function fetchCursosMatriculados(client, codper) {
  const url = codper
    ? `${BASE_URL}/informacion-academica/cursos?codper=${codper}`
    : `${BASE_URL}/informacion-academica/cursos`;
  const res = await client.get(url);
  const $ = cheerio.load(res.data);

  const csrfToken = $('meta[name="csrf-token"]').attr('content');
  const codperActual = $('#cb-periodos option[selected]').attr('value');
  const periodos = $('#cb-periodos option')
    .map((_, o) => $(o).attr('value'))
    .get();

  const cursos = [];
  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const btn = $row.find('.btn-ver-curso');
    if (!btn.length) return;

    cursos.push({
      codcur: btn.data('codcur'),
      seccion: btn.data('seccion'),
      nombre: $row.find('td').eq(1).text().trim().replace(/-+$/, '').trim(),
    });
  });

  return { codper: codperActual, csrfToken, cursos, periodos };
}

// Nombre de variable que usa INTRALU para cada evaluación en sus fórmulas
// (ej. "(N1 + N2 + N3 + N4 - MIN(N1,N2,N3,N4))/3"). Mismo mapeo que usa el
// propio JS del sitio: camnot 13/14/15 son Parcial/Final/Sustitutorio, el
// resto son N1, N2, N3...
function nombreVariable(camnot) {
  if (camnot === 13) return 'EP';
  if (camnot === 14) return 'EF';
  if (camnot === 15) return 'ES';
  return `N${camnot}`;
}

// Devuelve las evaluaciones (Práctica 1, Examen Parcial, Examen Final, etc.)
// de un curso puntual, más las fórmulas y promedios que calcula el propio
// INTRALU para ese curso.
async function fetchEvaluaciones(client, csrfToken, { codper, codcur, seccion }) {
  const params = new URLSearchParams();
  params.append('codper', codper);
  params.append('codcur', codcur);
  params.append('seccion', seccion);

  const res = await client.post(`${BASE_URL}/informacion-academica/cursos/notas`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const evaluaciones = (res.data.data || []).map((ev) => ({
    camnot: ev.camnot,
    variable: nombreVariable(ev.camnot),
    descripcion: ev.descripcion,
    nota: ev.nota === null || ev.nota === undefined ? null : Number(ev.nota),
    anulada: Boolean(ev.flgnot),
    fecha: ev.fecha_registro_acta || null,
  }));

  return {
    evaluaciones,
    formulas: res.data.formulas || null,
    promedios: res.data.promedios || null,
  };
}

// "0A" si la anularon (copia/falta grave), "NSP" si ya tenía fecha de
// registro pero nunca le pusieron nota (no se presentó), o el número tal cual.
function formatearNota(ev) {
  if (ev.anulada) return '0A';
  if (ev.nota === null) return 'NSP';
  return String(ev.nota);
}

// Cada ficha de /informacion-academica/fichas es una tarjeta con su título
// en .card-title y un <a> a un PDF. Verificado contra el sitio el
// 2026-08-11: son links GET directos, sin CSRF ni POST (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md).
//
// El filtro por `-pdf` en el href y por tener .card-title deja afuera el
// único otro PDF de la página, MARCO_LEGAL_ACADEMICO.pdf del pie, que no
// vive en una tarjeta.
//
// La lista NO es fija: el mismo día se vio la página con 7 tarjetas y con 6
// (Constancia de Ingreso desapareció). Por eso siempre se lee del HTML en
// vez de hardcodearla.
function parsearFichas(html) {
  const $ = cheerio.load(html);
  return $('a[href*="-pdf"]')
    .map((_, a) => ({
      nombre: $(a).closest('.card').find('.card-title').text().trim(),
      url: $(a).attr('href'),
    }))
    .get()
    .filter((f) => f.nombre);
}

async function fetchFichas(client) {
  const res = await client.get(`${BASE_URL}/informacion-academica/fichas`);
  return parsearFichas(res.data);
}

// Devuelve el PDF como Buffer, o null si INTRALU no lo entregó.
//
// Que una ficha falle es normal y transitorio: el 2026-08-11 a la mañana
// Constancia de Matrícula devolvía 404 con Content-Type: application/json y
// a la tarde devolvía el PDF sin problema. Por eso `validateStatus` no lanza
// y se chequea el status a mano. El chequeo extra de los primeros 4 bytes
// cubre el otro caso feo: una sesión vencida devuelve el HTML del login con
// status 200, que no es un PDF pero pasaría el chequeo de status.
//
// `responseType: 'arraybuffer'` es obligatorio: sin eso axios interpreta el
// PDF como texto UTF-8 y lo corrompe. El timeout va por request (60s) porque
// INTRALU genera estos PDFs al vuelo — el de newClient() son 20s y se han
// medido fichas de hasta 7.6s, poco margen si el sitio está degradado.
async function descargarFicha(client, url) {
  const res = await client.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    validateStatus: () => true,
  });
  const buffer = Buffer.from(res.data);
  if (res.status !== 200) return null;
  if (buffer.subarray(0, 4).toString() !== '%PDF') return null;
  return buffer;
}

// La home de INTRALU publica archivos en dos bloques con HTML distinto pero
// el mismo mecanismo de descarga (<a class="btn-file" data-codanu=...>):
//
//   1. "Anuncios": un timeline (li.timeline-item) con título, fecha en el
//      atributo title del <small>, texto y cero o más adjuntos. Acá el <a>
//      sí trae el nombre del archivo en un span.fw-medium.
//   2. "Reglamentos y Resoluciones": tres pestañas (Reglamentos,
//      Resoluciones, Manuales), cada una con li que llevan el título en
//      p.fw-medium y la fecha en un .badge. Acá el <a> es solo un ícono, así
//      que el nombre del archivo se arma con el título y data-extension.
//
// Las pestañas vacías traen un <li class="text-center">Sin publicaciones</li>
// que queda descartado porque no tiene título propio.
//
// Verificado contra el sitio el 2026-08-11 (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md).
function parsearPublicaciones(html) {
  const $ = cheerio.load(html);
  const publicaciones = [];

  // Nombre del adjunto: el span del propio link si existe (bloque de
  // anuncios), o título + extensión (bloque de reglamentos).
  const adjuntosDe = ($item, titulo) =>
    $item
      .find('.btn-file')
      .map((_, a) => {
        const $a = $(a);
        const nombreSpan = $a.find('span.fw-medium').text().trim();
        const extension = $a.attr('data-extension') || 'pdf';
        return {
          codanu: String($a.attr('data-codanu')),
          nombre: nombreSpan || `${titulo}.${extension}`,
        };
      })
      .get();

  $('li.timeline-item').each((_, li) => {
    const $li = $(li);
    const titulo = $li.find('.timeline-header h6').text().trim();
    if (!titulo) return;
    publicaciones.push({
      tipo: 'Anuncio',
      titulo,
      fecha: $li.find('.timeline-header small').attr('title') || '',
      texto: $li.find('p').first().text().trim(),
      adjuntos: adjuntosDe($li, titulo),
    });
  });

  // Cada pestaña toma su nombre del botón que la abre (data-bs-target
  // apunta al id del panel) en vez de hardcodear los ids, que son del
  // template y no significan nada ("navs-justified-link-shipping").
  $('.tab-pane').each((_, pane) => {
    const $pane = $(pane);
    const id = $pane.attr('id');
    const tipo = $(`[data-bs-target="#${id}"]`).text().trim() || 'Publicación';

    $pane.find('li').each((_, li) => {
      const $li = $(li);
      const titulo = $li.find('p.fw-medium').text().trim();
      if (!titulo) return;
      publicaciones.push({
        tipo,
        titulo,
        fecha: $li.find('.badge').text().trim(),
        texto: '',
        adjuntos: adjuntosDe($li, titulo),
      });
    });
  });

  return publicaciones;
}

async function fetchPublicaciones(client) {
  const res = await client.get(`${BASE_URL}/`);
  return parsearPublicaciones(res.data);
}

// Baja un adjunto de la home por su codanu. El endpoint sale del JS del
// propio sitio (/build/assets/home-*.js): el click en .btn-file termina
// siempre en GET /anuncio/download/{codanu}.
//
// A diferencia de las fichas, acá el tipo de archivo es variable (pdf, docx
// y jpg vistos en el sitio), así que no se puede validar por magic bytes —
// se valida status y que no venga vacío. `responseType: 'arraybuffer'` es
// obligatorio para no corromper el binario.
async function descargarAdjunto(client, codanu) {
  const res = await client.get(`${BASE_URL}/anuncio/download/${codanu}`, {
    responseType: 'arraybuffer',
    timeout: 60000,
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;
  const buffer = Buffer.from(res.data);
  return buffer.byteLength > 0 ? buffer : null;
}

module.exports = {
  login,
  fetchCursosMatriculados,
  fetchEvaluaciones,
  formatearNota,
  nombreVariable,
  parsearFichas,
  fetchFichas,
  descargarFicha,
  parsearPublicaciones,
  fetchPublicaciones,
  descargarAdjunto,
  UA,
  BASE_URL,
  CredentialError,
  CaptchaError,
  esRechazoPorCaptcha,
  loginHttp,
  loginConNavegador,
  isNetworkError,
};
