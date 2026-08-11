# Descarga de fichas desde el bot (`/fichas`) — Implementation Plan

**Estado: implementado** el 2026-08-11 en la rama
`claude/bot-file-downloads-notifications-rdoqdf`. Este documento quedó como
registro de lo construido y de por qué; el código es la fuente de verdad.

**Goal:** Que `/fichas` liste las fichas de `/informacion-academica/fichas`
como botones, y que al tocar una el bot la baje de INTRALU y la mande al chat
como PDF — avisando en el momento si esa ficha puntual falla.

**Architecture:** Mismo patrón que `/ciclos`: la Edge Function (Deno) no
puede loguearse contra INTRALU, así que muestra los botones al instante desde
un catálogo fijo y, al tocar uno, dispara `descargar-fichas.yml` vía
`workflow_dispatch` con el id de esa ficha. `fetch-fichas.js` desencripta la
contraseña, hace `login()`, busca esa ficha en la página real, la baja y la
sube a Telegram con `sendDocument`. Nada se persiste: los bytes viven en
memoria del runner y se van con el job.

**Tech Stack:** Node 22 (CommonJS), axios + axios-cookiejar-support, cheerio,
Supabase JS, GitHub Actions, Telegram Bot API. Tests con `node:test` (stdlib).

**Spec:** [`2026-08-11-descarga-fichas-design.md`](../specs/2026-08-11-descarga-fichas-design.md)

---

## La decisión que definió el diseño

El borrador de este plan mandaba **todas** las fichas de una, sin botones,
porque un picker cuesta un workflow + login completo (~1 min) por archivo.

Se cambió a botones por pedido explícito: **listar todos los documentos,
incluidos los que fallan, y descubrir el error recién al tocar cada uno.**

Lo medido durante la implementación terminó dándole la razón al picker. El
mismo día, con unas horas de diferencia:

- La página pasó de ofrecer **7 tarjetas a ofrecer 6** (Constancia de Ingreso
  desapareció).
- **Constancia de Matrícula pasó de devolver 404 a entregar el PDF** sin
  problema (177 KB).

O sea: no hay un conjunto estable de "fichas rotas" que se pueda esconder de
la lista. Mandar todo de una habría significado mandar errores de golpe cada
vez, y filtrar las "rotas" habría escondido fichas que sí funcionan. Con
botones, cada intento reporta su propio estado en el momento.

## Cómo quedó el flujo

1. `/fichas` responde al instante con un botón por ficha (7 filas), sin
   tocar INTRALU.
2. Al tocar uno: `answerCallbackQuery` + mensaje `🔎 Buscando <ficha>...` y
   `workflow_dispatch` de `descargar-fichas.yml` con `chat_id` y `ficha_id`.
   **El mensaje con los botones no se edita**, así queda usable para pedir
   varias fichas seguidas.
3. `fetch-fichas.js` loguea, lista las fichas reales de la página y busca la
   pedida por el último segmento de su URL. Tres desenlaces:
   - **La encuentra y baja bien** → `sendDocument` con caption `📄 <nombre>`.
   - **Ya no está en la página** → le responde con las que sí hay ahora y le
     sugiere `/fichas` para ver los botones actualizados.
   - **Está pero no devuelve PDF** → le avisa que falla del lado de INTRALU,
     no de su cuenta, y que a veces funciona un rato después.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| [`lib/session.js`](../../../lib/session.js) | `parsearFichas(html)` (pura), `fetchFichas(client)`, `descargarFicha(client, url)`. Único lugar con conocimiento del HTML de INTRALU. |
| [`lib/notificaciones.js`](../../../lib/notificaciones.js) | `sendDocument(...)` — los adjuntos van en `multipart/form-data`; `FormData`/`Blob` son globales en Node 22, sin dependencias nuevas. |
| [`fetch-fichas.js`](../../../fetch-fichas.js) | Baja **una** ficha de **un** usuario por corrida. Espejo de `fetch-historial.js`, incluido su bloque `catch`. |
| [`.github/workflows/descargar-fichas.yml`](../../../.github/workflows/descargar-fichas.yml) | `workflow_dispatch` con `chat_id` + `ficha_id`; `concurrency` scopeado a ese par. |
| [`supabase/functions/telegram-webhook/index.ts`](../../../supabase/functions/telegram-webhook/index.ts) | Catálogo `FICHAS`, comando `/fichas`, rama `ficha:` en `manejarCallbackQuery`, `dispararDescargaFicha()`, línea en `AYUDA`. |
| [`test/fichas.test.js`](../../../test/fichas.test.js) | 8 tests de lógica pura, sin red (`descargarFicha` se prueba con un cliente falso). |

## Tareas ejecutadas

- [x] **T1** — `parsearFichas` + primeros tests del proyecto (`pnpm test`).
- [x] **T2** — `fetchFichas` y `descargarFicha` en `lib/session.js`.
- [x] **T3** — `sendDocument` en `lib/notificaciones.js`.
- [x] **T4** — `nombreArchivo` (NFD + `\p{Diacritic}`, sin dependencias).
- [x] **T5** — `fetch-fichas.js` por ficha + script `fetch-fichas`.
- [x] **T6** — `descargar-fichas.yml`.
- [x] **T7** — `/fichas` con botones y callback en la Edge Function.
- [x] **T8** — README, CHANGELOG y spec.

## Detalles que costaron y conviene no volver a descubrir

- **`node --test` a secas levanta los scripts de diagnóstico del root.**
  `login-test.js`, `fichas-test.js` y `explorar-test.js` matchean el patrón
  por defecto del runner: la primera corrida se logueó tres veces contra
  INTRALU y tardó 48s. Por eso el script es
  `node --test "test/*.test.js"` con el glob entre comillas (en Windows la
  expansión la tiene que hacer Node, no la shell — y `node --test test/`
  falla con `MODULE_NOT_FOUND`).
- **`responseType: 'arraybuffer'` es obligatorio** o axios interpreta el PDF
  como texto UTF-8 y lo corrompe.
- **Timeout por request (60s)**, no el de `newClient()` (20s): se midieron
  fichas de hasta 7.6s y INTRALU las genera al vuelo.
- **Un 200 no garantiza un PDF**: una sesión vencida devuelve el HTML del
  login con status 200. Por eso se validan los primeros 4 bytes (`%PDF`).
- **El `ficha_id` nunca se concatena a una URL.** Se usa para buscar entre
  las fichas que la página realmente ofrece, así que un valor basura no
  puede apuntar el scraper a ningún lado.

## Verificado contra INTRALU real

- `pnpm test` → 8 tests en verde.
- `FICHA_ID=ficha-academica-pdf` → `✅ Ficha Académica enviada (88 KB)`, PDF
  recibido en Telegram.
- `FICHA_ID=constancia-ingreso-pdf` (ya no listada) → responde con las 6
  disponibles, sin error.
- El camino "está listada pero no devuelve PDF" está cubierto por test
  unitario; no se pudo forzar contra el sitio real porque ese día todas las
  fichas listadas funcionaban.

## Detalle heredado, fuera del alcance

`dispararFetchHistorial` y `dispararDescargaFicha` hacen `return` silencioso
si falta `GITHUB_DISPATCH_TOKEN`: el usuario ve el "🔎 Buscando..." y no llega
nunca nada. Ya pasaba con `/ciclos`. Si alguien toca esas funciones, avisarle
al usuario cuando el dispatch falla.
