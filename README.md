# uni-notas-watcher

Bot de Telegram multiusuario que revisa [INTRALU](https://alumnos.uni.edu.pe)
(el intranet de alumnos de la Universidad Nacional de Ingeniería, Perú) y
avisa automáticamente cuando aparece una nota nueva — por evaluación
(Práctica 1, Examen Parcial, Examen Final, etc.), no solo la nota final del
curso. También permite ver todas las notas registradas agrupadas por curso
y simular con cuánto se aprueba cada curso antes de que salgan las notas
que faltan.

**Bot en producción:** [@OrceBotV2_bot](https://t.me/OrceBotV2_bot)

## Para usarlo (si eres estudiante UNI)

1. Abre el chat con [@OrceBotV2_bot](https://t.me/OrceBotV2_bot) en Telegram.
2. Toca `/start` y luego el botón **📝 Registrarme** — se abre un
   formulario dentro de Telegram, sin escribir tu contraseña como
   mensaje de texto en el chat.
3. Listo. Cada 5 minutos el bot revisa tus notas y te avisa por Telegram
   si hay algo nuevo. Usa `/notas` para ver todo lo registrado hasta
   ahora, o `/simular` para calcular con cuánto necesitas aprobar un
   curso.

## Comandos del bot

- `/registrar` — abre el formulario de registro (o `/registrar CODIGO CONTRASEÑA` por texto)
- `/notas` — todas tus notas registradas, agrupadas por curso, con 🟢/🔴
- `/simular` — elige un curso y simula tu nota final con lo que falta
- `/estado` — si estás activo y cuándo se revisó por última vez
- `/baja` — borra tu registro y tu contraseña
- `/ayuda` — lista de comandos

## Documentación

| Documento | Para qué sirve |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Cómo está armado el sistema, las 6 piezas, por qué cada decisión técnica |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Modelo de amenazas, cifrado, verificación de identidad, riesgos residuales |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Cómo desplegar tu propia instancia desde cero (Supabase, GitHub Pages, GitHub Actions) |
| [`docs/GRADING-RULES.md`](docs/GRADING-RULES.md) | Cómo funciona INTRALU por dentro: fórmulas, NSP, notas anuladas, Examen Sustitutorio |
| [`docs/SCALING.md`](docs/SCALING.md) | Cuántos usuarios soporta hoy, dónde está el cuello de botella real, qué haría falta para más |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Cómo correr el proyecto localmente y contribuir cambios |

## Stack

- **Scraper** (Node.js, `lib/session.js`): login a INTRALU y extracción de
  notas por evaluación — sin API oficial, es HTML/JSON interno del sitio.
- **Bot de Telegram + Mini Apps** (Deno, [Supabase Edge Functions](https://supabase.com/docs/guides/functions)):
  atiende comandos y los formularios de registro/simulador.
- **Base de datos** ([Supabase Postgres](https://supabase.com/docs/guides/database)):
  credenciales cifradas, notas y fórmulas por usuario.
- **Páginas de las Mini Apps** ([GitHub Pages](https://pages.github.com/),
  carpeta `public/`): Supabase Edge Functions no puede servir HTML en el
  plan gratis, así que los formularios viven acá y le pegan a la API por
  `fetch`.
- **Chequeo periódico** ([GitHub Actions](https://docs.github.com/actions),
  `check-all-users.js`): corre cada 5 minutos, revisa a todos los
  usuarios activos y notifica.

Diagrama completo en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Licencia

[MIT](LICENSE) — usa, copia y modifica libremente, sin garantía.
