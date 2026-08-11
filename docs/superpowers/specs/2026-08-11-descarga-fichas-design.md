# Descarga de fichas/documentos desde el bot

**Fecha:** 2026-08-11
**Estado:** Borrador — falta investigar la estructura real de
`/informacion-academica/fichas` (requiere sesión logueada, ver
"Investigación pendiente" más abajo) antes de poder pasar esto a un plan
de implementación tarea por tarea, como se hizo con
[`2026-07-17-avisos-caida-intralu-design.md`](2026-07-17-avisos-caida-intralu-design.md).

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

## Investigación pendiente (bloqueante)

La página requiere sesión iniciada, así que no la puedo inspeccionar yo
directamente sin credenciales — y como ya se conversó, pasar la
contraseña real de INTRALU por este chat rompería la misma regla de
seguridad que el propio proyecto sigue en `/registrar` (nunca la
contraseña como texto plano en la conversación, ver `docs/SECURITY.md`).

El plan es que esto se investigue en tu máquina local, con tu `.env` real
(que nunca sale de tu disco), el mismo patrón que ya usa
`pnpm run test-login`. Lo que hace falta averiguar y volcar acá antes de
poder escribir el plan de implementación:

1. **Qué hay en la página**: ¿cuántos documentos, de qué tipo (ficha de
   matrícula, constancia, historial académico, otros)? ¿La lista es fija
   o cambia según el ciclo/situación del alumno?
2. **Cómo se obtiene cada archivo**: ¿es un link directo a un `.pdf` (algo
   como `<a href="/algo/generar-pdf?...">`), o hace falta un POST/JS que
   dispare una descarga? Si hay un botón, inspeccionar con DevTools →
   pestaña **Network** al hacer click y anotar URL, método y cualquier
   token que mande (CSRF, `codper`, etc. — mismo tipo de dato que ya
   se sacó para `lib/session.js` y `fetchEvaluaciones`).
3. **Formato y tamaño aproximado** de los archivos (asumo PDF, pero
   confirmar) — Telegram permite subir hasta 50 MB por documento vía
   `sendDocument`, así que en principio no debería ser un problema, pero
   vale confirmar que no son archivos gigantes.
4. **Si hace falta re-loguearse** para cada archivo o si una sola sesión
   (cookie) alcanza para traer varios documentos seguidos — afecta si
   conviene traer todos de una vez o uno por uno bajo demanda.

## Diseño propuesto (a confirmar con lo anterior)

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
4. Si hay un solo documento (o pocos y chicos): los descarga todos con la
   misma sesión ya logueada y los manda directo por Telegram
   (`sendDocument`, subiendo los bytes — no un link, porque Telegram no
   tiene la cookie de sesión de INTRALU para bajarlo solo).
5. Si hay varios: en vez de mandar todo de una, ofrece botones (mismo
   patrón `callback_query` que ya usa `/ciclos`) para elegir cuál
   descargar, y cada botón dispara la descarga de ese archivo puntual.

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

## Testing

Mismo criterio que el resto del proyecto (sin suite automatizada,
`docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md#testing`):
verificación manual local con `.env` real, mismo patrón que
`pnpm run test-login`. Cuando se investigue la estructura real de la
página (sección anterior), el paso natural es un script de diagnóstico
nuevo (`fichas-test.js`, análogo a `login-test.js`) que solo loguea y
imprime lo que encuentra en `/informacion-academica/fichas`, sin tocar
Supabase ni Telegram — para confirmar el scraping antes de conectarlo al
resto del bot.
