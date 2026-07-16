# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

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
