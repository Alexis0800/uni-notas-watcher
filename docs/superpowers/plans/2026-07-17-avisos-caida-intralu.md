# Avisos de caída de INTRALU y transparencia de datos guardados — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando INTRALU no responde (`ECONNREFUSED`/timeout), el bot deja de quedarse en silencio: avisa al admin (una vez por caída/recuperación), avisa una vez al usuario recién registrado, se recupera más rápido (re-chequeo cada 60s en vez de 5 min mientras está caído), y dos pantallas (`/notas`, ciclo pasado cacheado) dejan claro que los datos son guardados, no en vivo.

**Architecture:** Nueva categoría de error (`isNetworkError`) separada de `CredentialError` en `lib/session.js`; nuevo módulo `lib/service-status.js` con updates atómicos sobre una tabla `service_status` de una fila por servicio, para deduplicar avisos entre hasta 15 chequeos en paralelo; `check-all-users.js` consume ambos y expone el estado a GitHub Actions vía `$GITHUB_OUTPUT` para que `check-grade.yml` ajuste su propio ritmo de re-encadenado.

**Tech Stack:** Node.js (CommonJS) para `check-all-users.js`/`lib/*`, Deno/TypeScript para la Edge Function `telegram-webhook`, GitHub Actions (YAML) para el cron, Postgres/Supabase para el estado.

**Spec:** `docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md`

---

## File Structure

- **Modify** `lib/session.js` — agrega `isNetworkError()` y `timeout` al cliente axios.
- **Create** `lib/service-status.js` — `markIntraluDown()` / `markIntraluUp()`, updates atómicos + aviso al admin deduplicado.
- **Modify** `check-all-users.js` — usa ambos módulos en `checkUser()` y expone `intralu_down` en `main()`.
- **Modify** `supabase/schema.sql` — tabla `service_status` + columna `usuarios.network_issue_notified` (migración manual del usuario).
- **Modify** `.env`, `.env.example` — `ADMIN_CHAT_ID`.
- **Modify** `.github/workflows/check-grade.yml` — pasa `ADMIN_CHAT_ID`, re-encadena en 60s si está caído.
- **Modify** `.github/workflows/check-new-registration.yml` — pasa `ADMIN_CHAT_ID` (sin cambio de ritmo).
- **Modify** `supabase/functions/telegram-webhook/index.ts` — "Última actualización" en `/notas`, aviso de "no en vivo" en ciclo pasado cacheado.

No hay framework de tests en el proyecto (confirmado en `package.json` — solo scripts manuales como `test-login`). Cada tarea de código nuevo incluye una verificación manual con `node -e`, siguiendo el mismo patrón que ya usa `login-test.js`.

---

### Task 1: `isNetworkError()` + timeout en el cliente axios

**Files:**
- Modify: `lib/session.js`

- [ ] **Step 1: Agregar `isNetworkError` junto a `CredentialError`**

En `lib/session.js`, después de la clase `CredentialError` (línea 20), agregar:

```js
// Distingue una falla de red/transporte (INTRALU inalcanzable, timeout, DNS)
// de cualquier otro error — ni credenciales malas (CredentialError) ni un
// cambio de HTML inesperado. check-all-users.js la usa para no tratar una
// caída del sitio como si fuera culpa del usuario.
function isNetworkError(err) {
  return (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(err.code) ||
    (err.isAxiosError === true && !err.response)
  );
}
```

- [ ] **Step 2: Agregar `timeout` al cliente axios**

En `newClient()` (línea 22-25), agregar `timeout: 20000` para que una conexión
que se queda colgada (a diferencia de un `ECONNREFUSED` que falla al
instante) nunca tarde más de 20s en fallar:

```js
function newClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({ jar, withCredentials: true, timeout: 20000, headers: { 'User-Agent': UA } }));
}
```

- [ ] **Step 3: Exportar `isNetworkError`**

En el `module.exports` al final del archivo (línea 151-160), agregar `isNetworkError`:

```js
module.exports = {
  login,
  fetchCursosMatriculados,
  fetchEvaluaciones,
  formatearNota,
  nombreVariable,
  UA,
  BASE_URL,
  CredentialError,
  isNetworkError,
};
```

- [ ] **Step 4: Verificar manualmente**

Run: `node -e "const { isNetworkError } = require('./lib/session'); console.log(isNetworkError({code:'ECONNREFUSED'}), isNetworkError({isAxiosError:true}), isNetworkError({isAxiosError:true,response:{}}), isNetworkError(new Error('boom')))"`

Expected: `true true false false`

- [ ] **Step 5: Commit**

```bash
git add lib/session.js
git commit -m "Detecta errores de red por separado de credenciales malas, agrega timeout al cliente axios"
```

---

### Task 2: Módulo `lib/service-status.js`

**Files:**
- Create: `lib/service-status.js`

- [ ] **Step 1: Escribir el módulo**

```js
const { sendTelegram } = require('./notificaciones');

// Marca INTRALU como caído la primera vez que se detecta (el WHERE
// is_down=false hace que, entre hasta 15 checks en paralelo, solo el que
// "gana la carrera" reciba una fila de vuelta y mande el aviso — el resto
// ve 0 filas afectadas y no hace nada). Devuelve true si esta llamada fue
// la que cambió el estado.
async function markIntraluDown(supabase, telegramToken, adminChatId) {
  const { data, error } = await supabase
    .from('service_status')
    .update({ is_down: true, since: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', false)
    .select();

  if (error) {
    console.error('markIntraluDown:', error.message);
    return false;
  }
  if (!data || data.length === 0) return false;

  console.error('🔴 INTRALU no responde — marcado como caído.');
  if (adminChatId) {
    await sendTelegram(
      telegramToken,
      adminChatId,
      '🔴 INTRALU parece estar caído (no responde). Voy a avisar cuando se recupere.',
    ).catch(() => {});
  }
  return true;
}

// Marca INTRALU como recuperado la primera vez que un login tiene éxito
// después de una caída. Mismo patrón de update atómico que markIntraluDown.
async function markIntraluUp(supabase, telegramToken, adminChatId) {
  const { data, error } = await supabase
    .from('service_status')
    .update({ is_down: false, updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', true)
    .select();

  if (error) {
    console.error('markIntraluUp:', error.message);
    return;
  }
  if (!data || data.length === 0) return;

  const since = data[0].since ? new Date(data[0].since) : null;
  const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
  const msg = `🟢 INTRALU volvió a responder${mins != null ? ` (estuvo caído ~${mins} min)` : ''}.`;
  console.log(msg);
  if (adminChatId) await sendTelegram(telegramToken, adminChatId, msg).catch(() => {});
}

// Lee el estado actual sin modificarlo — lo usa main() en check-all-users.js
// al final de la corrida para decidir el ritmo de re-encadenado en GitHub
// Actions (60s si está caído, 300s si no).
async function isIntraluDown(supabase) {
  const { data, error } = await supabase.from('service_status').select('is_down').eq('service', 'intralu').maybeSingle();
  if (error) {
    console.error('isIntraluDown:', error.message);
    return false;
  }
  return data?.is_down ?? false;
}

module.exports = { markIntraluDown, markIntraluUp, isIntraluDown };
```

- [ ] **Step 2: Verificar que el módulo carga sin errores**

Run: `node -e "const m = require('./lib/service-status'); console.log(Object.keys(m))"`

Expected: `[ 'markIntraluDown', 'markIntraluUp', 'isIntraluDown' ]`

- [ ] **Step 3: Commit**

```bash
git add lib/service-status.js
git commit -m "Agrega helper para marcar y avisar caídas/recuperaciones de INTRALU"
```

---

### Task 3: Esquema de Supabase — `service_status` + `network_issue_notified`

**Files:**
- Modify: `supabase/schema.sql`

- [ ] **Step 1: Agregar la columna nueva al `create table usuarios` (para instalaciones nuevas)**

En `supabase/schema.sql`, dentro del bloque `create table if not exists usuarios (...)` (línea 6-31), agregar la columna después de `consecutive_failures`:

Reemplazar:

```sql
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
```

Por:

```sql
  consecutive_failures integer not null default 0,
  -- true si ya se le avisó una vez que INTRALU no respondía durante su
  -- primer chequeo (registro nuevo) — evita repetir ese aviso en cada
  -- reintento de 5 min mientras la caída dure. Se resetea a false en
  -- cuanto un chequeo tiene éxito.
  network_issue_notified boolean not null default false,
  created_at timestamptz not null default now(),
```

- [ ] **Step 2: Agregar la tabla `service_status` (para instalaciones nuevas)**

Después de la línea `alter table usuarios enable row level security;` (línea 37) y antes del bloque de migración existente, insertar:

```sql

-- Una fila por servicio externo trackeado (hoy solo INTRALU). is_down +
-- since permiten avisar al admin una sola vez por caída/recuperación en vez
-- de una vez por usuario o por corrida del cron — ver lib/service-status.js.
create table if not exists service_status (
  service text primary key,
  is_down boolean not null default false,
  since timestamptz,
  updated_at timestamptz not null default now()
);
insert into service_status (service) values ('intralu') on conflict do nothing;

alter table service_status enable row level security;
```

- [ ] **Step 3: Agregar la migración para bases ya desplegadas**

Al final del archivo, dentro del bloque de comentario de migración existente (después de la línea `-- alter table usuarios add column if not exists historial jsonb not null default '{}'::jsonb;`), agregar:

```sql
-- alter table usuarios add column if not exists network_issue_notified boolean not null default false;
--
-- create table if not exists service_status (
--   service text primary key,
--   is_down boolean not null default false,
--   since timestamptz,
--   updated_at timestamptz not null default now()
-- );
-- insert into service_status (service) values ('intralu') on conflict do nothing;
-- alter table service_status enable row level security;
```

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "Agrega tabla service_status y columna network_issue_notified al esquema"
```

- [ ] **Step 5: Avisar al usuario que corra la migración manualmente**

No ejecutar esto contra la base de producción. Decirle al usuario que pegue
el bloque completo del Step 2 y la línea `alter table usuarios add column...`
del Step 3 en el SQL Editor de su proyecto de Supabase, y confirmar antes de
seguir con las tareas que dependen de estas tablas/columnas (Task 4 en
adelante).

---

### Task 4: `check-all-users.js` — usar `isNetworkError` y `service-status`

**Files:**
- Modify: `check-all-users.js`

- [ ] **Step 1: Importar los módulos nuevos**

En la línea 3, agregar `isNetworkError` a la desestructuración de `./lib/session`, e importar `lib/service-status`:

Reemplazar:

```js
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota, CredentialError } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso } = require('./lib/notificaciones');
```

Por:

```js
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota, CredentialError, isNetworkError } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso } = require('./lib/notificaciones');
const { markIntraluDown, markIntraluUp, isIntraluDown } = require('./lib/service-status');
const fs = require('fs');
```

- [ ] **Step 2: Resetear el flag y avisar recuperación en el camino de éxito**

En `checkUser()`, el `.update(...)` del camino exitoso (líneas 120-130), agregar
`network_issue_notified: false` y llamar a `markIntraluUp` después:

Reemplazar:

```js
    await supabase
      .from('usuarios')
      .update({
        last_grades: currentMap,
        cursos: cursosMeta,
        periodos_disponibles: periodos,
        seeded: true,
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'snapshot inicial enviado'}`);
```

Por:

```js
    await supabase
      .from('usuarios')
      .update({
        last_grades: currentMap,
        cursos: cursosMeta,
        periodos_disponibles: periodos,
        seeded: true,
        consecutive_failures: 0,
        network_issue_notified: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    await markIntraluUp(supabase, telegramToken, process.env.ADMIN_CHAT_ID);

    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'snapshot inicial enviado'}`);
```

- [ ] **Step 3: Agregar la rama de error de red en el `catch`**

Reemplazar el inicio del `catch` (líneas 133-140):

```js
  } catch (err) {
    if (!(err instanceof CredentialError)) {
      // Timeout, sitio caído, HTML cambiado, etc. — no es un fallo de
      // credenciales, así que no cuenta hacia la desactivación. El cron
      // siguiente lo reintenta solo (ver comentario sobre la cola en main()).
      console.error(`⏳ ${chat_id} (${codigo_uni}): ${err.message}`);
      return;
    }
```

Por:

```js
  } catch (err) {
    if (isNetworkError(err)) {
      // INTRALU inalcanzable (ECONNREFUSED, timeout, DNS) — no es culpa del
      // usuario ni cuenta hacia la desactivación. El cron siguiente lo
      // reintenta solo (no se toca updated_at, ver cola en main()). A
      // diferencia de un error desconocido, esto sí se avisa: al admin
      // siempre (deduplicado), y al usuario una sola vez si es su primer
      // chequeo tras registrarse.
      console.error(`🔴 ${chat_id} (${codigo_uni}): ${err.message}`);
      await markIntraluDown(supabase, telegramToken, process.env.ADMIN_CHAT_ID);

      if (!seeded && !usuario.network_issue_notified) {
        await sendTelegram(
          telegramToken,
          chat_id,
          '⏳ INTRALU no está respondiendo en este momento (a veces tarda horas en normalizarse). Te aviso apenas pueda revisar tus notas — no hace falta que hagas nada.',
        ).catch(() => {});
        await supabase.from('usuarios').update({ network_issue_notified: true }).eq('id', id);
      }
      return;
    }

    if (!(err instanceof CredentialError)) {
      // Timeout de otro tipo, HTML cambiado, etc. — no es un fallo de
      // credenciales ni de red, así que no cuenta hacia la desactivación. El
      // cron siguiente lo reintenta solo (ver comentario sobre la cola en main()).
      console.error(`⏳ ${chat_id} (${codigo_uni}): ${err.message}`);
      return;
    }
```

(El resto del `catch`, la rama de `CredentialError` en líneas 142-156, queda sin cambios.)

- [ ] **Step 4: Exponer el estado de INTRALU al final de `main()` para GitHub Actions**

Al final de `main()` (después del bloque `if (usuarios.length > 0) {...} else {...}`, antes del cierre de la función, líneas 208-212), agregar:

Reemplazar:

```js
  if (usuarios.length > 0) {
    console.log(`Listo en ${elapsedSeconds.toFixed(1)}s (${(elapsedSeconds / usuarios.length).toFixed(1)}s/usuario).`);
  } else {
    console.log('Listo (sin usuarios que revisar).');
  }
}
```

Por:

```js
  if (usuarios.length > 0) {
    console.log(`Listo en ${elapsedSeconds.toFixed(1)}s (${(elapsedSeconds / usuarios.length).toFixed(1)}s/usuario).`);
  } else {
    console.log('Listo (sin usuarios que revisar).');
  }

  // Le dice al step "Encadenar la siguiente corrida" de check-grade.yml si
  // debe usar el ciclo corto (60s) en vez del normal (300s) — ver ese
  // workflow. GITHUB_OUTPUT no existe corriendo local (ej. pnpm run
  // check-all a mano), así que esto es un no-op fuera de Actions.
  const down = await isIntraluDown(supabase);
  console.log(down ? '🔴 INTRALU sigue caído.' : '🟢 INTRALU está respondiendo.');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `intralu_down=${down}\n`);
  }
}
```

- [ ] **Step 5: Actualizar el chequeo de variables de entorno requeridas (opcional queda opcional)**

`ADMIN_CHAT_ID` es opcional (los avisos al admin simplemente no se mandan si
falta), así que **no** se agrega a la validación de la línea 161 que hace
`process.exit(1)` — confirmar que sigue así, ningún cambio necesario ahí.

- [ ] **Step 6: Verificar que el archivo sigue siendo JS válido**

Run: `node -c check-all-users.js`

Expected: sin salida (exit code 0)

- [ ] **Step 7: Commit**

```bash
git add check-all-users.js
git commit -m "Avisa caídas/recuperaciones de INTRALU y expone el estado para el re-encadenado del cron"
```

---

### Task 5: `ADMIN_CHAT_ID` en `.env` / `.env.example`

**Files:**
- Modify: `.env` (local, no se commitea — confirmar que sigue listado en `.gitignore`)
- Modify: `.env.example`

- [ ] **Step 1: Confirmar que `.env` sigue ignorado por git**

Run: `git check-ignore -v .env`

Expected: una línea mostrando que `.gitignore` lo excluye (si no imprime nada, PARAR y avisar al usuario antes de tocar `.env` — no se debe escribir un chat_id real en un archivo trackeado).

- [ ] **Step 2: Agregar el valor real a `.env` local**

En `.env`, después de la línea `TELEGRAM_TOKEN=...` (línea 5), agregar:

```
ADMIN_CHAT_ID=837156967
```

- [ ] **Step 3: Documentar la variable opcional en `.env.example`**

En `.env.example`, después de la línea `TELEGRAM_TOKEN=` (línea 5), agregar:

```
# Opcional. Tu chat_id de Telegram (ej. hablándole a @userinfobot). Si lo
# pones, el bot te avisa por Telegram cuando INTRALU se cae y cuando se
# recupera — sin esto, esos avisos solo quedan en los logs de GitHub Actions.
ADMIN_CHAT_ID=
```

- [ ] **Step 4: Commit (solo `.env.example`, `.env` queda fuera de git)**

```bash
git status --short
```

Confirmar que `.env` NO aparece en la salida (por estar ignorado). Luego:

```bash
git add .env.example
git commit -m "Documenta ADMIN_CHAT_ID como variable opcional para avisos de caída de INTRALU"
```

---

### Task 6: Pasar `ADMIN_CHAT_ID` a los workflows y re-encadenar rápido si está caído

**Files:**
- Modify: `.github/workflows/check-grade.yml`
- Modify: `.github/workflows/check-new-registration.yml`

- [ ] **Step 1: `check-grade.yml` — agregar `id` al step y `ADMIN_CHAT_ID` al env**

Reemplazar:

```yaml
      - name: Run check-all-users
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
        run: pnpm run check-all
```

Por:

```yaml
      - name: Run check-all-users
        id: check
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          ADMIN_CHAT_ID: ${{ secrets.ADMIN_CHAT_ID }}
        run: pnpm run check-all
```

- [ ] **Step 2: `check-grade.yml` — usar un ciclo corto mientras INTRALU está caído**

Reemplazar el paso "Encadenar la siguiente corrida en ~5 min" completo:

```yaml
      - name: Encadenar la siguiente corrida en ~5 min
        if: always()
        env:
          DISPATCH_TOKEN: ${{ secrets.WORKFLOW_DISPATCH_TOKEN }}
        run: |
          if [ -z "$DISPATCH_TOKEN" ]; then
            echo "⚠️ Falta el secret WORKFLOW_DISPATCH_TOKEN — no se encadena la siguiente corrida."
            exit 0
          fi

          elapsed=$(( $(date +%s) - JOB_START ))
          sleep_for=$(( 300 - elapsed ))
          if [ "$sleep_for" -gt 0 ]; then
            echo "Esperando ${sleep_for}s para completar el ciclo de 5 min..."
            sleep "$sleep_for"
          fi

          curl -sf -X POST \
            -H "Authorization: Bearer $DISPATCH_TOKEN" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${{ github.repository }}/actions/workflows/check-grade.yml/dispatches" \
            -d "{\"ref\":\"${{ github.ref_name }}\"}"
```

Por:

```yaml
      # Ciclo normal de 300s (5 min). Mientras INTRALU esté caído (según lo
      # que escribió el step "check" en $GITHUB_OUTPUT, ver
      # check-all-users.js#main), usa un ciclo corto de 60s para detectar la
      # recuperación rápido sin necesitar un chequeo de salud aparte — ver
      # docs/superpowers/specs/2026-07-17-avisos-caida-intralu-design.md,
      # sección "Alternativas consideradas".
      - name: Encadenar la siguiente corrida
        if: always()
        env:
          DISPATCH_TOKEN: ${{ secrets.WORKFLOW_DISPATCH_TOKEN }}
          INTRALU_DOWN: ${{ steps.check.outputs.intralu_down }}
        run: |
          if [ -z "$DISPATCH_TOKEN" ]; then
            echo "⚠️ Falta el secret WORKFLOW_DISPATCH_TOKEN — no se encadena la siguiente corrida."
            exit 0
          fi

          ciclo=300
          if [ "$INTRALU_DOWN" = "true" ]; then
            ciclo=60
            echo "INTRALU está caído — usando ciclo corto de ${ciclo}s."
          fi

          elapsed=$(( $(date +%s) - JOB_START ))
          sleep_for=$(( ciclo - elapsed ))
          if [ "$sleep_for" -gt 0 ]; then
            echo "Esperando ${sleep_for}s para completar el ciclo de ${ciclo}s..."
            sleep "$sleep_for"
          fi

          curl -sf -X POST \
            -H "Authorization: Bearer $DISPATCH_TOKEN" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${{ github.repository }}/actions/workflows/check-grade.yml/dispatches" \
            -d "{\"ref\":\"${{ github.ref_name }}\"}"
```

- [ ] **Step 3: `check-new-registration.yml` — agregar `ADMIN_CHAT_ID` (sin cambio de ritmo, este workflow no se auto-encadena)**

Reemplazar:

```yaml
      - name: Run check-all-users (solo nuevos)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          SOLO_NUEVOS: 'true'
        run: pnpm run check-all
```

Por:

```yaml
      - name: Run check-all-users (solo nuevos)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          ADMIN_CHAT_ID: ${{ secrets.ADMIN_CHAT_ID }}
          SOLO_NUEVOS: 'true'
        run: pnpm run check-all
```

- [ ] **Step 4: Validar el YAML**

Run: `node -e "require('fs').readFileSync('.github/workflows/check-grade.yml','utf8')" && node -e "const yaml=require('fs').readFileSync('.github/workflows/check-grade.yml','utf8'); if(!yaml.includes('INTRALU_DOWN')) throw new Error('falta el cambio')"`

Expected: sin salida ni error (si no hay un parser YAML instalado en el
proyecto, alcanza con una revisión visual del indentado — no agregar una
dependencia nueva solo para esto).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/check-grade.yml .github/workflows/check-new-registration.yml
git commit -m "Pasa ADMIN_CHAT_ID a los workflows y acorta el ciclo de re-encadenado mientras INTRALU está caído"
```

- [ ] **Step 6: Avisar al usuario del secret manual pendiente**

Recordarle que cree el secret `ADMIN_CHAT_ID` = `837156967` en GitHub →
Settings del repo → Secrets and variables → Actions → New repository
secret, si todavía no lo hizo — sin esto, `${{ secrets.ADMIN_CHAT_ID }}`
llega vacío al job y los avisos al admin no se mandan (no falla nada, solo
se pierde la notificación).

---

### Task 7: "Última actualización" en `/notas` y aviso de "no en vivo" en ciclo pasado

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Agregar "Última actualización" a `/notas`**

Reemplazar (líneas 395-407):

```ts
  } else if (text === '/notas') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const cursos = (data.cursos ?? {}) as Record<string, CursoMeta>;
      const bloque = agruparPorCurso(cursos);
      if (!bloque) {
        await sendMessage(chatId, 'Todavía no tienes notas registradas.');
      } else {
        await sendMessage(chatId, `📋 Tus notas (ciclo actual):\n\n${bloque}`);
      }
    }
```

Por:

```ts
  } else if (text === '/notas') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const cursos = (data.cursos ?? {}) as Record<string, CursoMeta>;
      const bloque = agruparPorCurso(cursos);
      const actualizado = `\n\nÚltima actualización: ${formatearFecha(data.updated_at)}`;
      if (!bloque) {
        await sendMessage(chatId, `Todavía no tienes notas registradas.${actualizado}`);
      } else {
        await sendMessage(chatId, `📋 Tus notas (ciclo actual):\n\n${bloque}${actualizado}`);
      }
    }
```

- [ ] **Step 2: Agregar aviso de "no en vivo" a la vista de ciclo pasado cacheado**

Reemplazar (líneas 178-186, dentro de `manejarCallbackQuery`):

```ts
  if (cursosDelPeriodo) {
    if (messageId) await editMessageText(chatId, messageId, `📚 Ciclo ${etiqueta} seleccionado.`);
    const bloque = agruparPorCurso(cursosDelPeriodo);
    await sendMessage(
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiqueta}:\n\n${bloque}`
        : `No encontré notas registradas en el ciclo ${etiqueta}.`,
    );
```

Por:

```ts
  if (cursosDelPeriodo) {
    if (messageId) await editMessageText(chatId, messageId, `📚 Ciclo ${etiqueta} seleccionado.`);
    const bloque = agruparPorCurso(cursosDelPeriodo);
    await sendMessage(
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiqueta}:\n\n${bloque}\n\n📌 Datos guardados de cuando se consultó este ciclo, no en vivo.`
        : `No encontré notas registradas en el ciclo ${etiqueta}.`,
    );
```

- [ ] **Step 3: Verificar que el archivo sigue siendo TypeScript válido**

Run: `npx -y typescript@5 --noEmit --target es2022 --module esnext --moduleResolution bundler supabase/functions/telegram-webhook/index.ts 2>&1 | head -30`

Expected: puede haber errores preexistentes de tipos de `npm:`/`Deno.env` que
ya existían antes de este cambio (el archivo es una Edge Function de Deno,
no un proyecto Node con `tsconfig.json` propio) — revisar que no aparezcan
errores **nuevos** apuntando a las líneas tocadas en los Steps 1-2. Si el
comando falla por completo por falta de red/paquete, alcanza con una
revisión visual cuidadosa del diff (comillas, llaves, template literals).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "Muestra última actualización en /notas y aclara que los ciclos pasados son datos guardados"
```

---

### Task 8: Verificación manual end-to-end

**Files:** ninguno (solo verificación)

- [ ] **Step 1: Confirmar que la migración SQL ya corrió**

Preguntarle al usuario si ya pegó y corrió en el SQL Editor de Supabase los
bloques del Task 3 (columna `network_issue_notified` + tabla
`service_status`). Si no, no seguir con este task — los siguientes pasos
fallan sin esas tablas/columnas.

- [ ] **Step 2: Probar `markIntraluDown`/`markIntraluUp` en local**

Con `.env` cargado (`ADMIN_CHAT_ID` ya seteado del Task 5), correr dos
llamadas concurrentes a `markIntraluDown` y confirmar que solo una manda
mensaje:

Run:
```bash
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { markIntraluDown, markIntraluUp } = require('./lib/service-status');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  await supabase.from('service_status').update({ is_down: false }).eq('service', 'intralu');
  const [a, b] = await Promise.all([
    markIntraluDown(supabase, process.env.TELEGRAM_TOKEN, process.env.ADMIN_CHAT_ID),
    markIntraluDown(supabase, process.env.TELEGRAM_TOKEN, process.env.ADMIN_CHAT_ID),
  ]);
  console.log('cambiaron el estado:', a, b, '(debe ser exactamente uno true)');
  await markIntraluUp(supabase, process.env.TELEGRAM_TOKEN, process.env.ADMIN_CHAT_ID);
})();
"
```

Expected: en la consola, exactamente uno de `a`/`b` es `true`; en Telegram,
el `ADMIN_CHAT_ID` recibe un solo mensaje de "🔴 INTRALU parece estar
caído..." y luego uno de "🟢 INTRALU volvió a responder (estuvo caído ~0
min)."

- [ ] **Step 3: Confirmar `/notas` y `/ciclos` en el bot real**

Mandarle `/notas` y (si hay algún ciclo pasado ya cacheado) tocar un botón
de `/ciclos` al bot real desde Telegram. Confirmar visualmente que aparece
la línea de "Última actualización" en `/notas` y el aviso de "no en vivo"
en el ciclo pasado.

- [ ] **Step 4: Confirmar el secret y el flujo del workflow**

Revisar en GitHub → Settings → Secrets and variables → Actions que
`ADMIN_CHAT_ID` y `WORKFLOW_DISPATCH_TOKEN` estén ambos configurados.
Disparar `check-grade.yml` manualmente (`workflow_dispatch`) una vez desde
la pestaña Actions y revisar en los logs del step "Encadenar la siguiente
corrida" que imprime `Esperando ...s para completar el ciclo de 300s...`
(ciclo normal, ya que INTRALU está sano) — confirma que `INTRALU_DOWN` se
está leyendo bien del output del step anterior sin romper el flujo
existente.
