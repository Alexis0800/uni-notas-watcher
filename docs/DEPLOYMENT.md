# Desplegar tu propia instancia

Esta guía asume que ya tienes un fork o clon de este repo y quieres
correr tu propio bot (con tu propio token de Telegram y tu propio
proyecto de Supabase) desde cero. Todo lo que se usa acá es gratis en su
plan free.

## Requisitos

- Cuenta de [Telegram](https://telegram.org/) para crear el bot.
- Cuenta de [Supabase](https://supabase.com/) (gratis).
- Node.js 22+ instalado localmente.
- Cuenta de GitHub con el repo pusheado (puede ser un fork).
- Opcional: [Deno](https://deno.com/) instalado localmente si quieres
  correr `deno check`/`deno lint` antes de desplegar (recomendado, no
  obligatorio — GitHub Actions no lo corre automáticamente hoy).

## Paso 1 — Crear el bot de Telegram

1. Habla con [@BotFather](https://t.me/BotFather) en Telegram.
2. `/newbot`, elige nombre y username.
3. Guarda el **token** que te da (formato `123456:AAAA...`).
4. Genera un secreto random para el webhook (cualquier string largo
   sirve, ej. `openssl rand -base64 24` o el generador de contraseñas
   que prefieras). Este NO lo da Telegram, lo eliges tú.

## Paso 2 — Crear el proyecto de Supabase

1. [supabase.com](https://supabase.com/) → nuevo proyecto.
2. **SQL Editor** → pega y corre [`supabase/schema.sql`](../supabase/schema.sql).
3. **Project Settings → API**: copia el **Project URL** y el
   **service_role key** (no el `anon public`).

## Paso 3 — Variables de entorno locales

```bash
cp .env.example .env
```

Completa:

| Variable | De dónde sale |
|---|---|
| `SUPABASE_URL` | Project URL del Paso 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key del Paso 2 |
| `CREDENTIALS_ENCRYPTION_KEY` | Generar: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `TELEGRAM_TOKEN` | Token del Paso 1 |
| `TELEGRAM_WEBHOOK_SECRET` | Secreto del Paso 1 |
| `UNI_CODIGO` / `UNI_PASSWORD` | Opcional, solo para probar `login-test.js` con tu propio usuario |

`.env` nunca se commitea (está en `.gitignore`).

## Paso 4 — Desplegar las Edge Functions

Con el [CLI de Supabase](https://supabase.com/docs/guides/cli) (no hace
falta instalarlo globalmente, `pnpm dlx` alcanza):

```bash
pnpm dlx supabase login              # abre el navegador, autoriza el CLI
pnpm dlx supabase link --project-ref TU_PROJECT_REF   # el ref está en la URL del dashboard
pnpm dlx supabase secrets set \
  TELEGRAM_BOT_TOKEN=... \
  TELEGRAM_WEBHOOK_SECRET=... \
  CREDENTIALS_ENCRYPTION_KEY=...
pnpm dlx supabase functions deploy telegram-webhook --no-verify-jwt
pnpm dlx supabase functions deploy registro-webapp --no-verify-jwt
pnpm dlx supabase functions deploy simular-datos --no-verify-jwt
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase
automáticamente dentro de toda Edge Function — no hace falta
configurarlos a mano con `secrets set`.

`--no-verify-jwt` es necesario porque estas funciones las llama
Telegram (el webhook) o un navegador sin sesión de Supabase Auth (las
Mini Apps) — su propia autenticación es el `secret_token` del webhook o
la firma `initData`, no un JWT de Supabase (ver
[`SECURITY.md`](SECURITY.md)).

## Paso 5 — Publicar las Mini Apps en GitHub Pages

Este repo despliega `public/` a GitHub Pages vía GitHub Actions
([`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml)),
no por el método clásico "Deploy from a branch" — Supabase Edge
Functions no puede servir HTML (ver [`ARCHITECTURE.md`](ARCHITECTURE.md)),
así que las páginas del formulario y el simulador viven acá.

1. En tu repo → **Settings → Pages → Build and deployment → Source**:
   elige **GitHub Actions** (no "Deploy from a branch").
2. Push a `main` (o **Actions → Deploy Pages → Run workflow**
   manualmente la primera vez).
3. Tu sitio queda en `https://TU_USUARIO.github.io/TU_REPO/`.

Después de esto, **actualiza las URLs hardcodeadas** en
`supabase/functions/telegram-webhook/index.ts` (`REGISTRO_WEBAPP_URL`,
`SIMULADOR_URL`), en `check-all-users.js` (`PAGES_BASE`, usado por el
botón de registro del aviso de desactivación) y en `public/simulador.html`
(`API_URL`) y en `public/registro.html` (`API_URL`) para que apunten a
tu propio dominio de GitHub Pages y de Supabase — son URLs fijas en el
código porque las Mini Apps no tienen forma de conocer esos valores en
tiempo de ejecución (no hay variables de entorno en una página
estática). Vuelve a desplegar las funciones (Paso 4) después de
cambiarlas.

## Paso 6 — Conectar el webhook de Telegram

```bash
source .env
curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=https://TU_PROJECT_REF.supabase.co/functions/v1/telegram-webhook&secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Debería responder `{"ok":true,"result":true,...}`. Verifica con
`getWebhookInfo`:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo"
```

## Paso 7 — Menú nativo del bot (opcional pero recomendado)

```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "registrar", "description": "Registrar o actualizar tu usuario de INTRALU"},
      {"command": "notas", "description": "Ver todas tus notas registradas"},
      {"command": "ciclos", "description": "Consultar tus notas de un ciclo anterior"},
      {"command": "simular", "description": "Simular tu nota final con lo que falta"},
      {"command": "estado", "description": "Ver si estas activo y la ultima revision"},
      {"command": "baja", "description": "Borrar tu registro y tu contrasena"},
      {"command": "ayuda", "description": "Ver todos los comandos"}
    ]
  }'

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button": {"type": "commands"}}'
```

## Paso 8 — GitHub Secrets y activar el chequeo periódico

En tu repo → **Settings → Secrets and variables → Actions**, crea:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CREDENTIALS_ENCRYPTION_KEY`
- `TELEGRAM_TOKEN`
- `WORKFLOW_DISPATCH_TOKEN` — un [fine-grained Personal Access Token](https://github.com/settings/tokens?type=beta)
  con acceso *solo* a este repo y permiso "Actions: Read and write".
  Sin este secret el chequeo periódico igual funciona, pero solo dispara
  cada ~1h (el `schedule` nativo de GitHub Actions no es confiable para
  intervalos de 5 min — ver [`docs/SCALING.md`](SCALING.md)); con él,
  cada corrida se auto-encadena a la siguiente cada 5 min de verdad.

Pestaña **Actions** → workflow **Check grade** → **Run workflow** para
probarlo manualmente. Con 0 usuarios registrados debería terminar en
verde diciendo "Revisando 0 usuario(s) activo(s)... Listo." Con el
secret configurado, queda encadenándose solo cada 5 min
([`.github/workflows/check-grade.yml`](../.github/workflows/check-grade.yml)).

**Opcional — chequeo casi-inmediato al registrarse**: agrega el mismo
valor del token de arriba como secret de **Supabase** (no de GitHub):

```bash
pnpm dlx supabase secrets set GITHUB_DISPATCH_TOKEN=el-mismo-token-de-arriba
```

Con esto, `registro-webapp` (para registros por formulario) y
`telegram-webhook` (para `/registrar` directo) disparan
[`check-new-registration.yml`](../.github/workflows/check-new-registration.yml)
apenas alguien se registra — un workflow aparte de la cadena de 5 min,
con su propio `concurrency group`, que solo revisa a los recién
registrados (no se encola detrás de `check-grade.yml`, que casi siempre
está ocupado). Es opcional — sin este secret el registro funciona
igual, solo que la primera revisión llega en la corrida encadenada
siguiente en vez de casi al toque.

## Paso 9 — Probar

Escríbele a tu bot `/start` → toca **Registrarme** → completa el
formulario con tu propio usuario de INTRALU. Deberías recibir la
confirmación de registro casi al toque, y minutos después (o casi
inmediato si configuraste `GITHUB_DISPATCH_TOKEN`) un mensaje con tus
notas actuales. Desde ahí, avisos reales cada vez que aparezca algo
nuevo.

## Repo público vs privado

Este proyecto asume un repo **público**, porque GitHub Actions da
minutos ilimitados gratis solo en ese caso (necesario para correr cada 5
min sin costo). Si preferís repo privado, GitHub da 2000 minutos/mes
gratis — a 30 min de intervalo entran holgados (~1440 min/mes), a 5 min
no. Ver la nota de costo en
[`ARCHITECTURE.md`](ARCHITECTURE.md#por-qué-github-actions-para-el-chequeo-periódico-y-no-otro-cron).
