# Arquitectura

## Resumen

Este no es un script de una sola persona: es un servicio multiusuario
donde cualquier estudiante UNI registra sus propias credenciales de
INTRALU y recibe avisos automáticos por Telegram. Eso obliga a separar
responsabilidades entre seis piezas:

1. **Mini Apps** (`public/registro.html`, `public/simulador.html`) —
   formularios reales dentro de Telegram, servidos por GitHub Pages.
2. **Bot de Telegram** (`supabase/functions/telegram-webhook`) —
   atiende comandos vía webhook.
3. **APIs de las Mini Apps** (`supabase/functions/registro-webapp`,
   `supabase/functions/simular-datos`) — reciben los formularios.
4. **Base de datos** (Supabase Postgres, tabla `usuarios`).
5. **Scraper** (`lib/session.js`, Node.js) — login y extracción de notas
   de INTRALU.
6. **Chequeo periódico** (`check-all-users.js`, corrido por GitHub
   Actions cada 5 min).

```
┌─────────────────────┐     ┌──────────────────────┐
│ public/registro.html│     │ public/simulador.html│      GitHub Pages
└──────────┬───────────┘     └───────────┬───────────┘
           │ fetch (initData firmado)     │ fetch (initData firmado)
           ▼                              ▼
┌─────────────────────┐     ┌──────────────────────┐
│  registro-webapp     │     │   simular-datos      │      Supabase
└──────────┬───────────┘     └───────────┬───────────┘      Edge Functions
           │                              │ (solo lectura)
           ▼                              │
┌──────────────────────────────────────────────────────┐
│                  Postgres: tabla usuarios              │    Supabase
│   password_encrypted · last_grades · cursos · seeded   │
└───────────────────────┬──────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │ webhook (mensajes)               │ cada 5 min
        ▼                                  ▼
┌─────────────────┐              ┌──────────────────────┐
│ telegram-webhook │              │  check-all-users.js   │   GitHub Actions
└─────────────────┘              │  (usa lib/session.js) │
        ▲                        └───────────┬───────────┘
        │ Bot API                             │ login + scraping
        │                                     ▼
┌─────────────────┐              ┌──────────────────────┐
│     Telegram      │              │  alumnos.uni.edu.pe   │   INTRALU
└─────────────────┘              │      (INTRALU)         │
                                   └──────────────────────┘
```

## Por qué esta arquitectura

### ¿Por qué Supabase Edge Functions y no un servidor propio?

El bot necesita **algo siempre encendido** para recibir mensajes de
Telegram en tiempo real (webhook). Un cron de GitHub Actions no sirve
para eso — solo corre en horarios programados. Supabase Edge Functions
(sobre [Deno](https://deno.com/)) da ese "siempre encendido" gratis, sin
mantener un servidor.

### ¿Por qué el scraper (login a INTRALU) vive en Node, no en Deno?

Porque ya estaba escrito y probado ahí antes de que el proyecto se
volviera multiusuario, usa `axios` + `axios-cookiejar-support` +
`cheerio` para manejar cookies de sesión y parsear HTML — nada de esto
es exclusivo de Node, pero reescribirlo en Deno no daba ningún beneficio
real. El resultado: **una sola implementación** del login/scraping
(`lib/session.js`), usada por `check-all-users.js` (GitHub Actions) y
por `login-test.js` (diagnóstico local). Las Edge Functions de Supabase
nunca hacen login a INTRALU — solo administran el registro y sirven
datos ya guardados.

### ¿Por qué las Mini Apps (HTML) están en `public/` vía GitHub Pages y no en Supabase?

Supabase Edge Functions **no puede servir HTML en el plan gratis**: una
respuesta `text/html` se reescribe a `text/plain` y se le aplica un
`Content-Security-Policy: default-src 'none'; sandbox` que bloquea todo
el JavaScript — sin forma de evitarlo desde el código de la función (es
una restricción de plataforma, documentada en varios issues de
Supabase). La alternativa paga (Pro + dominio propio) cuesta $10/mes
extra. GitHub Pages es gratis, ya viene con el repo, y sirve HTML sin
restricciones. Las Mini Apps llaman a las Edge Functions por `fetch`
(con CORS habilitado) para todo lo que necesita tocar la base de datos.

### ¿Por qué GitHub Actions para el chequeo periódico, y no otro cron?

Es gratis e ilimitado en minutos para repos **públicos** — necesario
para poder correr cada 5 minutos sin pagar. El costo de esto: el repo
tiene que ser público, así que **nada sensible puede vivir en el
código ni en el historial de git** (ver [`SECURITY.md`](SECURITY.md)).

### ¿Por qué el estado de notas vive en Postgres y no se recalcula todo cada vez?

`check-all-users.js` compara la nota actual contra `last_grades` (lo
último que vio) para decidir si hay algo nuevo que notificar. Sin ese
estado guardado, cada corrida pensaría que *todas* las notas existentes
son "nuevas". La columna `seeded` resuelve el caso especial del primer
chequeo después de registrarse: guarda el estado base en silencio antes
de empezar a notificar cambios de verdad.

## Estructura de archivos

```
lib/
  session.js          Login a INTRALU + scraping de cursos/notas/fórmulas (Node)
  crypto.js            Cifrado AES-256-GCM de credenciales (Node)
check-all-users.js     Chequeo periódico multiusuario (Node, corrido por Actions)
login-test.js           Diagnóstico local de login (Node, opcional)
public/
  registro.html          Mini App: formulario de registro
  simulador.html          Mini App: simulador de nota final
supabase/
  schema.sql              Esquema de la tabla usuarios
  functions/
    telegram-webhook/       Bot: comandos, menú, botones de Mini App (Deno)
    registro-webapp/        API del formulario de registro (Deno)
    simular-datos/           API del simulador (Deno, solo lectura)
.github/workflows/
  check-grade.yml            Corre check-all-users.js cada 5 min
  deploy-pages.yml            Publica public/ a GitHub Pages
```

## Por qué hay código duplicado entre Node y Deno

`lib/crypto.js` (Node) y `supabase/functions/*/crypto.ts` (Deno) son el
mismo esquema de cifrado (AES-256-GCM vía Web Crypto), copiado en vez de
importado. Cada Edge Function de Supabase se empaqueta y despliega como
una unidad aislada — no hay un mecanismo simple y confiable para
compartir un módulo entre `lib/` (Node) y las Edge Functions (Deno,
runtime distinto) sin arriesgar que un cambio en un lado rompa el otro
silenciosamente en el próximo deploy. La duplicación es intencional y
pequeña (~50-130 líneas por copia); cada copia se probó por separado —
ver [`CONTRIBUTING.md`](../CONTRIBUTING.md#por-qué-hay-código-duplicado)
para cómo verificar que las copias siguen dando el mismo resultado si
las tocas.

El evaluador de fórmulas de INTRALU (tokenizador + parser, soporta
`MIN(...)` y el peso `2.EF`) es distinto: solo vive en un lugar —
JavaScript de navegador dentro de `public/simulador.html` — porque el
cálculo de "qué nota necesito" es puramente informativo para el usuario
y no necesita pasar por el servidor. `simular-datos` (Deno) solo separa
qué variables están fijas y cuáles faltan; nunca evalúa la fórmula.
(Existió una copia en `telegram-webhook` en una versión anterior del
`/simular` por texto; se eliminó al reemplazarla por la Mini App.)

## Esquema de la base de datos

Tabla `usuarios` (ver [`supabase/schema.sql`](../supabase/schema.sql)):

| Columna | Tipo | Para qué sirve |
|---|---|---|
| `chat_id` | `bigint` (único) | Identifica al usuario de Telegram |
| `codigo_uni` | `text` | Código de estudiante UNI |
| `password_encrypted` | `text` | Contraseña de INTRALU cifrada (AES-256-GCM) |
| `last_grades` | `jsonb` | Evaluaciones con fecha de registro — para notificar y `/notas` |
| `cursos` | `jsonb` | Fórmulas, promedios y lista completa de evaluaciones (con y sin fecha) por curso — para `/simular` |
| `seeded` | `boolean` | `false` hasta el primer chequeo tras registrarse (evita notificar todo como "nuevo") |
| `active` | `boolean` | Se pone en `false` tras varios logins fallidos seguidos |
| `consecutive_failures` | `integer` | Contador de logins fallidos consecutivos |

RLS (Row Level Security) está activado **sin policies** — ver
[`SECURITY.md`](SECURITY.md#control-de-acceso-a-la-base-de-datos).
