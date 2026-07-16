# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [1.2.0] - 2026-07-16

### Added

- **`/ciclos`**: consulta las notas de un ciclo pasado bajo demanda, un
  período a la vez (nunca todos de golpe) — la primera vez que se pide
  un período dispara un login real (`fetch-historial.yml`, workflow
  aparte); una vez consultado, queda en caché permanente (`historial`)
  y las siguientes veces responde al toque.
- Primer uso de botones sin Mini App en el bot (`callback_query`) — los
  botones de `/ciclos` son una elección simple, no necesitan un
  formulario.

### Changed

- Etiquetas de los botones de `/ciclos` acortadas (año de 2 dígitos +
  dígito de ciclo, ej. `26-1`) y agrupadas en filas de 4 en vez de una
  por fila, para que quepan más sin tanto scroll.
- Al tocar un botón de `/ciclos`, el mensaje se edita en el momento
  (quita los botones y deja "seleccionado" o "buscando..., puede
  tardar unos minutos") en vez de solo cerrar el spinner sin dejar
  ningún rastro — evitaba que alguien pensara que no funcionó y
  volviera a tocar el mismo botón.
- `/ciclos` agregado al menú nativo de comandos de Telegram
  (`setMyCommands`, documentado en [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md))
  — antes solo aparecía en `/ayuda`.

## [1.1.0] - 2026-07-16

### Added

- **Chips NSP/0A en el simulador** (`public/simulador.html`): cada
  evaluación pendiente se puede marcar como "No Se Presentó" o "Anulada"
  con un toque, en vez de tener que saber que ambas cuentan como 0.
- **Fórmulas y PP visibles en el simulador**: se muestra el texto crudo
  de las fórmulas de prácticas/nota final de INTRALU, y el resultado
  desglosa el promedio de prácticas (PP) por separado, con un aviso si
  da menos de 6.
- **`check-new-registration.yml`**: workflow aparte (con su propio
  `concurrency group`) que revisa solo a los recién registrados apenas
  se registran — no comparte carril con la cadena de 5 min de
  `check-grade.yml`, así que corre casi al instante en vez de encolarse
  detrás de ella.
- **Promedio del curso en `/notas` y en los avisos de notas nuevas**:
  INTRALU ya calcula `promedios.promedio_final` por curso — ahora se
  muestra tal cual (sin recalcularlo) para no tener que sacar la cuenta
  a mano. Documentado en [`docs/GRADING-RULES.md`](docs/GRADING-RULES.md).
- **Mostrar/ocultar contraseña** en el formulario de registro, con
  validación en vivo por campo y bloqueo de los inputs mientras se
  envía.
- Botón de registro agregado a mensajes que antes solo lo mencionaban en
  texto (aviso de desactivación por login fallido, `/estado` cuando la
  cuenta está inactiva).

### Changed

- El chequeo casi-inmediato al registrarse ahora dispara
  `check-new-registration.yml` en vez de `check-grade.yml` — la primera
  versión compartía el `concurrency group` de la cadena de 5 min, que
  casi siempre está ocupada, así que en la práctica no era tan
  inmediato (ver [`docs/SCALING.md`](docs/SCALING.md)).
- `/notas` pasa a leer de `cursos` en vez de `last_grades` (mismo
  filtro de evaluaciones ya calificadas, ahora agrupado junto con el
  promedio de cada curso).
- Mensaje de confirmación de registro reescrito (más corto, sin la
  promesa vaga de "en los próximos minutos") en **ambos** caminos de
  registro: el comando de texto (`telegram-webhook`) y el formulario de
  Mini App (`registro-webapp`) — el segundo había quedado sin el
  tratamiento en una primera pasada, encontrado en revisión.
- La primera revisión tras registrarse manda un snapshot completo de
  notas en vez de guardar el estado en silencio.
- `AYUDA` y `/estado` reciben el mismo tratamiento visual (negritas,
  🟢/🔴) que ya tenía el resto de mensajes del bot.
- Ícono de mostrar/ocultar contraseña pasa de emoji (👁/🙈, que se ven
  distinto según el sistema operativo) a un ícono SVG propio.

### Fixed

- El simulador podía dejar que una nota anulada (0A) fuera la que
  `MIN(...)` descarta al elegir la nota más baja de un curso — una
  anulada ahora nunca es candidata a ser la descartada, aunque
  numéricamente sea la más baja.

### Security

- Documentados `WORKFLOW_DISPATCH_TOKEN` (GitHub) y
  `GITHUB_DISPATCH_TOKEN` (Supabase) en
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — ambos acotados a permiso
  de solo Actions de este repo, sin acceso a código ni credenciales.

## [1.0.0] - 2026-07-16

Primera versión publicada. Bot de Telegram multiusuario que revisa
[INTRALU](https://alumnos.uni.edu.pe) y avisa por Telegram cuando aparece
una nota nueva.

### Added

- **Bot de Telegram** (`supabase/functions/telegram-webhook`): comandos
  `/registrar`, `/notas`, `/simular`, `/estado`, `/baja`, `/ayuda`.
- **Registro seguro vía Mini App** (`registro-webapp`): formulario dentro
  de Telegram — la contraseña de INTRALU nunca se escribe como texto en
  el chat. Verificación del `initData` con HMAC-SHA256 (algoritmo oficial
  de Telegram) para confiar en el `chat_id` sin sesión de servidor.
- **Chequeo periódico de notas** (`check-all-users.js`, GitHub Actions):
  login a INTRALU y notificación por Telegram evaluación por evaluación
  (no solo la nota final del curso), con 🟢/🔴 según aprobado/desaprobado
  y manejo de notas anuladas (`0A`) y no presentadas (`NSP`).
- **Simulador de nota final** (Mini App `simular-datos`): elige un curso y
  calcula con cuánto se aprueba usando la fórmula real de INTRALU como
  fuente de verdad (no una lista fija de evaluaciones), incluyendo el caso
  del Examen Sustitutorio.
- **Cifrado de credenciales**: contraseñas cifradas con AES-256-GCM
  (`lib/crypto.js` / `supabase/functions/*/crypto.ts`), llave maestra
  fuera de la base de datos, RLS sin policies en la tabla `usuarios`.
- **Cola de revisión por antigüedad**: cuando los usuarios activos superan
  lo que cabe en una sola pasada de 5 min, `check-all-users.js` prioriza a
  los nunca revisados y luego a los más atrasados (`seeded`/`updated_at`),
  en vez de dejar que las pasadas se atrasen sin límite.
- **Auto-encadenado de corridas** (`check-grade.yml`): cada corrida
  dispara la siguiente ~5 min después vía la API de GitHub
  (`workflow_dispatch`), en vez de depender solo del `schedule` nativo de
  GitHub Actions — medido y confirmado como poco confiable para
  intervalos de 5 min (ver [`docs/SCALING.md`](docs/SCALING.md)).
- **`benchmark-concurrency.js`**: script para medir el tiempo real de
  login + notas contra INTRALU a distinta concurrencia.
- **Documentación completa**: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  [`docs/SECURITY.md`](docs/SECURITY.md),
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md),
  [`docs/GRADING-RULES.md`](docs/GRADING-RULES.md),
  [`docs/SCALING.md`](docs/SCALING.md), [`CONTRIBUTING.md`](CONTRIBUTING.md).

### Changed

- Migración de npm a pnpm — bloquea por defecto los scripts
  `postinstall` de las dependencias (un vector común de ataques a la
  cadena de suministro) y verifica el lockfile en cada install.
- `CONCURRENCY` del chequeo periódico subido de 5 a 15, y
  `SECONDS_PER_USER`/`RUN_WINDOW_SECONDS` recalibrados con mediciones
  reales desde GitHub Actions (~28-30s/usuario) en vez de una medición
  local (~14s/usuario) que no reflejaba la red real de producción.

### Security

- Header secreto (`X-Telegram-Bot-Api-Secret-Token`) validado en el
  webhook antes de procesar cualquier mensaje.
- Ninguna credencial real vive en el código ni en el historial de git —
  todo son Secrets de GitHub/Supabase.
- Detalle completo del modelo de amenazas, qué se probó y los incidentes
  reales durante el desarrollo (y cómo se corrigieron) en
  [`docs/SECURITY.md`](docs/SECURITY.md).
