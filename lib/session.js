const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const BASE_URL = 'https://alumnos.uni.edu.pe';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Nombres reales de los campos del form de login (sacados de DevTools el 2026-07-15).
// El sitio tiene reCAPTCHA v3 invisible pero el backend no lo valida de forma estricta:
// mandar el campo vacío basta para pasar el login.
const FIELD_CODIGO = 'txt-codigo';
const FIELD_PASSWORD = 'txt-password';

function newClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({ jar, withCredentials: true, headers: { 'User-Agent': UA } }));
}

async function login(codigo, password) {
  const client = newClient();

  const loginPage = await client.get(`${BASE_URL}/login`);
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

  const res = await client.post(`${BASE_URL}/login`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE_URL}/login`,
    },
    maxRedirects: 0,
    validateStatus: () => true,
  });

  const redirectedToLogin = res.status === 302 && (res.headers.location || '').endsWith('/login');
  if (redirectedToLogin) {
    const failPage = await client.get(`${BASE_URL}/login`);
    const $$ = cheerio.load(failPage.data);
    const errorMsg = $$('.invalid-feedback, .alert, .swal2-html-container').text().trim();
    throw new Error(`Login falló: ${errorMsg || 'motivo desconocido (revisa login-fail-debug.html)'}`);
  }

  return client;
}

// Devuelve { codper, csrfToken, cursos: [{ codcur, seccion, nombre }] } para
// el periodo actual (el que aparece seleccionado por defecto en INTRALU).
async function fetchCursosMatriculados(client) {
  const res = await client.get(`${BASE_URL}/informacion-academica/cursos`);
  const $ = cheerio.load(res.data);

  const csrfToken = $('meta[name="csrf-token"]').attr('content');
  const codper = $('#cb-periodos option[selected]').attr('value');

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

  return { codper, csrfToken, cursos };
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

module.exports = { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota, nombreVariable, UA, BASE_URL };
