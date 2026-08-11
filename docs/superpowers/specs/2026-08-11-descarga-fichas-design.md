# Descarga de fichas/documentos desde el bot

**Fecha:** 2026-08-11
**Planes de implementación:**
[`2026-08-11-descarga-fichas.md`](../plans/2026-08-11-descarga-fichas.md)
(comando `/fichas`) y
[`2026-08-11-avisos-anuncios.md`](../plans/2026-08-11-avisos-anuncios.md)
(avisos de anuncios + `/avisos`, nacido del hallazgo lateral de más abajo).

**Estado:** Implementado (2026-08-11). La estructura real de
`/informacion-academica/fichas` ya se verificó contra el sitio con
`pnpm run test-fichas` (ver "Investigación (resuelta)"), así que esto ya
puede pasarse a un plan de implementación tarea por tarea, como se hizo
con [`2026-07-17-avisos-caida-intralu-design.md`](2026-07-17-avisos-caida-intralu-design.md).

## Contexto y motivación

INTRALU (`alumnos.uni.edu.pe`) es lento y a veces se cae por horas (ver
`docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md`). El bot
ya reemplaza al sitio para lo más consultado: ver notas (`/notas`),
simular (`/simular`), ver ciclos pasados (`/ciclos`) — todo sin tener que
entrar a la web ni esperar a que cargue. La idea de este spec es dar el
siguiente paso: que también se pueda descargar documentos (fichas) desde
`/informacion-academica/fichas` directamente por Telegram, sin pasar por
el sitio.

**Visión más amplia (fuera del alcance de este spec, pero el motivo de
fondo):** que el bot termine cubriendo cada vez más de lo que hoy solo se
puede hacer entrando a INTRALU, para que en el día a día casi no haga
falta abrir el sitio. Este spec cubre solo el primer paso concreto
(descargar fichas) — cualquier otra página de INTRALU que se quiera cubrir
después (constancias, historial completo, etc.) es un spec aparte, mismo
patrón.

## Alcance

**Dentro de este spec:**
- Un comando nuevo (`/fichas`, nombre tentativo) que liste los documentos
  disponibles en `/informacion-academica/fichas` para el usuario logueado
  y permita descargar uno (o todos) directo al chat de Telegram como
  archivo adjunto.
- Solo lectura/descarga — no se sube ni se modifica nada en INTRALU.

**Fuera de alcance (por ahora):**
- Cualquier otra página de INTRALU que no sea `/informacion-academica/fichas`.
- Automatizar trámites, matrícula, o cualquier acción que no sea "traer un
  archivo que ya existe".
- Guardar los documentos descargados en algún lado persistente (Supabase,
  GitHub, etc.) — se traen y se mandan al chat, nada más. Ver
  "Decisiones de diseño" para el porqué.

## Investigación (resuelta)

Verificado el 2026-08-11 contra el sitio real con `pnpm run test-fichas`
(`fichas-test.js`, corrido localmente con el `.env` de siempre — la
contraseña nunca salió del disco, ver `docs/SECURITY.md`).

**La página es estática y trivial de scrapear.** Siete tarjetas, cada una
con su título en `.card-title` y un `<a>` a un PDF. No hay POST, ni CSRF,
ni JS: son links `GET` directos que solo necesitan la cookie de sesión.

| Ficha | Ruta (bajo `/informacion-academica/`) | Mañana | Tarde |
| --- | --- | --- | --- |
| Ficha Datos Personales | `ficha-datos-pdf` | ✅ 189 KB | ✅ |
| Ficha Académica | `ficha-academica-pdf` | ✅ 88 KB | ✅ |
| Ficha Académica Depurada | `ficha-academica-depurada-pdf` | ✅ 82 KB | ✅ |
| Avance Curricular | `avance-curricular-pdf` | ✅ 85 KB | ✅ |
| Adeudos | `adeudo-academico-pdf` | ✅ 74 KB | ✅ |
| Constancia de Matrícula | `constancia-matricula-pdf` | ❌ 404 `{"message":""}` | ✅ 177 KB |
| Constancia de Ingreso | `constancia-ingreso-pdf` | ❌ 500 `{"message":"Server Error"}` | ya no se lista |

**Ni la lista ni el estado de cada ficha son estables.** Las dos columnas de
arriba son el mismo día con unas horas de diferencia: la página pasó de
ofrecer 7 tarjetas a ofrecer 6 (Constancia de Ingreso desapareció) y
Constancia de Matrícula pasó de devolver 404 a entregar el PDF sin
problema. Cualquier diseño que asuma una lista fija de siete, o un conjunto
fijo de "rotas", se rompe solo.

Respuestas a lo que estaba abierto:

1. **Qué hay**: hasta 7 documentos, en tarjetas. **La lista cambia sola** y
   algunas fichas fallan de forma intermitente, devolviendo JSON de error
   con `Content-Type: application/json` en vez del PDF (ver la tabla). Como
   sea, **el bot tiene que tolerarlo**: no asumir que un 200 implica PDF
   (ver "Cómo detectar una ficha rota"), no asumir que la ficha que el
   usuario pidió sigue existiendo, y decirle que la falla es de INTRALU y
   no de su cuenta.
2. **Cómo se obtiene**: `GET` directo, sin token. Nada que replicar más
   allá de reusar el cliente de `login()`.
3. **Formato y tamaño**: `application/pdf`, 74–189 KB. Muy por debajo de
   los 50 MB de `sendDocument` — no hace falta pensar en límites. Tardan
   1.4–6.8 s cada uno (INTRALU los genera al vuelo).
4. **Re-login**: no hace falta. Una sola sesión bajó los 5 PDFs seguidos
   sin problema, así que traer todos de una corrida es gratis.

### Cómo detectar una ficha rota

Los dos casos que fallan mandan `Content-Type: application/json` con
status 404/500. Con `validateStatus: () => true` (o un `try`), alcanza
con chequear `res.status === 200` y que los primeros 4 bytes sean
`%PDF` — un HTML de sesión expirada devuelto con 200 también quedaría
descartado por esa segunda condición.

## Diseño propuesto

### Por qué el login no puede vivir en la Edge Function

`telegram-webhook/index.ts` corre en Deno (Supabase Edge Functions) y
**nunca** hace login contra INTRALU — esa lógica vive únicamente en
`lib/session.js` (Node), consumida por `check-all-users.js` y
`fetch-historial.js`, corridos por GitHub Actions. Es una decisión ya
tomada del proyecto (ver `README.md#stack` y `CONTRIBUTING.md`): el
scraping existe en un solo lugar, probado contra el sitio real. Este
feature sigue el mismo patrón en vez de duplicar el login en Deno.

### Flujo (mismo patrón que `/ciclos` + `fetch-historial.yml`)

1. Usuario manda `/fichas` al bot.
2. `telegram-webhook/index.ts` responde algo como "🔎 Buscando tus fichas,
   puede tardar unos minutos..." y dispara un workflow nuevo
   (`descargar-fichas.yml`) vía `workflow_dispatch`, pasándole `chat_id`
   — mismo mecanismo que `dispararFetchHistorial()` (líneas 135-155 de
   `telegram-webhook/index.ts`).
3. El workflow corre un script nuevo en Node (`fetch-fichas.js`, mismo
   nivel que `fetch-historial.js`): desencripta la contraseña del usuario
   (`lib/crypto.js`), hace `login()` (`lib/session.js`), entra a
   `/informacion-academica/fichas` y arma la lista de documentos
   disponibles.
4. Descarga **todas** las fichas con la misma sesión ya logueada y las
   manda por Telegram una por una (`sendDocument`, subiendo los bytes —
   no un link, porque Telegram no tiene la cookie de sesión de INTRALU
   para bajarlo solo). Son 5 PDFs de ~100 KB: no hay motivo para
   preguntar cuál quiere.
5. Cierra con un mensaje que liste las fichas que no pudo traer (las que
   INTRALU devolvió rotas), para que el usuario no se quede esperando una
   que nunca va a llegar.

### Sin botones para elegir ficha (descartado)

Un borrador anterior proponía ofrecer botones (`callback_query`, como
`/ciclos`) para elegir qué ficha bajar. Se descartó al medir el costo
real: el `callback_query` lo maneja la Edge Function, que **no puede
loguearse** (ver arriba), así que cada botón tendría que disparar el
workflow otra vez — checkout + `pnpm install` + login + generación del
PDF, ~1 min por archivo. Todo eso para ahorrar mandar 5 adjuntos de
~100 KB que Telegram entrega en segundos. Mandar todo de una es menos
código, menos latencia y menos requests contra INTRALU.

Vale la pena reconsiderarlo solo si en otra cuenta aparecen muchas más
fichas, o mucho más pesadas, que en la que se probó.

### Manejo de errores

Mismo bloque `catch` que `fetch-historial.js` (líneas 87-105):
`isNetworkError` → "INTRALU no responde", `CredentialError` → "revisa tu
código y contraseña con /registrar", cualquier otra cosa → mensaje
genérico; el `err.message` crudo queda solo en el log de Actions.

Aparte de eso, y a diferencia de `/ciclos`, acá hay **fallas parciales**:
una ficha puede venir rota (404/500, ver "Cómo detectar una ficha rota")
sin que eso invalide las otras. Una ficha rota no aborta la corrida — se
saltea, se sigue con las demás, y se nombra al final.

### Decisiones de diseño

- **Nada de documentos persistidos en Supabase/GitHub**: se descargan en
  memoria (o `/tmp` del runner de GitHub Actions, que se destruye al
  terminar el job) y se mandan directo a Telegram — no hay motivo para
  guardarlos en ningún lado nuestro, y evita tener que pensar en cifrado
  o retención de archivos con datos personales del alumno.
- **Reutiliza las credenciales ya guardadas**: no hace falta pedirle nada
  nuevo al usuario — mismo `codigo_uni`/`password_encrypted` que ya usa
  el chequeo de notas.
- **Bajo demanda, no en el chequeo de 5 min**: a diferencia de las notas
  (que se revisan solas cada 5 min), las fichas no cambian tan seguido —
  tiene más sentido pedirlas solo cuando el usuario las pide, igual que
  `/ciclos` con `fetch-historial.yml`.

## Alternativas consideradas

- **Mandar el link directo de INTRALU en vez de subir el archivo**:
  descartado — el link requiere la cookie de sesión del login, que
  Telegram (ni el navegador del usuario, si ya cerró sesión) no tiene. Hay
  que bajar los bytes nosotros y subirlos como documento.
- **Loguear desde la Edge Function (Deno)**: descartado por romper la
  regla ya establecida del proyecto de un solo lugar para el scraping
  (`lib/session.js`, Node) — ver "Por qué el login no puede vivir en la
  Edge Function".

## Piezas que hay que tocar (checklist para el plan)

- `lib/session.js`: `fetchFichas(client)` (ya escrita y probada en
  `fichas-test.js`, mover tal cual) + la descarga de un PDF con
  `responseType: 'arraybuffer'` y `timeout` propio — **los 20 s fijos de
  `newClient()` se quedan cortos**: la ficha más lenta tardó 6.8 s pero
  INTRALU degradado puede pasarse. Se sobrescribe por request, no se toca
  el timeout global.
- `lib/notificaciones.js`: falta `sendDocument`. `sendTelegram` solo hace
  `sendMessage` con JSON; los adjuntos van en `multipart/form-data`. Node
  22 ya trae `FormData` y `Blob` globales, así que son ~8 líneas sin
  dependencia nueva.
- `fetch-fichas.js` nuevo + `descargar-fichas.yml` nuevo, calcados de
  `fetch-historial.js` / `fetch-historial.yml`. El workflow necesita
  `concurrency: group: descargar-fichas-${{ inputs.chat_id }}` o el mismo
  usuario tocando `/fichas` dos veces dispara dos logins.
- `package.json`: script `fetch-fichas`.
- `telegram-webhook/index.ts`: comando `/fichas` + `dispararFichas()`
  (copia de `dispararFetchHistorial`, líneas 135-155) + la línea en la
  constante `AYUDA`. **No** hace falta tocar `manejarCallbackQuery`.
- `README.md` / `CHANGELOG.md`: el proyecto documenta cada comando.

Detalle heredado que conviene tener presente: `dispararFetchHistorial`
hace `return` silencioso si falta `GITHUB_DISPATCH_TOKEN`, y el usuario
se queda con el "🔎 Buscando..." para siempre. `/fichas` va a heredar lo
mismo. No es de este spec arreglarlo, pero si se toca esa función,
aprovechar.

## Testing

Mismo criterio que el resto del proyecto (sin suite automatizada,
`docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md#testing`):
verificación manual local con `.env` real, mismo patrón que
`pnpm run test-login`.

Ya existe `fichas-test.js` (`pnpm run test-fichas`): loguea, lista las
fichas y baja cada PDF imprimiendo status, `Content-Type`, tamaño y
tiempo, sin tocar Supabase ni Telegram. Es lo que produjo la tabla de
"Investigación (resuelta)" y sirve para revalidar el scraping cada vez
que INTRALU cambie el HTML.

Existe también `explorar-test.js` (`pnpm run test-explorar`), que recorre
el menú entero — el que encontró lo de los anuncios (abajo).

## Hallazgo lateral: anuncios y documentos del home

Explorando el resto del menú apareció algo que no estaba en el radar: la
**home de INTRALU** (`/`) publica dos listas de archivos que hoy el bot
ignora por completo.

- **Anuncios**: timeline con título, texto, fecha y adjuntos. En la
  cuenta de prueba: "HORARIO ENTREGA DE EXAMENES 2026-1" (27/07/2026,
  `.docx`) y "ENCUESTA VIRTUAL" (04/07/2026, `.jpg`).
- **Reglamentos y Resoluciones**: tres pestañas (Reglamentos,
  Resoluciones, Manuales); solo la primera tenía contenido
  ("REGLAMENTO MATRICULA", 07/02/2025, PDF de 2.7 MB).

Ambas listas usan el mismo mecanismo: `<a class="btn-file"
data-codanu="..." data-extension="...">`. El handler está en
`/build/assets/home-*.js` y se reduce a un `GET` a
**`/anuncio/download/{codanu}`** (o `/anuncio/view/{codanu}` para
previsualizar). Probado con los tres `codanu` reales: los tres bajan
200 con `Content-Disposition: attachment; filename="..."`, de donde sale
el nombre de archivo tal cual para pasárselo a `sendDocument`.

No hay página índice: `/anuncio`, `/anuncios` y `/anuncio/listar` dan
404. La lista vive **solo en el HTML del home**, así que hay que
scrapearla de ahí.

**Implementado como feature aparte**, ver
[`2026-08-11-avisos-anuncios.md`](../plans/2026-08-11-avisos-anuncios.md):
revisión por usuario cada hora, aviso con el adjunto incluido, y opt-out
con `/avisos`. El valor está en un modo distinto al de las fichas: un
anuncio nuevo es exactamente el tipo de cosa que el bot ya sabe hacer
solo (comparar contra lo último visto y avisar solo si hay algo nuevo),
mientras que las fichas son bajo demanda.

Quedó sin confirmar si la lista de anuncios es global (misma para todos)
o por facultad/alumno — con una sola cuenta no se puede saber. Por eso se
revisa por usuario, que es correcto en los dos casos aunque cueste un
login por usuario por hora.
