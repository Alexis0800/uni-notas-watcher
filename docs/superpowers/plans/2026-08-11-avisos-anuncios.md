# Avisos de anuncios de INTRALU (`/avisos`) — Implementation Plan

**Estado: implementado** el 2026-08-11 en la rama
`claude/bot-file-downloads-notifications-rdoqdf`, salvo la migración SQL, que
es manual (Task 1, Step 3 — pendiente de correrla en el SQL Editor de
Supabase). Hasta que se corra, `check-anuncios.js` falla porque la columna
`avisos_activos` todavía no existe.

Divergencias menores respecto de lo escrito abajo:

- Los tests quedaron todos en un solo `test/anuncios.test.js` (17 tests) en
  vez de irse agregando por tarea.
- En `revisarUsuario` el diff (`nuevas(...)`) se calcula después del chequeo
  de `anuncios_seeded`, no antes — mismo comportamiento, un paso menos en la
  primera corrida.
- El script de `package.json` para tests es `node --test "test/*.test.js"`
  (con glob): sin él, el runner levanta los scripts de diagnóstico del root y
  se loguea de verdad contra INTRALU en cada `pnpm test`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el bot avise por Telegram, con el archivo adjunto incluido, cuando INTRALU publica un anuncio, reglamento, resolución o manual nuevo — y que cualquiera pueda apagar esos avisos con `/avisos` sin darse de baja del bot.

**Architecture:** Un workflow nuevo (`check-anuncios.yml`, cron cada hora) corre `check-anuncios.js`, que loguea a cada usuario activo **y suscrito**, lee la home de INTRALU (`/`), compara las publicaciones contra las que ya vio ese usuario (`usuarios.anuncios_vistos`) y manda solo las nuevas. Se revisa por usuario y no con una cuenta única porque no sabemos si la lista de anuncios es global o por facultad — así cada uno recibe lo que INTRALU le muestra a él.

**Tech Stack:** Node 22 (CommonJS), axios + axios-cookiejar-support, cheerio, Supabase (Postgres), GitHub Actions, Telegram Bot API. Tests con `node:test` (stdlib).

**Depende de:** [`2026-08-11-descarga-fichas.md`](2026-08-11-descarga-fichas.md) — de ahí sale `sendDocument()` en `lib/notificaciones.js`, que este plan reusa. Implementá ese primero.

---

## Contexto imprescindible para quien implemente

- **Todo verificado contra INTRALU el 2026-08-11** con `pnpm run test-explorar`.
  La home (`/`) tiene dos bloques con archivos: la tarjeta **Anuncios**
  (timeline con título, texto, fecha y adjuntos) y la tarjeta **Reglamentos y
  Resoluciones** (tres pestañas: Reglamentos, Resoluciones, Manuales).
- **El mecanismo de descarga es uno solo para los dos bloques**:
  `<a class="btn-file" data-codanu="..." data-extension="...">`, y el handler
  (en `/build/assets/home-*.js`) se reduce a un `GET
  /anuncio/download/{codanu}`. Probado con tres `codanu` reales: los tres
  devuelven 200 con `Content-Disposition`. No hay página índice —
  `/anuncio`, `/anuncios` y `/anuncio/listar` dan 404—, así que la lista
  **solo** se puede sacar del HTML de la home.
- **Los dos bloques tienen HTML distinto.** En Anuncios, el nombre del
  archivo está en un `<span class="fw-medium text-heading">` dentro del `<a>`.
  En Reglamentos no hay nombre: el `<a>` solo tiene un ícono, así que el
  nombre se arma con el título más `data-extension`.
- **Decisiones ya tomadas** (no las re-discutas): revisión por usuario cada
  hora; el aviso incluye el adjunto automáticamente; un solo switch para
  todos los avisos, activado por defecto.
- **Este workflow no toca `consecutive_failures` ni desactiva a nadie.** De
  eso se encarga `check-all-users.js`, que corre cada 5 min y ya tiene esa
  lógica. Acá un error de login se loguea y se sigue con el siguiente
  usuario — si las credenciales están mal de verdad, el chequeo de notas lo
  va a detectar y avisar por su cuenta.

## File Structure

| Archivo | Responsabilidad |
| --- | --- |
| `supabase/schema.sql` (modificar) | Tres columnas nuevas en `usuarios`: `avisos_activos`, `anuncios_vistos`, `anuncios_seeded`. Más el bloque de migración para la base ya desplegada. |
| `lib/session.js` (modificar) | `parsearPublicaciones(html)` (pura), `fetchPublicaciones(client)` (red) y `descargarAdjunto(client, codanu)` (red). Todo el conocimiento del HTML de INTRALU sigue viviendo acá. |
| `check-anuncios.js` (crear) | Orquesta la corrida por hora: usuarios suscritos → login → publicaciones → diff → avisar. Más las funciones puras `clavePublicacion`, `nuevas` y `recortarVistas`. |
| `test/anuncios.test.js` (crear) | Tests del parser y del diff, con un fixture del HTML real. Sin red. |
| `.github/workflows/check-anuncios.yml` (crear) | Cron cada hora. |
| `supabase/functions/telegram-webhook/index.ts` (modificar) | Comando `/avisos`, el callback del botón, y la línea en `AYUDA`. |
| `package.json` (modificar) | Script `check-anuncios`. |
| `README.md`, `CHANGELOG.md` (modificar) | Documentación. |

---

### Task 1: Schema — las tres columnas nuevas

**Files:**
- Modify: `supabase/schema.sql`

- [ ] **Step 1: Agregar las columnas a la definición de la tabla**

En `supabase/schema.sql`, dentro del `create table if not exists usuarios`,
justo después del bloque de `historial` (línea 22), agregá:

```sql
  -- Claves de las publicaciones de la home de INTRALU (anuncios,
  -- reglamentos, resoluciones, manuales) que este usuario ya recibió por
  -- Telegram, para no avisarle dos veces lo mismo. Formato de cada clave:
  -- "tipo|fecha|titulo" (ver clavePublicacion en check-anuncios.js). Se
  -- recorta a las últimas 100 para que no crezca sin fin.
  anuncios_vistos jsonb not null default '[]'::jsonb,
  -- false hasta la primera corrida de check-anuncios.js: esa primera vez
  -- solo guarda lo que ya está publicado, sin avisar nada — si no, alguien
  -- que se registra hoy recibiría de golpe todos los anuncios viejos.
  anuncios_seeded boolean not null default false,
  -- Switch de /avisos. Activado por defecto: los avisos son la razón de ser
  -- del bot. Apagarlo NO da de baja al usuario — las notificaciones de
  -- notas nuevas siguen llegando (para eso está /baja).
  avisos_activos boolean not null default true,
```

- [ ] **Step 2: Agregar las líneas al bloque de migración**

Al final del archivo, dentro del bloque comentado de migración (después de
la línea de `network_issue_notified`, línea 80), agregá:

```sql
-- alter table usuarios add column if not exists anuncios_vistos jsonb not null default '[]'::jsonb;
-- alter table usuarios add column if not exists anuncios_seeded boolean not null default false;
-- alter table usuarios add column if not exists avisos_activos boolean not null default true;
```

- [ ] **Step 3: Correr la migración en Supabase**

Andá al Dashboard de Supabase → SQL Editor → New query, y corré:

```sql
alter table usuarios add column if not exists anuncios_vistos jsonb not null default '[]'::jsonb;
alter table usuarios add column if not exists anuncios_seeded boolean not null default false;
alter table usuarios add column if not exists avisos_activos boolean not null default true;
```

Expected: `Success. No rows returned.`

Verificalo con:

```sql
select chat_id, avisos_activos, anuncios_seeded, anuncios_vistos from usuarios;
```

Expected: cada fila con `avisos_activos = true`, `anuncios_seeded = false`,
`anuncios_vistos = []`.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "Agrega columnas de avisos de anuncios a usuarios"
```

---

### Task 2: `parsearPublicaciones` — leer los dos bloques de la home

**Files:**
- Modify: `lib/session.js`
- Create: `test/anuncios.test.js`

- [ ] **Step 1: Escribir el test que falla**

Creá `test/anuncios.test.js`. El fixture es un recorte del HTML real de la
home (2026-08-11) con los dos bloques, incluido un anuncio sin adjuntos y una
pestaña vacía, que son los casos que rompen un parser ingenuo.

```js
const test = require('node:test');
const assert = require('node:assert');
const { parsearPublicaciones } = require('../lib/session');

// Recorte del HTML real de la home de INTRALU (2026-08-11).
const HTML_HOME = `
<div class="card h-100">
  <div class="card-header d-flex justify-content-between pb-2">
    <div class="card-title mb-1"><h5 class="m-0 me-2">Reglamentos y Resoluciones</h5></div>
  </div>
  <div class="card-body">
    <div class="nav-align-top">
      <ul class="nav nav-tabs nav-fill" role="tablist">
        <li class="nav-item"><button type="button" class="nav-link active" data-bs-target="#navs-justified-new">Reglamentos</button></li>
        <li class="nav-item"><button type="button" class="nav-link" data-bs-target="#navs-justified-link-preparing">Resoluciones</button></li>
      </ul>
      <div class="tab-content px-2 mx-1 pb-0">
        <div class="tab-pane fade show active" id="navs-justified-new">
          <ul class="list-unstyled mb-0">
            <li class="d-flex mb-4 pb-1 align-items-center">
              <div class="avatar flex-shrink-0 me-3">
                <a href="javascript:void(0)" class="avatar-initial rounded btn-file bg-label-primary"
                   data-codanu="18124" data-extension="pdf">
                  <span class="avatar-initial rounded bg-label-primary"><i class="ti ti-bookmarks ti-md"></i></span>
                </a>
              </div>
              <div class="row w-100 align-items-center">
                <div class="col-sm-8"><p class="mb-0 fw-medium">REGLAMENTO MATRICULA</p></div>
                <div class="col-sm-4"><div class="badge bg-label-secondary">07/02/2025</div></div>
              </div>
            </li>
          </ul>
        </div>
        <div class="tab-pane fade" id="navs-justified-link-preparing">
          <ul class="timeline mb-0 pb-1"><li class="text-center">Sin publicaciones</li></ul>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-header d-flex justify-content-between">
    <h5 class="card-title m-0 me-2 pt-1 mb-2 d-flex align-items-center">Anuncios</h5>
  </div>
  <div class="card-body pb-0">
    <ul class="timeline ms-1 mb-0">
      <li class="timeline-item timeline-item-transparent ps-4">
        <div class="timeline-event">
          <div class="timeline-header">
            <h6 class="mb-0">HORARIO ENTREGA DE EXAMENES 2026-1</h6>
            <small class="text-muted" title="27/07/2026">hace 2 semanas</small>
          </div>
          <p class="mb-2" style="width: 85%">PARA CONOCIMIENTO.</p>
          <div class="d-flex flex-wrap gap-2 pt-1">
            <a href="javascript:void(0)" class="me-1 badge bg-label-secondary btn-file"
               data-codanu="54480" data-extension="docx">
              <i class="ti ti-download me-1 ti-xs"></i>
              <span class="fw-medium text-heading">HORARIO ENTREGA DE EXAMENES 2026-1.docx</span>
            </a>
          </div>
        </div>
      </li>
      <li class="timeline-item timeline-item-transparent ps-4">
        <div class="timeline-event">
          <div class="timeline-header">
            <h6 class="mb-0">AVISO SIN ARCHIVO</h6>
            <small class="text-muted" title="01/08/2026">hace 1 semana</small>
          </div>
          <p class="mb-2" style="width: 85%">Solo texto, sin adjunto.</p>
        </div>
      </li>
    </ul>
  </div>
</div>
`;

test('parsearPublicaciones lee los anuncios del timeline con su adjunto', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  const anuncio = pubs.find((p) => p.titulo === 'HORARIO ENTREGA DE EXAMENES 2026-1');
  assert.deepStrictEqual(anuncio, {
    tipo: 'Anuncio',
    titulo: 'HORARIO ENTREGA DE EXAMENES 2026-1',
    fecha: '27/07/2026',
    texto: 'PARA CONOCIMIENTO.',
    adjuntos: [{ codanu: '54480', nombre: 'HORARIO ENTREGA DE EXAMENES 2026-1.docx' }],
  });
});

test('parsearPublicaciones acepta un anuncio sin adjuntos', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  const anuncio = pubs.find((p) => p.titulo === 'AVISO SIN ARCHIVO');
  assert.deepStrictEqual(anuncio.adjuntos, []);
  assert.strictEqual(anuncio.texto, 'Solo texto, sin adjunto.');
});

test('parsearPublicaciones lee los reglamentos y arma el nombre del archivo', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  const regl = pubs.find((p) => p.titulo === 'REGLAMENTO MATRICULA');
  assert.deepStrictEqual(regl, {
    tipo: 'Reglamentos',
    titulo: 'REGLAMENTO MATRICULA',
    fecha: '07/02/2025',
    texto: '',
    // En este bloque el <a> no trae el nombre del archivo, se arma
    // con el título y data-extension.
    adjuntos: [{ codanu: '18124', nombre: 'REGLAMENTO MATRICULA.pdf' }],
  });
});

test('parsearPublicaciones ignora las pestañas sin publicaciones', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  assert.ok(!pubs.some((p) => p.titulo === 'Sin publicaciones'));
  assert.strictEqual(pubs.length, 3);
});

test('parsearPublicaciones devuelve [] si el HTML cambió', () => {
  assert.deepStrictEqual(parsearPublicaciones('<html><body><p>nada</p></body></html>'), []);
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `pnpm test`
Expected: FAIL — `TypeError: parsearPublicaciones is not a function`

- [ ] **Step 3: Implementar el parser**

En `lib/session.js`, después de `descargarFicha` (agregada en el plan de
fichas), agregá:

```js
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
// que queda descartado porque no tiene título propio ni .btn-file.
//
// Verificado contra el sitio el 2026-08-11 (ver
// docs/superpowers/specs/2026-08-11-descarga-fichas-design.md#hallazgo-lateral-anuncios-y-documentos-del-home).
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
```

Agregá `parsearPublicaciones` al `module.exports`.

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS — los 5 tests nuevos pasan, más los del plan de fichas.

- [ ] **Step 5: Commit**

```bash
git add lib/session.js test/anuncios.test.js
git commit -m "Agrega parsearPublicaciones para los anuncios de la home"
```

---

### Task 3: `fetchPublicaciones` y `descargarAdjunto`

**Files:**
- Modify: `lib/session.js`
- Modify: `test/anuncios.test.js`

- [ ] **Step 1: Escribir el test que falla**

Agregá al final de `test/anuncios.test.js`:

```js
const { descargarAdjunto } = require('../lib/session');

function clienteFalso(respuesta) {
  return { get: async () => respuesta };
}

test('descargarAdjunto devuelve el buffer cuando INTRALU responde 200', async () => {
  const archivo = Buffer.from('contenido binario cualquiera');
  const res = await descargarAdjunto(clienteFalso({ status: 200, data: archivo }), '54480');
  assert.ok(Buffer.isBuffer(res));
  assert.strictEqual(res.toString(), 'contenido binario cualquiera');
});

test('descargarAdjunto devuelve null si el status no es 200', async () => {
  const res = await descargarAdjunto(clienteFalso({ status: 404, data: Buffer.from('') }), '999');
  assert.strictEqual(res, null);
});

test('descargarAdjunto devuelve null si el archivo viene vacío', async () => {
  const res = await descargarAdjunto(clienteFalso({ status: 200, data: Buffer.from('') }), '999');
  assert.strictEqual(res, null);
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `pnpm test`
Expected: FAIL — `TypeError: descargarAdjunto is not a function`

- [ ] **Step 3: Implementar las dos funciones**

En `lib/session.js`, después de `parsearPublicaciones`, agregá:

```js
async function fetchPublicaciones(client) {
  const res = await client.get(`${BASE_URL}/`);
  return parsearPublicaciones(res.data);
}

// Baja un adjunto de la home por su codanu. El endpoint sale del JS del
// propio sitio (/build/assets/home-*.js): el click en .btn-file termina
// siempre en GET /anuncio/download/{codanu}.
//
// A diferencia de las fichas, acá el tipo de archivo es variable (pdf, docx,
// jpg vistos en el sitio), así que no se puede validar por magic bytes — se
// valida status y que no venga vacío. `responseType: 'arraybuffer'` es
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
```

Agregá `fetchPublicaciones` y `descargarAdjunto` al `module.exports`.

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Verificar contra INTRALU de verdad**

Corré esto desde la raíz del repo (usa tu `.env`, no manda nada a Telegram):

```bash
node -e "require('dotenv').config();const{login,fetchPublicaciones,descargarAdjunto}=require('./lib/session');(async()=>{const c=await login(process.env.UNI_CODIGO,process.env.UNI_PASSWORD);const pubs=await fetchPublicaciones(c);console.log(JSON.stringify(pubs,null,2));for(const p of pubs)for(const a of p.adjuntos){const b=await descargarAdjunto(c,a.codanu);console.log(a.nombre,b?(b.byteLength/1024).toFixed(0)+' KB':'FALLO');}})()"
```

Expected: el JSON lista los anuncios y reglamentos con sus `codanu`, y cada
adjunto reporta su tamaño (los medidos el 2026-08-11: ~113 KB el `.docx`,
~123 KB el `.jpg`, ~2698 KB el reglamento en PDF).

- [ ] **Step 6: Commit**

```bash
git add lib/session.js test/anuncios.test.js
git commit -m "Agrega fetchPublicaciones y descargarAdjunto"
```

---

### Task 4: El diff — qué publicación es nueva

**Files:**
- Create: `check-anuncios.js` (solo las funciones puras por ahora)
- Modify: `test/anuncios.test.js`

- [ ] **Step 1: Escribir el test que falla**

Agregá al final de `test/anuncios.test.js`:

```js
const { clavePublicacion, nuevas, recortarVistas } = require('../check-anuncios');

const PUB_A = { tipo: 'Anuncio', titulo: 'HORARIO', fecha: '27/07/2026', texto: '', adjuntos: [] };
const PUB_B = { tipo: 'Anuncio', titulo: 'ENCUESTA', fecha: '04/07/2026', texto: '', adjuntos: [] };

test('clavePublicacion no depende de los adjuntos ni del texto', () => {
  const conAdjunto = { ...PUB_A, texto: 'otra cosa', adjuntos: [{ codanu: '1', nombre: 'x.pdf' }] };
  assert.strictEqual(clavePublicacion(PUB_A), clavePublicacion(conAdjunto));
});

test('clavePublicacion distingue publicaciones distintas', () => {
  assert.notStrictEqual(clavePublicacion(PUB_A), clavePublicacion(PUB_B));
});

test('nuevas devuelve solo las que no están en vistas', () => {
  const res = nuevas([PUB_A, PUB_B], [clavePublicacion(PUB_A)]);
  assert.deepStrictEqual(res, [PUB_B]);
});

test('nuevas devuelve todo si no se vio nada todavía', () => {
  assert.deepStrictEqual(nuevas([PUB_A, PUB_B], []), [PUB_A, PUB_B]);
});

test('nuevas devuelve [] si ya se vio todo', () => {
  const vistas = [clavePublicacion(PUB_A), clavePublicacion(PUB_B)];
  assert.deepStrictEqual(nuevas([PUB_A, PUB_B], vistas), []);
});

test('recortarVistas se queda con las últimas 100', () => {
  const claves = Array.from({ length: 130 }, (_, i) => `k${i}`);
  const res = recortarVistas(claves);
  assert.strictEqual(res.length, 100);
  assert.strictEqual(res[0], 'k30');
  assert.strictEqual(res[99], 'k129');
});

test('recortarVistas deja la lista igual si no llega al tope', () => {
  assert.deepStrictEqual(recortarVistas(['a', 'b']), ['a', 'b']);
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../check-anuncios'`

- [ ] **Step 3: Crear `check-anuncios.js` con las funciones puras**

Creá `check-anuncios.js` con exactamente esto (el `main()` se llena en la
Task 5):

```js
// Cuántas claves de publicaciones vistas se guardan por usuario. INTRALU
// publica del orden de un anuncio por semana, así que 100 son años de
// margen — el tope existe solo para que la columna no crezca sin fin.
const MAX_VISTAS = 100;

// Identifica una publicación sin depender del codanu: un anuncio puede no
// tener adjunto, y el texto del cuerpo podría editarse sin que sea una
// publicación nueva. Tipo + fecha + título es lo estable.
function clavePublicacion(pub) {
  return `${pub.tipo}|${pub.fecha}|${pub.titulo}`;
}

function nuevas(publicaciones, vistas) {
  const yaVistas = new Set(vistas);
  return publicaciones.filter((p) => !yaVistas.has(clavePublicacion(p)));
}

function recortarVistas(claves) {
  return claves.slice(-MAX_VISTAS);
}

module.exports = { clavePublicacion, nuevas, recortarVistas, MAX_VISTAS };
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add check-anuncios.js test/anuncios.test.js
git commit -m "Agrega el diff de publicaciones vistas para los avisos"
```

---

### Task 5: `check-anuncios.js` — la corrida completa

**Files:**
- Modify: `check-anuncios.js`
- Modify: `package.json`

- [ ] **Step 1: Escribir el script completo**

Reemplazá **todo** el contenido de `check-anuncios.js` por esto:

```js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchPublicaciones, descargarAdjunto } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, sendDocument } = require('./lib/notificaciones');

const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;

// Cuántas claves de publicaciones vistas se guardan por usuario. INTRALU
// publica del orden de un anuncio por semana, así que 100 son años de
// margen — el tope existe solo para que la columna no crezca sin fin.
const MAX_VISTAS = 100;

// Identifica una publicación sin depender del codanu: un anuncio puede no
// tener adjunto, y el texto del cuerpo podría editarse sin que sea una
// publicación nueva. Tipo + fecha + título es lo estable.
function clavePublicacion(pub) {
  return `${pub.tipo}|${pub.fecha}|${pub.titulo}`;
}

function nuevas(publicaciones, vistas) {
  const yaVistas = new Set(vistas);
  return publicaciones.filter((p) => !yaVistas.has(clavePublicacion(p)));
}

function recortarVistas(claves) {
  return claves.slice(-MAX_VISTAS);
}

// Escapa lo que va dentro de un mensaje con parse_mode HTML — los títulos
// los escribe la universidad, no nosotros, y un "&" o un "<" sueltos hacen
// que Telegram rechace el mensaje entero.
function escaparHtml(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mensajePublicacion(pub) {
  const encabezado = pub.tipo === 'Anuncio' ? '📢' : '📕';
  const lineas = [`${encabezado} <b>${escaparHtml(pub.titulo)}</b>`];
  if (pub.fecha) lineas.push(`<i>${escaparHtml(pub.fecha)}</i>`);
  if (pub.texto) lineas.push('', escaparHtml(pub.texto));
  return lineas.join('\n');
}

async function revisarUsuario(supabase, telegramToken, encryptionKey, usuario) {
  const { id, chat_id, codigo_uni, password_encrypted, anuncios_vistos, anuncios_seeded } = usuario;

  try {
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const publicaciones = await fetchPublicaciones(client);

    const vistas = Array.isArray(anuncios_vistos) ? anuncios_vistos : [];
    const pendientes = nuevas(publicaciones, vistas);

    // Primera corrida para este usuario: guardar lo que ya está publicado
    // sin avisar nada. Si no, alguien recién registrado recibiría de golpe
    // todos los anuncios viejos que INTRALU tenga en la home.
    if (!anuncios_seeded) {
      await supabase
        .from('usuarios')
        .update({
          anuncios_vistos: recortarVistas(publicaciones.map(clavePublicacion)),
          anuncios_seeded: true,
        })
        .eq('id', id);
      console.log(`🌱 ${chat_id} (${codigo_uni}): estado inicial guardado (${publicaciones.length} publicación/es)`);
      return;
    }

    if (pendientes.length === 0) {
      console.log(`✅ ${chat_id} (${codigo_uni}): sin novedades`);
      return;
    }

    for (const [indice, pub] of pendientes.entries()) {
      // El recordatorio de cómo apagarlos va una sola vez, pegado a la
      // última publicación de la tanda — repetirlo en cada mensaje sería
      // ruido, y no ponerlo nunca esconde el opt-out.
      const esUltima = indice === pendientes.length - 1;
      const pie = esUltima ? '\n\n🔕 Para dejar de recibir estos avisos: /avisos' : '';
      await sendTelegram(telegramToken, chat_id, mensajePublicacion(pub) + pie);

      for (const adjunto of pub.adjuntos) {
        const archivo = await descargarAdjunto(client, adjunto.codanu);
        if (!archivo) {
          console.error(`⚠️ ${chat_id}: no pude bajar ${adjunto.nombre} (codanu ${adjunto.codanu})`);
          continue;
        }
        await sendDocument(telegramToken, chat_id, archivo, adjunto.nombre);
      }
    }

    // Se marcan como vistas TODAS las publicaciones de la página, no solo
    // las que se mandaron: si un adjunto falló, el aviso ya se entregó igual
    // y reintentarlo la hora siguiente sería mandar el mismo mensaje de nuevo.
    await supabase
      .from('usuarios')
      .update({ anuncios_vistos: recortarVistas([...vistas, ...pendientes.map(clavePublicacion)]) })
      .eq('id', id);

    console.log(`📢 ${chat_id} (${codigo_uni}): ${pendientes.length} publicación(es) nueva(s)`);
  } catch (err) {
    // A propósito no se toca consecutive_failures ni active: de desactivar
    // usuarios con credenciales malas se encarga check-all-users.js, que
    // corre cada 5 min. Acá un fallo solo significa que este usuario se
    // pierde esta pasada; la próxima hora se reintenta solo, y como
    // anuncios_vistos no se actualizó, no se pierde ningún aviso.
    console.error(`❌ ${chat_id} (${codigo_uni}): ${err.message}`);
  }
}

// Corrido por .github/workflows/check-anuncios.yml, una vez por hora.
// Revisa la home de INTRALU de cada usuario activo y suscrito, y le manda
// las publicaciones que todavía no vio. Se revisa por usuario (y no con una
// sola cuenta haciendo broadcast) porque no sabemos si la lista de anuncios
// es global o depende de la facultad.
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY o TELEGRAM_TOKEN en el entorno');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('active', true)
    .eq('avisos_activos', true);
  if (error) throw error;

  console.log(`Revisando anuncios de ${usuarios.length} usuario(s) suscrito(s)...`);

  const start = Date.now();
  for (let i = 0; i < usuarios.length; i += CONCURRENCY) {
    const batch = usuarios.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => revisarUsuario(supabase, TELEGRAM_TOKEN, CREDENTIALS_ENCRYPTION_KEY, u)));
  }

  console.log(`Listo en ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

module.exports = { clavePublicacion, nuevas, recortarVistas, mensajePublicacion, escaparHtml, MAX_VISTAS };

// Solo corre si lo invocan directo, no cuando test/anuncios.test.js lo
// importa para probar las funciones puras.
if (require.main === module) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Agregar un test del armado del mensaje**

Agregá al final de `test/anuncios.test.js`:

```js
const { mensajePublicacion } = require('../check-anuncios');

test('mensajePublicacion arma el texto con título, fecha y cuerpo', () => {
  const texto = mensajePublicacion({
    tipo: 'Anuncio',
    titulo: 'HORARIO ENTREGA DE EXAMENES 2026-1',
    fecha: '27/07/2026',
    texto: 'PARA CONOCIMIENTO.',
    adjuntos: [],
  });
  assert.strictEqual(
    texto,
    '📢 <b>HORARIO ENTREGA DE EXAMENES 2026-1</b>\n<i>27/07/2026</i>\n\nPARA CONOCIMIENTO.',
  );
});

test('mensajePublicacion escapa el HTML que venga en el título', () => {
  const texto = mensajePublicacion({
    tipo: 'Anuncio',
    titulo: 'MATRÍCULA <2026> & OTROS',
    fecha: '',
    texto: '',
    adjuntos: [],
  });
  assert.strictEqual(texto, '📢 <b>MATRÍCULA &lt;2026&gt; &amp; OTROS</b>');
});
```

- [ ] **Step 3: Agregar el script a `package.json`**

En `"scripts"`, después de `"fetch-fichas"`, agregá:

```json
    "check-anuncios": "node check-anuncios.js"
```

- [ ] **Step 4: Correr los tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Probar la corrida de punta a punta**

Con `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CREDENTIALS_ENCRYPTION_KEY` y `TELEGRAM_TOKEN` en tu `.env`:

Run: `pnpm run check-anuncios`
Expected (primera vez): `🌱 <chat_id> (<código>): estado inicial guardado (3
publicación/es)` y **ningún mensaje en Telegram**.

Ahora forzá un aviso: en el SQL Editor de Supabase, borrá una clave de las
vistas para simular una publicación nueva.

```sql
update usuarios set anuncios_vistos = '[]'::jsonb where chat_id = <TU_CHAT_ID>;
```

Run: `pnpm run check-anuncios`
Expected: llegan al chat los 3 mensajes con sus adjuntos (el `.docx`, el
`.jpg` y el PDF del reglamento), y el último trae la línea `🔕 Para dejar de
recibir estos avisos: /avisos`.

Corré una tercera vez sin tocar nada:

Run: `pnpm run check-anuncios`
Expected: `✅ <chat_id> (<código>): sin novedades` y nada en Telegram.

- [ ] **Step 6: Commit**

```bash
git add check-anuncios.js test/anuncios.test.js package.json
git commit -m "Agrega check-anuncios.js: avisa las publicaciones nuevas de INTRALU"
```

---

### Task 6: El workflow por hora

**Files:**
- Create: `.github/workflows/check-anuncios.yml`

- [ ] **Step 1: Crear el workflow**

```yaml
name: Check anuncios

# Revisa una vez por hora la home de INTRALU de cada usuario suscrito y le
# manda las publicaciones (anuncios, reglamentos, resoluciones, manuales) que
# todavía no vio. Cada hora y no cada 5 min como el chequeo de notas: INTRALU
# publica del orden de un anuncio por semana, y cada corrida cuesta un login
# por usuario contra un sitio que ya se cae solo (ver
# docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md).
#
# Sin cancel-in-progress: si una corrida se pasa de la hora, la siguiente
# espera en vez de matarla a mitad de mandar avisos.

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

concurrency:
  group: check-anuncios
  cancel-in-progress: false

jobs:
  check-anuncios:
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

      - name: Run check-anuncios
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
        run: pnpm run check-anuncios
```

- [ ] **Step 2: Commit y push**

```bash
git add .github/workflows/check-anuncios.yml
git commit -m "Agrega workflow check-anuncios.yml (cada hora)"
```

- [ ] **Step 3: Probarlo a mano desde GitHub**

Actions → "Check anuncios" → "Run workflow".
Expected: el job termina en verde y el log dice `Revisando anuncios de N
usuario(s) suscrito(s)...` seguido de `✅ ... sin novedades`.

---

### Task 7: El comando `/avisos` y su botón

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Agregar el armado del mensaje de estado**

Justo antes de `function botonRegistrar()` (línea 193), agregá:

```ts
// Estado de la suscripción a avisos, con el botón que lo invierte. Un solo
// switch para todo (anuncios, reglamentos, resoluciones, manuales): INTRALU
// publica poco y separar por tipo serían cuatro columnas y cuatro botones
// para nada. Apagarlo NO da de baja al usuario — las notas siguen llegando.
function mensajeAvisos(activos: boolean) {
  return {
    texto: activos
      ? '📢 Avisos de INTRALU: <b>ACTIVADOS</b>\n\nTe aviso cuando publiquen un anuncio, reglamento o resolución nuevo, con el archivo adjunto.\n\nEsto no afecta a tus notas: esas te siguen llegando igual.'
      : '🔕 Avisos de INTRALU: <b>DESACTIVADOS</b>\n\nNo te voy a avisar de anuncios nuevos.\n\nTus notas te siguen llegando igual.',
    markup: {
      inline_keyboard: [
        [
          activos
            ? { text: '🔕 Desactivar avisos', callback_data: 'avisos:off' }
            : { text: '🔔 Activar avisos', callback_data: 'avisos:on' },
        ],
      ],
    },
  };
}
```

- [ ] **Step 2: Manejar el callback del botón**

En `manejarCallbackQuery` (línea 158), reemplazá el arranque actual:

```ts
  const data = callbackQuery.data as string | undefined;
  if (!data || !data.startsWith('ciclo:')) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }
```

por:

```ts
  const data = callbackQuery.data as string | undefined;

  if (data?.startsWith('avisos:')) {
    const activar = data.slice('avisos:'.length) === 'on';
    const chatIdAvisos = callbackQuery.from.id;
    await answerCallbackQuery(callbackQuery.id);
    await supabase.from('usuarios').update({ avisos_activos: activar }).eq('chat_id', chatIdAvisos);
    const { texto, markup } = mensajeAvisos(activar);
    const messageIdAvisos = callbackQuery.message?.message_id as number | undefined;
    if (messageIdAvisos) {
      // Se edita el mensaje original en vez de mandar uno nuevo, así el chat
      // no se llena de estados viejos cada vez que alguien toca el botón.
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatIdAvisos,
          message_id: messageIdAvisos,
          text: texto,
          parse_mode: 'HTML',
          reply_markup: markup,
        }),
      });
    } else {
      await sendMessage(chatIdAvisos, texto, markup);
    }
    return;
  }

  if (!data || !data.startsWith('ciclo:')) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }
```

- [ ] **Step 3: Agregar el comando**

En el `Deno.serve`, después de la rama de `/fichas` (agregada en el plan de
fichas) y antes de la de `/simular`, agregá:

```ts
  } else if (text === '/avisos') {
    const { data } = await supabase.from('usuarios').select('avisos_activos').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const { texto, markup } = mensajeAvisos(data.avisos_activos !== false);
      await sendMessage(chatId, texto, markup);
    }
```

- [ ] **Step 4: Agregar la línea a la ayuda**

En la constante `AYUDA`, después de la línea de `/fichas`, agregá:

```
<b>/avisos</b> — activa o desactiva los avisos de anuncios de INTRALU
```

- [ ] **Step 5: Desplegar y probar**

Run: `pnpm dlx supabase functions deploy telegram-webhook`

En Telegram:
1. `/avisos` → responde "📢 Avisos de INTRALU: ACTIVADOS" con el botón
   "🔕 Desactivar avisos".
2. Tocá el botón → el mismo mensaje se edita a "DESACTIVADOS" y el botón
   pasa a "🔔 Activar avisos".
3. Verificá en Supabase: `select avisos_activos from usuarios where chat_id
   = <TU_CHAT_ID>;` → `false`.
4. Corré `pnpm run check-anuncios` → el log dice `Revisando anuncios de 0
   usuario(s) suscrito(s)...`.
5. Volvé a tocar el botón para reactivarlos y confirmá que vuelve a `true`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "Agrega el comando /avisos con opt-out de anuncios"
```

---

### Task 8: Documentación

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-11-descarga-fichas-design.md`

- [ ] **Step 1: Actualizar el README**

En `README.md`, en la sección `## Comandos del bot`, agregá una línea justo
después de la de `/fichas` (que agregó el plan anterior). El formato de esa
lista es `` - `/comando` — descripción `` en minúscula y sin punto final:

```markdown
- `/avisos` — activa o desactiva los avisos de anuncios nuevos de INTRALU
```

El README no tiene sección de workflows, así que no hay nada más que tocar.

- [ ] **Step 2: Actualizar el CHANGELOG**

`CHANGELOG.md` sigue Keep a Changelog. Agregá una sección nueva arriba de
`## [1.4.0] - 2026-08-11` (la que agregó el plan de fichas):

```markdown
## [1.5.0] - 2026-08-11

### Added

- **Avisos de anuncios de INTRALU**: `check-anuncios.yml` revisa cada hora la
  home de cada usuario suscrito y le manda por Telegram los anuncios,
  reglamentos, resoluciones y manuales nuevos, con su archivo adjunto
  incluido (`GET /anuncio/download/{codanu}`). Se revisa por usuario y no con
  una cuenta única porque no se pudo confirmar si la lista es global o por
  facultad. La primera corrida de cada usuario solo guarda el estado, sin
  avisar, para no mandar de golpe todo lo viejo.
- **`/avisos`**: activa o desactiva esos avisos sin darse de baja del bot —
  las notificaciones de notas nuevas siguen llegando igual. Nuevas columnas
  `avisos_activos`, `anuncios_vistos` y `anuncios_seeded` en `usuarios`
  (migración manual, ver `supabase/schema.sql`).
```

- [ ] **Step 3: Cerrar el hallazgo en el spec**

En `docs/superpowers/specs/2026-08-11-descarga-fichas-design.md`, en la
sección "Hallazgo lateral: anuncios y documentos del home", reemplazá el
párrafo final que empieza con "**Esto da para un spec propio, no para meterlo
acá**" por:

```markdown
**Implementado como feature aparte**, ver
[`docs/superpowers/plans/2026-08-11-avisos-anuncios.md`](../plans/2026-08-11-avisos-anuncios.md):
revisión por usuario cada hora, aviso con el adjunto incluido, y opt-out con
`/avisos`. Se decidió revisar por usuario (en vez de una cuenta única
haciendo broadcast) justamente porque no se pudo confirmar si la lista es
global o por facultad.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-08-11-descarga-fichas-design.md
git commit -m "Documenta los avisos de anuncios y /avisos"
```

---

## Verificación final

- [ ] `pnpm test` pasa (parser, diff y armado de mensajes).
- [ ] Primera corrida de `check-anuncios` no manda nada y deja
      `anuncios_seeded = true`.
- [ ] Con `anuncios_vistos` vaciado a mano, la corrida manda cada publicación
      con su adjunto y el pie de `/avisos` solo en la última.
- [ ] La corrida siguiente no repite nada.
- [ ] `/avisos` muestra el estado y el botón lo invierte editando el mismo
      mensaje.
- [ ] Con los avisos apagados, `check-anuncios` reporta 0 usuarios suscritos.
- [ ] Un usuario con la contraseña mal no rompe la corrida de los demás (el
      error se loguea y sigue).

## Riesgos conocidos

- **No sabemos si los anuncios son globales o por facultad.** Por eso se
  revisa por usuario, que es correcto en los dos casos pero cuesta un login
  por usuario por hora. Si algún día se confirma que son globales, se puede
  cambiar a una sola lectura + broadcast y ahorrar casi todo ese costo.
- **Costo contra INTRALU**: 24 logins por usuario por día, encima de los 288
  que ya hace el chequeo de notas. Con pocos usuarios no es nada; si la base
  crece, conviene copiar el batching por antigüedad de `check-all-users.js`
  (`MAX_BATCH_SIZE`) para acotar cada corrida.
- **El HTML de la home puede cambiar** y el parser devolvería `[]` en
  silencio (sin avisos, sin error). Si se quiere detectar eso, el lugar es un
  log de "0 publicaciones encontradas" que hoy no distingue "no hay nada" de
  "cambió el HTML".
