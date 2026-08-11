# Descarga de fichas desde el bot (`/fichas`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `/fichas` liste las siete fichas de `/informacion-academica/fichas` como botones, y que al tocar una el bot la baje de INTRALU y la mande al chat como PDF — avisando en el momento si esa ficha puntual falla.

**Architecture:** Mismo patrón que `/ciclos`: la Edge Function (Deno) no puede loguearse contra INTRALU, así que muestra los botones al instante desde una lista fija y, al tocar uno, dispara un workflow de GitHub Actions vía `workflow_dispatch` con el id de esa ficha. Un script Node nuevo (`fetch-fichas.js`) desencripta la contraseña, hace `login()`, busca esa ficha en la página real, la baja y la sube a Telegram con `sendDocument`. Nada se persiste: los bytes viven en memoria del runner y se van con el job.

**Decisión de producto:** se listan **las siete**, incluidas las dos que hoy fallan del lado de INTRALU. El error se descubre y se comunica al tocar cada una, no escondiendo opciones de la lista — así el usuario ve todo lo que INTRALU ofrece y se entera de qué está roto cuando lo intenta.

**Tech Stack:** Node 22 (CommonJS), axios + axios-cookiejar-support, cheerio, Supabase JS, GitHub Actions, Telegram Bot API. Tests con `node:test` (stdlib, sin dependencias nuevas).

**Spec:** [`docs/superpowers/specs/2026-08-11-descarga-fichas-design.md`](../specs/2026-08-11-descarga-fichas-design.md) — ya verificado contra el sitio real.

---

## Contexto imprescindible para quien implemente

Si nunca tocaste este repo, leé esto antes de la Task 1:

- **El scraping vive en un solo lugar**: `lib/session.js` (Node). La Edge
  Function `supabase/functions/telegram-webhook/index.ts` corre en Deno y
  **nunca** hace login contra INTRALU. No dupliques el login ahí.
- **No hay suite de tests en el proyecto.** Este plan introduce la primera,
  con `node --test` (viene con Node 22, no se instala nada). Solo se testea
  lógica pura: parsers y armado de nombres. Lo que toca la red se verifica a
  mano con los scripts de diagnóstico, que es el criterio del proyecto.
- **Datos ya verificados contra INTRALU** (2026-08-11, `pnpm run test-fichas`):
  son 7 tarjetas con links `GET` directos, sin CSRF ni POST. 5 devuelven
  `application/pdf` (74–189 KB, 1.4–6.8 s). Las otras 2 —Constancia de
  Matrícula y Constancia de Ingreso— devuelven **404 y 500 con
  `Content-Type: application/json`**, y están rotas del lado de INTRALU para
  todos los alumnos. El código tiene que tolerarlo sin abortar el resto.
- **Comandos existentes como referencia**: `/ciclos` en
  `telegram-webhook/index.ts:447-464` y su script `fetch-historial.js`.
  Copiá esos patrones en vez de inventar nuevos.

## File Structure

| Archivo | Responsabilidad |
| --- | --- |
| `lib/session.js` (modificar) | Suma `parsearFichas(html)` (pura), `fetchFichas(client)` (red) y `descargarFicha(client, url)` (red + validación de que sea PDF). Es el único lugar donde vive el conocimiento del HTML de INTRALU. |
| `lib/notificaciones.js` (modificar) | Suma `sendDocument(...)`. Hoy solo sabe mandar texto; los adjuntos van en `multipart/form-data`. |
| `test/fichas.test.js` (crear) | Tests de las funciones puras: `parsearFichas` y `nombreArchivo`, más `descargarFicha` con un cliente falso. Sin red. |
| `fetch-fichas.js` (crear) | Orquesta **una** ficha: Supabase → desencriptar → login → buscarla en la página → bajarla → mandarla (o avisar por qué no se pudo). Espejo de `fetch-historial.js`. |
| `.github/workflows/descargar-fichas.yml` (crear) | Dispara `fetch-fichas.js` con el `chat_id` y el `ficha_id` que le pasa la Edge Function. |
| `supabase/functions/telegram-webhook/index.ts` (modificar) | Comando `/fichas` (botones), rama `ficha:` en `manejarCallbackQuery`, `dispararDescargaFicha()` y línea en `AYUDA`. |
| `package.json` (modificar) | Scripts `fetch-fichas` y `test`. |
| `README.md`, `CHANGELOG.md` (modificar) | El proyecto documenta cada comando. |

---

### Task 1: `parsearFichas` — leer la lista de fichas del HTML

**Files:**
- Modify: `lib/session.js`
- Create: `test/fichas.test.js`

- [ ] **Step 1: Escribir el test que falla**

Creá `test/fichas.test.js`. El fixture es una copia recortada del HTML real
de `/informacion-academica/fichas`: dos tarjetas válidas más el link del pie
de página, que **no** tiene que aparecer en el resultado.

```js
const test = require('node:test');
const assert = require('node:assert');
const { parsearFichas } = require('../lib/session');

// Recorte del HTML real de /informacion-academica/fichas (2026-08-11).
const HTML_FICHAS = `
<div class="col-md-6 col-xl-4">
  <div class="card bg-info text-white text-center mb-3">
    <div class="card-body">
      <h5 class="card-title text-white">Ficha Datos Personales</h5>
      <p class="card-text">Datos Personales y Académicos del estudiante</p>
      <a href="https://alumnos.uni.edu.pe/informacion-academica/ficha-datos-pdf"
         target="_blank" class="btn btn-flat-dark">Ver</a>
    </div>
  </div>
</div>
<div class="col-md-6 col-xl-4">
  <div class="card bg-danger text-white text-center mb-3">
    <div class="card-body">
      <h5 class="card-title text-white">Ficha Académica</h5>
      <a href="https://alumnos.uni.edu.pe/informacion-academica/ficha-academica-pdf"
         target="_blank" class="btn btn-flat-dark">Ver</a>
    </div>
  </div>
</div>
<footer>
  <a href="https://alumnos.uni.edu.pe/assets/img/legal/MARCO_LEGAL_ACADEMICO.pdf">Licencia</a>
</footer>
`;

test('parsearFichas saca nombre y url de cada tarjeta', () => {
  const fichas = parsearFichas(HTML_FICHAS);
  assert.deepStrictEqual(fichas, [
    {
      nombre: 'Ficha Datos Personales',
      url: 'https://alumnos.uni.edu.pe/informacion-academica/ficha-datos-pdf',
    },
    {
      nombre: 'Ficha Académica',
      url: 'https://alumnos.uni.edu.pe/informacion-academica/ficha-academica-pdf',
    },
  ]);
});

test('parsearFichas ignora el PDF de licencia del pie de página', () => {
  const fichas = parsearFichas(HTML_FICHAS);
  assert.ok(!fichas.some((f) => f.url.includes('MARCO_LEGAL')));
});

test('parsearFichas devuelve [] si el HTML cambió y no hay tarjetas', () => {
  assert.deepStrictEqual(parsearFichas('<html><body><p>nada</p></body></html>'), []);
});
```

- [ ] **Step 2: Agregar el script `test` y correrlo para verlo fallar**

En `package.json`, dentro de `"scripts"`, agregá como primera línea:

```json
    "test": "node --test",
```

Run: `pnpm test`
Expected: FAIL — `TypeError: parsearFichas is not a function`

- [ ] **Step 3: Implementar `parsearFichas`**

En `lib/session.js`, justo después de la función `formatearNota` (línea 160,
antes del `module.exports`), agregá:

```js
// Cada ficha de /informacion-academica/fichas es una tarjeta con su título
// en .card-title y un <a> a un PDF. Verificado contra el sitio el
// 2026-08-11: son links GET directos, sin CSRF ni POST (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md).
//
// El filtro por `-pdf` en el href y por tener .card-title deja afuera el
// único otro PDF de la página, MARCO_LEGAL_ACADEMICO.pdf del pie, que no
// vive en una tarjeta.
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
```

Y agregá `parsearFichas` al `module.exports` del final del archivo:

```js
module.exports = {
  login,
  fetchCursosMatriculados,
  fetchEvaluaciones,
  formatearNota,
  nombreVariable,
  parsearFichas,
  UA,
  BASE_URL,
  CredentialError,
  isNetworkError,
};
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS — `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add lib/session.js test/fichas.test.js package.json
git commit -m "Agrega parsearFichas y el primer test con node:test"
```

---

### Task 2: `fetchFichas` y `descargarFicha` — traer los archivos

**Files:**
- Modify: `lib/session.js`
- Modify: `test/fichas.test.js`

- [ ] **Step 1: Escribir el test que falla**

`descargarFicha` recibe el cliente como parámetro, así que se puede testear
con un cliente falso, sin red. Agregá al final de `test/fichas.test.js`:

```js
const { descargarFicha } = require('../lib/session');

// Cliente falso: solo necesita .get(), que es lo único que usa descargarFicha.
function clienteFalso(respuesta) {
  return { get: async () => respuesta };
}

test('descargarFicha devuelve el buffer si el PDF es válido', async () => {
  const pdf = Buffer.from('%PDF-1.4 contenido falso');
  const res = await descargarFicha(clienteFalso({ status: 200, data: pdf }), '/x-pdf');
  assert.ok(Buffer.isBuffer(res));
  assert.strictEqual(res.subarray(0, 4).toString(), '%PDF');
});

test('descargarFicha devuelve null si INTRALU responde 404 con JSON', async () => {
  // Caso real de Constancia de Matrícula (2026-08-11).
  const json = Buffer.from('{"message":""}');
  const res = await descargarFicha(clienteFalso({ status: 404, data: json }), '/x-pdf');
  assert.strictEqual(res, null);
});

test('descargarFicha devuelve null si el status es 200 pero no es un PDF', async () => {
  // Sesión vencida: INTRALU devuelve el HTML del login con status 200.
  const html = Buffer.from('<!DOCTYPE html><html>login</html>');
  const res = await descargarFicha(clienteFalso({ status: 200, data: html }), '/x-pdf');
  assert.strictEqual(res, null);
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `pnpm test`
Expected: FAIL — `TypeError: descargarFicha is not a function`

- [ ] **Step 3: Implementar las dos funciones**

En `lib/session.js`, justo después de `parsearFichas`, agregá:

```js
async function fetchFichas(client) {
  const res = await client.get(`${BASE_URL}/informacion-academica/fichas`);
  return parsearFichas(res.data);
}

// Devuelve el PDF como Buffer, o null si INTRALU no lo entregó.
//
// Dos fichas de las siete (Constancia de Matrícula y Constancia de Ingreso)
// vienen rotas del lado de INTRALU: devuelven 404/500 con
// Content-Type: application/json. Por eso `validateStatus` no lanza y se
// chequea el status a mano. El chequeo extra de los primeros 4 bytes cubre
// el otro caso feo: una sesión vencida devuelve el HTML del login con
// status 200, que no es un PDF pero pasaría el chequeo de status.
//
// `responseType: 'arraybuffer'` es obligatorio: sin eso axios interpreta el
// PDF como texto UTF-8 y lo corrompe. El timeout va por request (60s) porque
// INTRALU genera estos PDFs al vuelo — el de newClient() son 20s y la ficha
// más lenta medida tardó 6.8s, muy poco margen si el sitio está degradado.
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
```

Agregá `fetchFichas` y `descargarFicha` al `module.exports`.

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS — `# pass 6`

- [ ] **Step 5: Verificar contra INTRALU de verdad**

`fichas-test.js` ya existe y hace exactamente esto. Actualizalo para que use
las funciones de `lib/session.js` en vez de su copia local — reemplazá el
bloque `const cheerio = ...` / `async function fetchFichas` del principio por:

```js
const { login, fetchFichas, descargarFicha } = require('./lib/session');
```

y el cuerpo del `for` por:

```js
      const t0 = Date.now();
      const pdf = await descargarFicha(client, ficha.url);
      console.log(
        pdf
          ? `✅ ${ficha.nombre}: ${(pdf.byteLength / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`
          : `⚠️  ${ficha.nombre}: INTRALU no devolvió un PDF`,
      );
```

Run: `pnpm run test-fichas`
Expected: 5 líneas ✅ (Datos Personales, Académica, Académica Depurada,
Avance Curricular, Adeudos) y 2 líneas ⚠️ (las dos constancias).

- [ ] **Step 6: Commit**

```bash
git add lib/session.js test/fichas.test.js fichas-test.js
git commit -m "Agrega fetchFichas y descargarFicha a lib/session"
```

---

### Task 3: `sendDocument` — mandar adjuntos por Telegram

**Files:**
- Modify: `lib/notificaciones.js`

- [ ] **Step 1: Implementar `sendDocument`**

No lleva test automatizado: es una llamada HTTP sin lógica propia, y
testearla sería testear a axios. Se verifica en la Task 5 contra el bot real.

En `lib/notificaciones.js`, justo después de `sendTelegram` (línea 12), agregá:

```js
// Los adjuntos van en multipart/form-data, no en JSON como sendMessage.
// FormData y Blob son globales en Node 22, así que no hace falta ninguna
// dependencia nueva; axios detecta el FormData y arma el Content-Type con
// su boundary solo.
//
// `caption` tiene un tope de 1024 caracteres en la API de Telegram — quien
// llame se encarga de no pasarse (acá son nombres de ficha, no hay riesgo).
async function sendDocument(token, chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer]), filename);
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendDocument`, form);
}
```

Agregá `sendDocument` al `module.exports` del final:

```js
module.exports = { sendTelegram, sendDocument, emoji, emojiValor, agruparPorCurso, etiquetaPeriodo, NOTA_APROBATORIA };
```

- [ ] **Step 2: Verificar que no rompiste nada**

Run: `pnpm test`
Expected: PASS — `# pass 6`

- [ ] **Step 3: Commit**

```bash
git add lib/notificaciones.js
git commit -m "Agrega sendDocument para mandar adjuntos por Telegram"
```

---

### Task 4: `nombreArchivo` — nombre de archivo a partir del título

**Files:**
- Modify: `test/fichas.test.js`
- Create: `fetch-fichas.js` (solo esta función por ahora)

- [ ] **Step 1: Escribir el test que falla**

Agregá al final de `test/fichas.test.js`:

```js
const { nombreArchivo } = require('../fetch-fichas');

test('nombreArchivo convierte el título en un nombre de archivo seguro', () => {
  assert.strictEqual(nombreArchivo('Ficha Académica'), 'ficha-academica.pdf');
  assert.strictEqual(nombreArchivo('Ficha Académica Depurada'), 'ficha-academica-depurada.pdf');
  assert.strictEqual(nombreArchivo('Constancia de Matrícula'), 'constancia-de-matricula.pdf');
  assert.strictEqual(nombreArchivo('Adeudos'), 'adeudos.pdf');
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../fetch-fichas'`

- [ ] **Step 3: Crear `fetch-fichas.js` con la función y su export**

Creá `fetch-fichas.js` con exactamente este contenido (el `main()` se llena
en la Task 5):

```js
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

module.exports = { nombreArchivo };
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS — `# pass 7`

- [ ] **Step 5: Commit**

```bash
git add fetch-fichas.js test/fichas.test.js
git commit -m "Agrega nombreArchivo para los adjuntos de fichas"
```

---

### Task 5: `fetch-fichas.js` — el script completo

**Files:**
- Modify: `fetch-fichas.js`
- Modify: `package.json`

- [ ] **Step 1: Escribir el script completo**

Reemplazá **todo** el contenido de `fetch-fichas.js` por esto. Es el espejo
de `fetch-historial.js`, incluido su bloque `catch` (líneas 87-105 de ese
archivo), con una diferencia: acá hay fallas parciales, así que una ficha
rota no aborta la corrida.

```js
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
// telegram-webhook cuando alguien manda /fichas. Baja las fichas de un solo
// usuario por corrida y las manda como adjuntos — nada se persiste, los
// bytes se van con el runner (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md).
async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    CREDENTIALS_ENCRYPTION_KEY,
    TELEGRAM_TOKEN,
    CHAT_ID,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN o CHAT_ID en el entorno');
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

    if (fichas.length === 0) {
      await sendTelegram(TELEGRAM_TOKEN, chatId, 'No encontré fichas disponibles en INTRALU en este momento.');
      console.log(`⚠️ chat_id ${chatId}: 0 fichas en la página`);
      return;
    }

    // Una ficha rota (INTRALU devuelve 404/500 en dos de las siete) no
    // aborta las demás: se anota y se sigue. Al final se nombran todas
    // juntas para que nadie se quede esperando una que no va a llegar.
    const fallidas = [];
    let enviadas = 0;
    for (const ficha of fichas) {
      const pdf = await descargarFicha(client, ficha.url);
      if (!pdf) {
        fallidas.push(ficha.nombre);
        continue;
      }
      await sendDocument(TELEGRAM_TOKEN, chatId, pdf, nombreArchivo(ficha.nombre), `📄 ${ficha.nombre}`);
      enviadas++;
    }

    if (enviadas === 0) {
      await sendTelegram(
        TELEGRAM_TOKEN,
        chatId,
        '❌ INTRALU no me dejó descargar ninguna de tus fichas en este momento. Intenta de nuevo más tarde.',
      );
    } else if (fallidas.length > 0) {
      await sendTelegram(
        TELEGRAM_TOKEN,
        chatId,
        `✅ Te mandé ${enviadas} ficha(s).\n\n⚠️ INTRALU no me dejó descargar: ${fallidas.join(', ')}. Eso falla del lado de ellos, no es tu cuenta.`,
      );
    } else {
      await sendTelegram(TELEGRAM_TOKEN, chatId, `✅ Listo, te mandé tus ${enviadas} fichas.`);
    }

    console.log(`✅ chat_id ${chatId}: ${enviadas} enviada(s), ${fallidas.length} fallida(s)`);
  } catch (err) {
    console.error(`❌ chat_id ${chatId}:`, err.message);

    // El usuario no necesita ver "timeout of 20000ms exceeded" ni otros
    // detalles técnicos — el mensaje crudo (err.message) queda solo en el
    // log de GitHub Actions (arriba) para diagnóstico.
    let mensaje;
    if (isNetworkError(err)) {
      mensaje = '❌ No pude conectarme a INTRALU para traer tus fichas — el sitio no está respondiendo en este momento. Intenta de nuevo más tarde.';
    } else if (err instanceof CredentialError) {
      mensaje = '❌ No pude iniciar sesión en INTRALU para traer tus fichas. Revisa tu código y contraseña con /registrar.';
    } else {
      mensaje = '❌ No pude traer tus fichas. Intenta de nuevo más tarde.';
    }

    await sendTelegram(TELEGRAM_TOKEN, chatId, mensaje).catch(() => {});
    process.exit(1);
  }
}

module.exports = { nombreArchivo };

// Solo corre si lo invocan directo (`node fetch-fichas.js`), no cuando
// test/fichas.test.js lo importa para probar nombreArchivo.
if (require.main === module) main();
```

- [ ] **Step 2: Agregar el script a `package.json`**

En `"scripts"`, después de `"fetch-historial"`, agregá:

```json
    "fetch-fichas": "node fetch-fichas.js"
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm test`
Expected: PASS — `# pass 7` (el `require.main` evita que el test dispare `main()`)

- [ ] **Step 4: Probarlo de verdad, de punta a punta**

Necesitás en tu `.env` local: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CREDENTIALS_ENCRYPTION_KEY`, `TELEGRAM_TOKEN` y `CHAT_ID` con tu propio
chat_id de Telegram.

Run: `pnpm run fetch-fichas`
Expected: llegan 5 PDFs al chat, cada uno con su caption (`📄 Ficha
Académica`, etc.), y un mensaje final avisando que Constancia de Matrícula y
Constancia de Ingreso no se pudieron descargar. En consola:
`✅ chat_id <id>: 5 enviada(s), 2 fallida(s)`

- [ ] **Step 5: Commit**

```bash
git add fetch-fichas.js package.json
git commit -m "Agrega fetch-fichas.js: baja las fichas y las manda por Telegram"
```

---

### Task 6: El workflow de GitHub Actions

**Files:**
- Create: `.github/workflows/descargar-fichas.yml`

- [ ] **Step 1: Crear el workflow**

Copia de `fetch-historial.yml` sin el input `codper`. El `concurrency` va
scopeado al `chat_id`: dos usuarios distintos pueden bajar fichas en
paralelo, pero el mismo usuario mandando `/fichas` dos veces seguidas no
dispara dos logins.

```yaml
name: Descargar fichas

# Disparado solo por telegram-webhook cuando alguien manda /fichas. Corre una
# sola vez (sin sleep, sin auto-encadenarse) y atiende a un solo chat_id —
# nunca un lote. El concurrency group está scopeado a ese chat_id (no a todo
# el workflow, a diferencia de check-grade.yml): dos usuarios distintos
# pidiendo sus fichas corren en paralelo sin problema; solo se evita que el
# mismo usuario dispare dos descargas encimadas.

on:
  workflow_dispatch:
    inputs:
      chat_id:
        description: 'Telegram chat_id del usuario'
        required: true
        type: string

concurrency:
  group: descargar-fichas-${{ github.event.inputs.chat_id }}
  cancel-in-progress: true

jobs:
  descargar-fichas:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.13.0

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run fetch-fichas
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          CHAT_ID: ${{ github.event.inputs.chat_id }}
        run: pnpm run fetch-fichas
```

- [ ] **Step 2: Commit y push (el workflow tiene que estar en `main` para poder dispararse)**

```bash
git add .github/workflows/descargar-fichas.yml
git commit -m "Agrega workflow descargar-fichas.yml"
```

- [ ] **Step 3: Probar el workflow a mano desde GitHub**

Andá a Actions → "Descargar fichas" → "Run workflow", poné tu `chat_id` y
ejecutalo.
Expected: el job termina en verde y te llegan los 5 PDFs al chat de Telegram.

---

### Task 7: El comando `/fichas` en la Edge Function

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Agregar `dispararDescargaFichas`**

Justo después de `dispararFetchHistorial` (que termina en la línea 155),
agregá:

```ts
// Dispara descargar-fichas.yml (workflow aparte, atiende a un solo usuario)
// para bajar las fichas de INTRALU y mandarlas como adjuntos — best-effort,
// mismo patrón que dispararFetchHistorial.
async function dispararDescargaFichas(chatId: number) {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows/descargar-fichas.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { chat_id: String(chatId) } }),
      },
    );
    if (!res.ok) console.error('dispararDescargaFichas:', res.status, await res.text());
  } catch {
    // best-effort, no pasa nada si falla
  }
}
```

- [ ] **Step 2: Agregar el comando al despachador**

En el `Deno.serve`, entre la rama de `/ciclos` (termina en la línea 464 con
`}` antes de `} else if (text.startsWith('/simular'))`) y la de `/simular`,
agregá:

```ts
  } else if (text === '/fichas') {
    const { data } = await supabase.from('usuarios').select('chat_id').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      await sendMessage(
        chatId,
        '🔎 Buscando tus fichas en INTRALU, puede tardar unos minutos...\n\nTe las mando por acá una por una apenas las tenga.',
      );
      await dispararDescargaFichas(chatId);
    }
```

- [ ] **Step 3: Agregar la línea a la ayuda**

En la constante `AYUDA` (línea 199), después de la línea de `/ciclos`, agregá:

```
<b>/fichas</b> — descarga tus fichas y constancias de INTRALU como PDF
```

- [ ] **Step 4: Desplegar y probar**

Run: `pnpm dlx supabase functions deploy telegram-webhook`

Después, en Telegram, mandale `/fichas` al bot.
Expected: responde "🔎 Buscando tus fichas..." al instante, y en 1-2 minutos
llegan los 5 PDFs más el aviso de las 2 que fallaron.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "Agrega el comando /fichas al bot"
```

---

### Task 8: Documentación

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-11-descarga-fichas-design.md`

- [ ] **Step 1: Actualizar el README**

En `README.md`, en la sección `## Comandos del bot` (línea 25), agregá una
línea entre la de `/ciclos` (línea 29) y la de `/simular` (línea 30). El
formato de esa lista es `` - `/comando` — descripción `` en minúscula y sin
punto final:

```markdown
- `/fichas` — descarga tus fichas y constancias de INTRALU como PDF (bajo demanda)
```

El README no tiene sección de workflows ni de estructura de archivos, así que
no hay nada más que tocar ahí.

- [ ] **Step 2: Actualizar el CHANGELOG**

`CHANGELOG.md` sigue Keep a Changelog con versionado semántico; la última
versión es `[1.3.0] - 2026-08-11` (línea 8). Agregá una sección nueva justo
arriba de esa línea:

```markdown
## [1.4.0] - 2026-08-11

### Added

- **`/fichas`**: descarga las siete fichas académicas de INTRALU
  (`/informacion-academica/fichas`) y las manda al chat como PDF adjuntos,
  bajo demanda — dispara `descargar-fichas.yml`, que corre `fetch-fichas.js`
  con una sola sesión para todas. Nada se persiste: los bytes viven en el
  runner y se van con el job. Dos de las siete (Constancia de Matrícula y
  Constancia de Ingreso) están rotas del lado de INTRALU —devuelven 404 y
  500 con JSON en vez del PDF— y se reportan como tales en vez de abortar
  las demás.
- Primeros tests automatizados del proyecto, con `node --test` (stdlib, sin
  dependencias nuevas): `pnpm test`.
```

- [ ] **Step 3: Marcar el spec como implementado**

En `docs/superpowers/specs/2026-08-11-descarga-fichas-design.md`, cambiá la
línea de `**Estado:**` por:

```markdown
**Estado:** Implementado — ver
[`docs/superpowers/plans/2026-08-11-descarga-fichas.md`](../plans/2026-08-11-descarga-fichas.md).
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-08-11-descarga-fichas-design.md
git commit -m "Documenta el comando /fichas"
```

---

## Verificación final

- [ ] `pnpm test` pasa (7 tests).
- [ ] `pnpm run test-fichas` lista 7 fichas: 5 ✅ y 2 ⚠️.
- [ ] `/fichas` en Telegram entrega 5 PDFs y el aviso de las 2 rotas.
- [ ] Mandar `/fichas` dos veces seguidas no dispara dos jobs en paralelo
      (el segundo cancela al primero por el `concurrency group`).
- [ ] Un usuario no registrado que manda `/fichas` recibe "No estás
      registrado" con el botón de registro, y **no** dispara ningún workflow.

## Detalle heredado, fuera del alcance de este plan

`dispararFetchHistorial` (y ahora `dispararDescargaFichas`) hacen `return`
silencioso si falta `GITHUB_DISPATCH_TOKEN`: el usuario ve el "🔎
Buscando..." y no llega nunca nada. Ya pasa hoy con `/ciclos`. Arreglarlo es
un cambio aparte; si alguien toca esas funciones, aprovechar para avisarle al
usuario cuando el dispatch falla.
