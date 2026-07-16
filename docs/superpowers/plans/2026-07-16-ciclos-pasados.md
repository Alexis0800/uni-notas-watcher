# Consultar ciclos pasados + PP por curso — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered student pull up their grades from a past academic cycle on demand (`/ciclos`), without ever touching the current-cycle 5-minute check or notification behavior, and without bulk-scraping INTRALU for a user's entire history at once.

**Architecture:** `lib/session.js`'s existing period-aware `fetchEvaluaciones` gets a period-aware sibling for the course list too. A new, thin Node script (`fetch-historial.js`) and a new GitHub Actions workflow (`fetch-historial.yml`, own per-`(chat_id, codper)` concurrency group) do the one real INTRALU login required to fetch a single past cycle, triggered by a new `/ciclos` command in the Deno webhook — which also gains its first-ever `callback_query` handling (every existing button is a Mini App `web_app` button; this one is a plain choice, no form needed). Historical data is cached forever once fetched (grades from a closed cycle don't change) in a new `historial` column, separate from the `cursos` column the live 5-minute chain owns exclusively.

**Tech Stack:** Node (`check-all-users.js`, new `fetch-historial.js`, new shared `lib/notificaciones.js`), Deno/TypeScript (`telegram-webhook`), GitHub Actions (new `fetch-historial.yml`), Postgres/Supabase (two new `jsonb` columns).

**Reference:** Design spec at [`docs/superpowers/specs/2026-07-16-ciclos-pasados-design.md`](../specs/2026-07-16-ciclos-pasados-design.md).

---

### Task 1: Schema — `periodos_disponibles` y `historial`

**Files:**
- Modify: `supabase/schema.sql`

- [ ] **Step 1: Add the two new columns to the `create table`**

Replace:

```sql
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  codigo_uni text not null,
  password_encrypted text not null,
  last_grades jsonb not null default '{}'::jsonb,
  -- Fórmulas y promedios por curso del ciclo actual (para /simular), clave
  -- "codcur-seccion": { nombre, formulas: {practicas, teoria}, promedios }.
  cursos jsonb not null default '{}'::jsonb,
  -- false hasta el primer chequeo tras registrarse: ese primer chequeo solo
  -- guarda el estado base sin notificar, para no avisar "nota nueva" de
  -- notas que la persona ya tenía antes de registrarse.
  seeded boolean not null default false,
  active boolean not null default true,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

with:

```sql
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  codigo_uni text not null,
  password_encrypted text not null,
  last_grades jsonb not null default '{}'::jsonb,
  -- Fórmulas y promedios por curso del ciclo actual (para /simular), clave
  -- "codcur-seccion": { nombre, formulas: {practicas, teoria}, promedios }.
  cursos jsonb not null default '{}'::jsonb,
  -- Lista de códigos de período que trae el selector de INTRALU (ej.
  -- ["20261","20252",...]) — se llena gratis durante el chequeo normal del
  -- ciclo actual, la usa /ciclos para armar los botones.
  periodos_disponibles jsonb not null default '[]'::jsonb,
  -- Caché permanente de ciclos pasados ya consultados por /ciclos, clave
  -- codper: mismo formato que `cursos`. Nunca lo toca el chequeo de 5 min
  -- (eso solo escribe `cursos`) — solo fetch-historial.js, bajo demanda.
  historial jsonb not null default '{}'::jsonb,
  -- false hasta el primer chequeo tras registrarse: ese primer chequeo solo
  -- guarda el estado base sin notificar, para no avisar "nota nueva" de
  -- notas que la persona ya tenía antes de registrarse.
  seeded boolean not null default false,
  active boolean not null default true,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 2: Add a migration snippet at the end of the file, for the already-deployed database**

Append at the end of the file (after the `alter table usuarios enable row level security;` line):

```sql

-- Migración para una base ya desplegada (el create table de arriba solo
-- aplica a instalaciones nuevas) — pega y corre esto una vez en el SQL
-- Editor de tu proyecto de Supabase si tu tabla `usuarios` ya existía antes
-- de este cambio:
--
-- alter table usuarios add column if not exists periodos_disponibles jsonb not null default '[]'::jsonb;
-- alter table usuarios add column if not exists historial jsonb not null default '{}'::jsonb;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "Agrega periodos_disponibles y historial al esquema para consultar ciclos pasados"
```

## Context

This is Task 1 of an 8-task plan (see docs/superpowers/plans/2026-07-16-ciclos-pasados.md and the linked spec for full background — self-contained, no need to read them). This change is purely additive (new columns with defaults) — no existing column, row, or query is touched. The actual `ALTER TABLE` against the live production database is a **manual step for the human maintainer** (Task 8 will remind them) — do not attempt to run it yourself against production; you only edit the SQL file here.

Work directly on the `main` branch — the user has explicitly consented to that for this whole plan.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Make exactly the two edits.
2. Commit with the exact message given.
3. Self-review.
4. Report back.

## Before Reporting Back: Self-Review

- Are both new columns present in the `create table`, with sensible defaults (`'[]'::jsonb` for a list, `'{}'::jsonb` for a map)?
- Is the migration snippet appended after the existing `alter table ... enable row level security;` line, clearly commented as SQL (so it doesn't accidentally execute if someone re-runs the whole file blindly — it's written as a comment block, confirm that's preserved)?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 2: `lib/session.js` — `fetchCursosMatriculados` acepta un período opcional

**Files:**
- Modify: `lib/session.js:57-80`

- [ ] **Step 1: Replace `fetchCursosMatriculados`**

Replace:

```js
// Devuelve { codper, csrfToken, cursos: [{ codcur, seccion, nombre }] } para
// el periodo actual (el que aparece seleccionado por defecto en INTRALU).
async function fetchCursosMatriculados(client) {
  const res = await client.get(`${BASE_URL}/informacion-academica/cursos`);
  const $ = cheerio.load(res.data);

  const csrfToken = $('meta[name="csrf-token"]').attr('content');
  const codper = $('#cb-periodos option[selected]').attr('value');

  const cursos = [];
  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const btn = $row.find('.btn-ver-curso');
    if (!btn.length) return;

    cursos.push({
      codcur: btn.data('codcur'),
      seccion: btn.data('seccion'),
      nombre: $row.find('td').eq(1).text().trim().replace(/-+$/, '').trim(),
    });
  });

  return { codper, csrfToken, cursos };
}
```

with:

```js
// Devuelve { codper, csrfToken, cursos: [{ codcur, seccion, nombre }],
// periodos } para un período dado (o el actual, el que aparece
// seleccionado por defecto en INTRALU, si no se pasa `codper`). `periodos`
// es la lista completa de códigos de período que ofrece el selector de
// INTRALU (ej. ["20261","20252",...]) — confirmado contra el sitio real
// que `?codper=X` sí devuelve los cursos de un período pasado (ver
// docs/GRADING-RULES.md).
async function fetchCursosMatriculados(client, codper) {
  const url = codper
    ? `${BASE_URL}/informacion-academica/cursos?codper=${codper}`
    : `${BASE_URL}/informacion-academica/cursos`;
  const res = await client.get(url);
  const $ = cheerio.load(res.data);

  const csrfToken = $('meta[name="csrf-token"]').attr('content');
  const codperActual = $('#cb-periodos option[selected]').attr('value');
  const periodos = $('#cb-periodos option')
    .map((_, o) => $(o).attr('value'))
    .get();

  const cursos = [];
  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const btn = $row.find('.btn-ver-curso');
    if (!btn.length) return;

    cursos.push({
      codcur: btn.data('codcur'),
      seccion: btn.data('seccion'),
      nombre: $row.find('td').eq(1).text().trim().replace(/-+$/, '').trim(),
    });
  });

  return { codper: codperActual, csrfToken, cursos, periodos };
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check lib/session.js
```

Expected: no output.

- [ ] **Step 3: Verify against the real site with the test account**

This confirms the change didn't break the existing (no-`codper`) call path, and that passing a real past `codper` works. Run this from the repo root (relative `require`s, no temp file needed — this is a one-liner, already confirmed to work against the real site with the baseline function before this task's change):

```bash
node -e "
require('dotenv').config();
const { login, fetchCursosMatriculados } = require('./lib/session.js');
(async () => {
  const client = await login(process.env.UNI_CODIGO, process.env.UNI_PASSWORD);

  const actual = await fetchCursosMatriculados(client);
  console.log('Sin codper (ciclo actual):', actual.codper, '-', actual.cursos.length, 'curso(s),', actual.periodos.length, 'período(s) en el selector');

  const otroPeriodo = actual.periodos.find((p) => p !== actual.codper);
  if (otroPeriodo) {
    const pasado = await fetchCursosMatriculados(client, otroPeriodo);
    console.log('Con codper=' + otroPeriodo + ':', pasado.codper, '-', pasado.cursos.length, 'curso(s)');
  }
})().catch((err) => { console.error('Error:', err.message); process.exit(1); });
"
```

Expected: the "Sin codper" line reports the current cycle's course count (should be non-zero if the test account has active enrollments) and a period list of 15+ entries; the "Con codper=" line reports a different, real course count for a past cycle (can be 0 courses for some periods — that's a valid result, not a failure, as long as it doesn't throw).

- [ ] **Step 4: Commit**

```bash
git add lib/session.js
git commit -m "fetchCursosMatriculados acepta un período específico, no solo el actual"
```

## Context

This is Task 2 of an 8-task plan. `lib/session.js` is the single, already-tested implementation of INTRALU login/scraping, shared by `check-all-users.js` and (after Task 4) the new `fetch-historial.js`. This task only extends one function with an optional parameter — every existing call site (`check-all-users.js`, calling with no `codper`) keeps working identically, since the new parameter defaults to the current behavior when omitted.

`UNI_CODIGO`/`UNI_PASSWORD` are already in the local `.env` for the real test account — this project's established convention (see `login-test.js`, `CONTRIBUTING.md`) is to verify scraper changes against the real site manually, since there's no INTRALU staging environment.

Work directly on the `main` branch.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Replace the function exactly as specified.
2. Run the syntax check.
3. Run the real-site verification, confirm the expected shape of output.
4. Commit with the exact message.
5. Self-review.
6. Report back.

**While you work:** if the real-site verification throws an error you don't understand (e.g., login fails, or the selector no longer matches), stop and report BLOCKED with the exact error — don't guess at a fix to a site behavior you can't directly inspect further without more context.

## Before Reporting Back: Self-Review

- Does `fetchCursosMatriculados()` (no arg) still return the exact same shape as before, plus the new `periodos` field?
- Does `fetchCursosMatriculados(client, codper)` hit the URL with `?codper=` appended?
- Did the real-site check produce sane output (non-throwing, plausible course/period counts)?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Real-site verification output (paste it)
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 3: `lib/notificaciones.js` (nuevo) + refactor de `check-all-users.js`

**Files:**
- Create: `lib/notificaciones.js`
- Modify: `check-all-users.js` (imports, remove now-duplicated functions, add `periodos_disponibles` write)

- [ ] **Step 1: Create `lib/notificaciones.js`**

```js
const axios = require('axios');

const NOTA_APROBATORIA = 10;

async function sendTelegram(token, chatId, text, replyMarkup) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// 🟢 si aprobó (>=10), 🔴 si desaprobó, anuló (0A) o no se presentó (NSP).
// Telegram no soporta color de texto en sus mensajes — esto es lo más
// parecido que se puede hacer.
function emoji(ev) {
  if (!ev.anulada && ev.nota !== null && ev.nota >= NOTA_APROBATORIA) return '🟢';
  return '🔴';
}

function emojiValor(valor) {
  const n = Number(valor);
  return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
}

// Agrupa evaluaciones por curso para que el nombre del curso no se repita
// en cada línea — una vez el curso, las evaluaciones sangradas debajo.
// Cierra cada bloque con el PP y el promedio del curso que ya calcula
// INTRALU (cursosMeta[cursoKey].promedios, ver docs/GRADING-RULES.md) —
// nunca se recalcula acá, así nadie tiene que sacar la cuenta a mano. El PP
// solo se muestra si el curso tiene fórmula de prácticas (algunos no).
function agruparPorCurso(evaluaciones, cursosMeta) {
  const porCurso = new Map();
  for (const ev of evaluaciones) {
    if (!porCurso.has(ev.cursoKey)) porCurso.set(ev.cursoKey, []);
    porCurso.get(ev.cursoKey).push(ev);
  }
  const bloques = [];
  for (const [cursoKey, evs] of porCurso) {
    const lineas = evs.map((e) => `   ${emoji(e)} ${e.descripcion}: <b>${e.valor}</b>`);
    const meta = cursosMeta[cursoKey];
    const pp = meta?.formulas?.practicas ? meta?.promedios?.promedio_practicas : null;
    const final = meta?.promedios?.promedio_final;
    const lineaPP = pp != null ? `\n   📊 PP (prácticas): ${emojiValor(pp)} <b>${pp}</b>` : '';
    const lineaFinal = final != null ? `\n   📊 Promedio del curso: ${emojiValor(final)} <b>${final}</b>` : '';
    bloques.push(`📘 <b>${evs[0].curso}</b>\n${lineas.join('\n')}${lineaPP}${lineaFinal}`);
  }
  return bloques.join('\n\n');
}

// AAAA + dígito de ciclo: 1 primer ciclo, 2 segundo ciclo, 3 verano
// (confirmado por un alumno real de la universidad). Un dígito desconocido
// (ej. un hipotético "0") cae a un formato genérico en vez de inventar un
// numeral que no existe.
const ROMANOS = { '1': 'I', '2': 'II', '3': 'III' };
function etiquetaPeriodo(codper) {
  const anio = codper.slice(0, 4);
  const digito = codper.slice(4);
  return ROMANOS[digito] ? `${anio}-${ROMANOS[digito]}` : `${anio} (ciclo ${digito})`;
}

module.exports = { sendTelegram, emoji, emojiValor, agruparPorCurso, etiquetaPeriodo, NOTA_APROBATORIA };
```

- [ ] **Step 2: Update `check-all-users.js`'s imports**

Replace:

```js
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
```

with:

```js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso } = require('./lib/notificaciones');
```

- [ ] **Step 3: Remove the now-duplicated constant and functions**

Replace:

```js
const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;
const FAILURE_THRESHOLD = 3;
const NOTA_APROBATORIA = 10;
```

with:

```js
const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;
const FAILURE_THRESHOLD = 3;
```

Replace:

```js
const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

async function sendTelegram(token, chatId, text, replyMarkup) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// 🟢 si aprobó (>=10), 🔴 si desaprobó, anuló (0A) o no se presentó (NSP).
// Telegram no soporta color de texto en sus mensajes — esto es lo más
// parecido que se puede hacer.
function emoji(ev) {
  if (!ev.anulada && ev.nota !== null && ev.nota >= NOTA_APROBATORIA) return '🟢';
  return '🔴';
}

function emojiValor(valor) {
  const n = Number(valor);
  return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
}

// Agrupa evaluaciones por curso para que el nombre del curso no se repita
// en cada línea — una vez el curso, las evaluaciones sangradas debajo.
// Cierra cada bloque con el PP y el promedio del curso que ya calcula
// INTRALU (cursosMeta[cursoKey].promedios, ver docs/GRADING-RULES.md) —
// nunca se recalcula acá, así nadie tiene que sacar la cuenta a mano. El PP
// solo se muestra si el curso tiene fórmula de prácticas (algunos no).
function agruparPorCurso(evaluaciones, cursosMeta) {
  const porCurso = new Map();
  for (const ev of evaluaciones) {
    if (!porCurso.has(ev.cursoKey)) porCurso.set(ev.cursoKey, []);
    porCurso.get(ev.cursoKey).push(ev);
  }
  const bloques = [];
  for (const [cursoKey, evs] of porCurso) {
    const lineas = evs.map((e) => `   ${emoji(e)} ${e.descripcion}: <b>${e.valor}</b>`);
    const meta = cursosMeta[cursoKey];
    const pp = meta?.formulas?.practicas ? meta?.promedios?.promedio_practicas : null;
    const final = meta?.promedios?.promedio_final;
    const lineaPP = pp != null ? `\n   📊 PP (prácticas): ${emojiValor(pp)} <b>${pp}</b>` : '';
    const lineaFinal = final != null ? `\n   📊 Promedio del curso: ${emojiValor(final)} <b>${final}</b>` : '';
    bloques.push(`📘 <b>${evs[0].curso}</b>\n${lineas.join('\n')}${lineaPP}${lineaFinal}`);
  }
  return bloques.join('\n\n');
}
```

with:

```js
const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}
```

- [ ] **Step 4: Save `periodos_disponibles` alongside `cursos`**

Replace:

```js
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const { codper, csrfToken, cursos } = await fetchCursosMatriculados(client);
```

with:

```js
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const { codper, csrfToken, cursos, periodos } = await fetchCursosMatriculados(client);
```

Replace:

```js
    await supabase
      .from('usuarios')
      .update({
        last_grades: currentMap,
        cursos: cursosMeta,
        seeded: true,
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
```

with:

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
```

- [ ] **Step 5: Verify syntax**

```bash
node --check lib/notificaciones.js
node --check check-all-users.js
```

Expected: no output from either.

- [ ] **Step 6: Verify the extraction didn't change behavior**

```bash
node -e "
const { agruparPorCurso, etiquetaPeriodo, emoji, emojiValor, sendTelegram } = require('./lib/notificaciones');
console.log(typeof agruparPorCurso, typeof etiquetaPeriodo, typeof emoji, typeof emojiValor, typeof sendTelegram);
console.log(etiquetaPeriodo('20261'), etiquetaPeriodo('20262'), etiquetaPeriodo('20263'), etiquetaPeriodo('20260'));
const cursosMeta = { 'X1-A': { nombre: 'CURSO DE PRUEBA', formulas: { practicas: '(N1)/1', teoria: null }, promedios: { promedio_final: '15.0', promedio_practicas: '15.0' } } };
console.log(agruparPorCurso([{ cursoKey: 'X1-A', curso: 'CURSO DE PRUEBA', descripcion: 'PRACTICA 1', nota: 15, anulada: false, valor: '15' }], cursosMeta));
"
```

Expected: all five `typeof` results are `function`; `etiquetaPeriodo` prints `2026-I 2026-II 2026-III 2026 (ciclo 0)`; the last block prints a `📘 CURSO DE PRUEBA` block with the practica line, a PP line, and a promedio line — same shape as `/notas` messages already in production.

- [ ] **Step 7: Commit**

```bash
git add lib/notificaciones.js check-all-users.js
git commit -m "Extrae sendTelegram/agruparPorCurso a lib/notificaciones.js compartido, guarda periodos_disponibles"
```

## Context

This is Task 3 of an 8-task plan. `lib/notificaciones.js` is a **new Node-only shared module** — unlike `lib/crypto.js` (deliberately duplicated between Node and Deno because Edge Functions deploy in total isolation), this is shared between two Node scripts in the same repo (`check-all-users.js` today, `fetch-historial.js` in Task 4), which is a completely normal, low-risk `require()` — no cross-runtime concern here.

This task is a pure extraction (move code, don't change its logic) plus one small additive change (save the new `periodos` field Task 2 added). The message text/formatting your extraction produces must be **byte-identical** to what's in production today — this is refactoring, not a rewrite.

Work directly on the `main` branch.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Create the new file exactly as specified.
2. Make the three edits to `check-all-users.js` exactly as specified.
3. Run both verification steps.
4. Commit with the exact message.
5. Self-review.
6. Report back.

## Code Organization

`lib/notificaciones.js` is a small, focused module (message formatting + sending) — don't add anything to it beyond what's specified. Keep `check-all-users.js`'s own remaining functions (`checkUser`, `main`) untouched except for the specific lines called out.

## Before Reporting Back: Self-Review

- Is `check-all-users.js` free of any leftover duplicate definition of `sendTelegram`/`emoji`/`emojiValor`/`agruparPorCurso`/`NOTA_APROBATORIA` (grep to confirm each appears exactly once across the two files, in `lib/notificaciones.js`)?
- Is `axios` still `require`d anywhere in `check-all-users.js`? It shouldn't be — it was only used by the now-removed inline `sendTelegram`. If your diff leaves an unused `const axios = require('axios');`, remove it.
- Does `periodos` flow from `fetchCursosMatriculados` destructuring through to the `.update(...)` call correctly?
- Do both `node --check` calls and the behavior-verification script pass with the expected output?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Verification output (paste the behavior-check output)
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 4: `fetch-historial.js` (nuevo script)

**Files:**
- Create: `fetch-historial.js`
- Modify: `package.json` (add a script entry)

- [ ] **Step 1: Create `fetch-historial.js`**

```js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchCursosMatriculados, fetchEvaluaciones, formatearNota } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, agruparPorCurso, etiquetaPeriodo } = require('./lib/notificaciones');

// Corrido por .github/workflows/fetch-historial.yml, disparado por
// telegram-webhook cuando alguien pide un ciclo pasado por /ciclos que
// todavía no está en `historial`. Revisa un solo (chat_id, codper) por
// corrida — nunca un lote, para no generar una ráfaga de requests contra
// INTRALU si alguien quisiera "todo su historial" de una vez (ver
// docs/superpowers/specs/2026-07-16-ciclos-pasados-design.md).
async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    CREDENTIALS_ENCRYPTION_KEY,
    TELEGRAM_TOKEN,
    CHAT_ID,
    CODPER,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN || !CHAT_ID || !CODPER) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN, CHAT_ID o CODPER en el entorno');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const chatId = Number(CHAT_ID);

  const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
  if (error || !usuario) {
    console.error('❌ No encontré a chat_id', chatId, error?.message || '');
    process.exit(1);
  }

  try {
    const password = await decrypt(usuario.password_encrypted, CREDENTIALS_ENCRYPTION_KEY);
    const client = await login(usuario.codigo_uni, password);
    const { csrfToken, cursos } = await fetchCursosMatriculados(client, CODPER);

    const cursosMeta = {};
    const evaluacionesTodas = [];
    for (const curso of cursos) {
      const { evaluaciones, formulas, promedios } = await fetchEvaluaciones(client, csrfToken, { codper: CODPER, ...curso });
      const cursoKey = `${curso.codcur}-${curso.seccion}`;
      cursosMeta[cursoKey] = {
        nombre: curso.nombre,
        formulas,
        promedios,
        evaluaciones: evaluaciones.map((ev) => ({
          variable: ev.variable,
          descripcion: ev.descripcion,
          nota: ev.nota,
          anulada: ev.anulada,
          valor: ev.fecha ? formatearNota(ev) : null,
          fecha: ev.fecha,
        })),
      };

      for (const ev of evaluaciones) {
        if (!ev.fecha) continue;
        evaluacionesTodas.push({
          cursoKey,
          curso: curso.nombre,
          descripcion: ev.descripcion,
          nota: ev.nota,
          anulada: ev.anulada,
          valor: formatearNota(ev),
          fecha: ev.fecha,
        });
      }
    }

    const historialActualizado = { ...(usuario.historial || {}), [CODPER]: cursosMeta };
    await supabase.from('usuarios').update({ historial: historialActualizado }).eq('id', usuario.id);

    const bloque = agruparPorCurso(evaluacionesTodas, cursosMeta);
    await sendTelegram(
      TELEGRAM_TOKEN,
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiquetaPeriodo(CODPER)}:\n\n${bloque}`
        : `No encontré notas registradas en el ciclo ${etiquetaPeriodo(CODPER)}.`,
    );
    console.log(`✅ Historial de ${CODPER} guardado para chat_id ${chatId}`);
  } catch (err) {
    console.error(`❌ chat_id ${chatId}, codper ${CODPER}:`, err.message);
    await sendTelegram(
      TELEGRAM_TOKEN,
      chatId,
      `❌ No pude revisar el ciclo ${etiquetaPeriodo(CODPER)}: ${err.message}`,
    ).catch(() => {});
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Add a package.json script entry**

Replace:

```json
    "test-login": "node login-test.js",
    "benchmark-concurrency": "node benchmark-concurrency.js",
    "check-all": "node check-all-users.js"
```

with:

```json
    "test-login": "node login-test.js",
    "benchmark-concurrency": "node benchmark-concurrency.js",
    "check-all": "node check-all-users.js",
    "fetch-historial": "node fetch-historial.js"
```

- [ ] **Step 3: Verify syntax**

```bash
node --check fetch-historial.js
```

Expected: no output.

- [ ] **Step 4: Verify end-to-end against the real site and real database, using the test account**

This actually logs in, fetches a past cycle, writes to `historial`, and sends a real Telegram message — that's the point, it's exercising the exact same path production will use. The `.env` test account's real `chat_id` is `837156967`, and `20252` is a confirmed-real past period for that account (already verified against the live site to return 5 real courses, during design research for this feature):

```bash
CHAT_ID=837156967 CODPER=20252 node fetch-historial.js
```

Expected: prints `✅ Historial de 20252 guardado para chat_id 837156967`, and a real Telegram message arrives in that chat with the `📚 Tus notas del ciclo 2025-II:` header.

Then confirm the write landed and is additive (didn't wipe `cursos` or any other `historial` entry):

```bash
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data } = await supabase.from('usuarios').select('cursos, historial').eq('chat_id', 837156967).maybeSingle();
  console.log('cursos (ciclo actual) sigue con', Object.keys(data.cursos || {}).length, 'curso(s)');
  console.log('historial ahora tiene los períodos:', Object.keys(data.historial || {}));
})();
"
```

Expected: `cursos` unaffected (same course count as before running this), `historial` now includes `20252` in its keys.

Expected: `cursos` still has its usual current-cycle course count (unchanged by this script), and `historial`'s keys include the `CODPER` you just fetched.

- [ ] **Step 5: Commit**

```bash
git add fetch-historial.js package.json
git commit -m "Agrega fetch-historial.js: trae un ciclo pasado bajo demanda y lo guarda en historial"
```

## Context

This is Task 4 of an 8-task plan. This script is the Node-side counterpart to the `/ciclos` command (Task 6 wires up the Deno trigger). It's intentionally scoped to **one user, one period, per run** — no batching, no loop, mirroring `check-new-registration.js`'s "narrow and fast" shape rather than `check-all-users.js`'s "batch" shape. `lib/notificaciones.js` (Task 3) already has everything this script needs for formatting/sending — don't duplicate any of that logic here.

`historialActualizado` does a read-modify-write (spread the existing `historial`, add one key) rather than a database-side JSONB merge — this is a known, accepted, low-probability race if the *same* user requests *two different* past periods within moments of each other (documented in the design spec), consistent with this codebase's existing risk tolerance for similar unlikely races (e.g. `consecutive_failures` increments in `check-all-users.js` aren't atomic either). Don't add locking/merge logic beyond what's specified — that would be solving a problem this project has explicitly decided not to solve here.

Work directly on the `main` branch.

## Before You Begin

If anything is unclear — especially if you're unsure what a safe, real `CHAT_ID`/`CODPER` pair to test with looks like — ask now rather than guessing with fabricated values (this script does a real INTRALU login and sends a real Telegram message; running it with a nonsense `CHAT_ID` will just fail cleanly at the "no encontré a chat_id" check, which is fine to demonstrate too, but the *positive* end-to-end path needs the real test account).

## Your Job

1. Create the file exactly as specified.
2. Add the package.json entry.
3. Run the syntax check.
4. Run the real end-to-end verification.
5. Commit with the exact message.
6. Self-review.
7. Report back.

## Before Reporting Back: Self-Review

- Does the script exit cleanly (non-zero exit code, no unhandled rejection) if the target user doesn't exist?
- Does the catch block send an error message to the user instead of failing silently — they explicitly asked for this cycle, they deserve to know if it failed?
- Did the real end-to-end check show `cursos` unaffected and `historial` gaining exactly the new key?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- End-to-end verification output (paste it, redact nothing sensitive was printed since no secrets are logged by this script)
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 5: `.github/workflows/fetch-historial.yml` (nuevo workflow)

**Files:**
- Create: `.github/workflows/fetch-historial.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Fetch historial

# Disparado solo por telegram-webhook cuando alguien pide, con /ciclos, un
# ciclo pasado que todavía no está en `historial`. Corre una sola vez (sin
# sleep, sin auto-encadenarse) y revisa un solo (chat_id, codper) — nunca un
# lote. El concurrency group está scopeado a ese par específico (no a todo
# el workflow, a diferencia de check-grade.yml/check-new-registration.yml):
# dos usuarios distintos pidiendo períodos distintos corren en paralelo sin
# problema; solo se evita que el mismo usuario dispare dos veces la misma
# consulta encimada.

on:
  workflow_dispatch:
    inputs:
      chat_id:
        description: 'Telegram chat_id del usuario'
        required: true
        type: string
      codper:
        description: 'Código de período a consultar (ej. 20252)'
        required: true
        type: string

concurrency:
  group: fetch-historial-${{ github.event.inputs.chat_id }}-${{ github.event.inputs.codper }}
  cancel-in-progress: true

jobs:
  fetch-historial:
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

      - name: Run fetch-historial
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          CREDENTIALS_ENCRYPTION_KEY: ${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          CHAT_ID: ${{ github.event.inputs.chat_id }}
          CODPER: ${{ github.event.inputs.codper }}
        run: pnpm run fetch-historial
```

- [ ] **Step 2: Validate the YAML**

```bash
python -c "
import yaml
with open('.github/workflows/fetch-historial.yml', encoding='utf-8') as f:
    d = yaml.safe_load(f)
print('YAML valido')
print(d['on']['workflow_dispatch']['inputs'].keys())
"
```

Expected: prints `YAML valido` then `dict_keys(['chat_id', 'codper'])`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/fetch-historial.yml
git commit -m "Agrega el workflow fetch-historial.yml para consultar un ciclo pasado bajo demanda"
```

## Context

This is Task 5 of an 8-task plan. This workflow won't be triggerable by the GitHub API until it exists on `main` (Task 8 covers pushing everything and doing the real end-to-end test). It reuses the exact same secrets already configured for `check-grade.yml`/`check-new-registration.yml` — no new GitHub secret needed for this task specifically (Task 6's webhook changes reuse the existing `GITHUB_DISPATCH_TOKEN` Supabase secret, which already has repo-wide Actions permission).

Work directly on the `main` branch.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Create the file exactly as specified.
2. Validate the YAML.
3. Commit with the exact message.
4. Self-review.
5. Report back.

## Before Reporting Back: Self-Review

- Does the `concurrency.group` expression reference both `github.event.inputs.chat_id` and `github.event.inputs.codper` (not just one)?
- Does the job call `pnpm run fetch-historial` (the script added in Task 4), not `node fetch-historial.js` directly (either works, but match the plan's convention of using the package.json script, consistent with `check-all`)?
- Does the YAML validate?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- YAML validation output
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 6: `telegram-webhook/index.ts` — comando `/ciclos` + `callback_query`

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Add `Historial` type and extend `AYUDA`**

Replace:

```ts
type EvaluacionCurso = {
  variable: string;
  descripcion: string;
  nota: number | null;
  anulada: boolean;
  valor: string | null;
  fecha: string | null;
};
// Ya calculado por INTRALU, nunca se recalcula acá — ver
// docs/GRADING-RULES.md#promedios-que-ya-calcula-intralu. Todo llega como
// texto (no número).
type Promedios = { promedio_final?: string; promedio_practicas?: string; nota_asistencia?: string };
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  promedios: Promedios | null;
  evaluaciones: EvaluacionCurso[];
};
```

with:

```ts
type EvaluacionCurso = {
  variable: string;
  descripcion: string;
  nota: number | null;
  anulada: boolean;
  valor: string | null;
  fecha: string | null;
};
// Ya calculado por INTRALU, nunca se recalcula acá — ver
// docs/GRADING-RULES.md#promedios-que-ya-calcula-intralu. Todo llega como
// texto (no número).
type Promedios = { promedio_final?: string; promedio_practicas?: string; nota_asistencia?: string };
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  promedios: Promedios | null;
  evaluaciones: EvaluacionCurso[];
};
// Caché permanente de ciclos pasados ya consultados por /ciclos, clave
// codper — nunca lo toca el chequeo de 5 min (ver
// docs/superpowers/specs/2026-07-16-ciclos-pasados-design.md).
type Historial = Record<string, Record<string, CursoMeta>>;
```

Replace:

```ts
const AYUDA = `Notificador de notas UNI (INTRALU)

Comandos:
<b>/registrar</b> — registra o actualiza tu usuario de INTRALU (abre un formulario)
<b>/notas</b> — muestra todas tus notas registradas hasta ahora
<b>/simular</b> — simula tu nota final de un curso con las evaluaciones que aún faltan
<b>/estado</b> — ve si estás activo y cuándo se revisó por última vez
<b>/baja</b> — borra tu registro y tu contraseña
<b>/ayuda</b> — este mensaje

🔒 Tu contraseña se guarda cifrada, nunca en texto plano. El formulario
de registro no la deja como mensaje de texto en este chat.`;
```

with:

```ts
const AYUDA = `Notificador de notas UNI (INTRALU)

Comandos:
<b>/registrar</b> — registra o actualiza tu usuario de INTRALU (abre un formulario)
<b>/notas</b> — muestra todas tus notas registradas hasta ahora
<b>/ciclos</b> — consulta tus notas de un ciclo anterior
<b>/simular</b> — simula tu nota final de un curso con las evaluaciones que aún faltan
<b>/estado</b> — ve si estás activo y cuándo se revisó por última vez
<b>/baja</b> — borra tu registro y tu contraseña
<b>/ayuda</b> — este mensaje

🔒 Tu contraseña se guarda cifrada, nunca en texto plano. El formulario
de registro no la deja como mensaje de texto en este chat.`;
```

- [ ] **Step 2: Add `etiquetaPeriodo`, `answerCallbackQuery`, `dispararFetchHistorial`, and `manejarCallbackQuery`**

Insert after the existing `dispararChequeoInmediato` function (after its closing `}`, before `function botonRegistrar()`):

```ts
// AAAA + dígito de ciclo: 1 primer ciclo, 2 segundo ciclo, 3 verano
// (confirmado por un alumno real de la universidad). Un dígito desconocido
// cae a un formato genérico en vez de inventar un numeral que no existe.
const ROMANOS: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III' };
function etiquetaPeriodo(codper: string): string {
  const anio = codper.slice(0, 4);
  const digito = codper.slice(4);
  return ROMANOS[digito] ? `${anio}-${ROMANOS[digito]}` : `${anio} (ciclo ${digito})`;
}

// Responde el toque de un botón para que deje de girar en el cliente de
// Telegram — sin texto, no hace falta ningún aviso de "espera un momento".
async function answerCallbackQuery(callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// Dispara fetch-historial.yml (workflow aparte, revisa un solo período de
// un solo usuario) para consultar un ciclo pasado que todavía no está en
// `historial` — best-effort, mismo patrón que dispararChequeoInmediato.
async function dispararFetchHistorial(chatId: number, codper: string) {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows/fetch-historial.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { chat_id: String(chatId), codper } }),
      },
    );
    if (!res.ok) console.error('dispararFetchHistorial:', res.status, await res.text());
  } catch {
    // best-effort, no pasa nada si falla
  }
}

// deno-lint-ignore no-explicit-any
async function manejarCallbackQuery(callbackQuery: any) {
  await answerCallbackQuery(callbackQuery.id);

  const data = callbackQuery.data as string | undefined;
  if (!data || !data.startsWith('ciclo:')) return;

  const codper = data.slice('ciclo:'.length);
  const chatId = callbackQuery.from.id;

  const { data: usuario } = await supabase.from('usuarios').select('historial').eq('chat_id', chatId).maybeSingle();
  if (!usuario) return;

  const historial = (usuario.historial ?? {}) as Historial;
  const cursosDelPeriodo = historial[codper];

  if (cursosDelPeriodo) {
    const bloque = agruparPorCurso(cursosDelPeriodo);
    await sendMessage(
      chatId,
      bloque
        ? `📚 Tus notas del ciclo ${etiquetaPeriodo(codper)}:\n\n${bloque}`
        : `No encontré notas registradas en el ciclo ${etiquetaPeriodo(codper)}.`,
    );
  } else {
    await dispararFetchHistorial(chatId, codper);
  }
}
```

- [ ] **Step 3: Handle `callback_query` updates before the existing message handling**

Replace:

```ts
  const update = await req.json();
  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return new Response('ok');
  }
```

with:

```ts
  const update = await req.json();

  if (update.callback_query) {
    await manejarCallbackQuery(update.callback_query);
    return new Response('ok');
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return new Response('ok');
  }
```

- [ ] **Step 4: Add the `/ciclos` command**

Replace:

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
  } else if (text.startsWith('/simular')) {
```

with:

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
  } else if (text === '/ciclos') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const periodos = (data.periodos_disponibles ?? []) as string[];
      if (periodos.length === 0) {
        await sendMessage(
          chatId,
          'Todavía no tengo la lista de tus ciclos — espera al próximo chequeo (cada 5 min) e intenta de nuevo.',
        );
      } else {
        const botones = periodos.map((codper) => [{ text: etiquetaPeriodo(codper), callback_data: `ciclo:${codper}` }]);
        await sendMessage(chatId, '📚 Elige un ciclo para ver tus notas de ese período:', { inline_keyboard: botones });
      }
    }
  } else if (text.startsWith('/simular')) {
```

- [ ] **Step 5: Verify with Deno's type checker and linter**

```bash
cd "supabase/functions/telegram-webhook"
deno check --no-config index.ts
deno lint --no-config index.ts
```

Expected: both exit with no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "Agrega el comando /ciclos y el manejo de callback_query en el webhook"
```

## Context

This is Task 6 of an 8-task plan. `agruparPorCurso`, `supabase`, `sendMessage`, `botonRegistrar`, and `CursoMeta` already exist earlier in this same file — this task only adds new functions/types and two new branches (one in the command if/else chain, one before it for `callback_query`). This is the **first** button in this bot that isn't a Mini App (`web_app`) button — every existing button (`botonRegistrar`, `botonSimular`) opens a form; this one is a plain multiple-choice tap, so it uses `callback_data` + Telegram's `callback_query` update type, which this webhook has never had to handle before.

`manejarCallbackQuery` does its own fresh `supabase` lookup (not reusing any data from whenever `/ciclos` was first shown) — Telegram delivers the button tap as a **separate webhook call**, potentially much later, so there's no in-memory state to reuse from the original `/ciclos` invocation.

Work directly on the `main` branch.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Make all four edits exactly as specified, in order.
2. Run `deno check`/`deno lint`.
3. Commit with the exact message.
4. Self-review.
5. Report back.

## Before Reporting Back: Self-Review

- Does `update.callback_query` get checked and handled **before** the `update.message` check (so a callback-only update, which has no `message` field at the top level, doesn't fall through and get silently dropped by the `!message` early return)?
- Does `manejarCallbackQuery` call `answerCallbackQuery` unconditionally at the top (even if `data` doesn't start with `ciclo:`) so any future callback type doesn't leave a spinning button? (Per the spec: yes, answer first, then check the prefix.)
- Does the "already cached" branch read `historial[codper]` and pass it straight to the existing `agruparPorCurso` — same function `/notas` uses, no new formatting function?
- Does the "not cached" branch call `dispararFetchHistorial` and nothing else (no extra "please wait" message, per the approved design)?
- Do `deno check` and `deno lint` both pass clean?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Verification output
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 7: Documentación

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/GRADING-RULES.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `docs/ARCHITECTURE.md` — agregar el workflow/script nuevos y las columnas nuevas**

Replace:

```
.github/workflows/
  check-grade.yml               Corre check-all-users.js cada 5 min
  check-new-registration.yml     Corre check-all-users.js (SOLO_NUEVOS) al registrarse
  deploy-pages.yml               Publica public/ a GitHub Pages
```

with:

```
.github/workflows/
  check-grade.yml               Corre check-all-users.js cada 5 min
  check-new-registration.yml     Corre check-all-users.js (SOLO_NUEVOS) al registrarse
  fetch-historial.yml            Corre fetch-historial.js (un ciclo pasado bajo demanda, vía /ciclos)
  deploy-pages.yml               Publica public/ a GitHub Pages
```

Replace:

```
| `last_grades` | `jsonb` | Evaluaciones con fecha de registro — snapshot para detectar qué cambió entre corridas |
| `cursos` | `jsonb` | Fórmulas, promedios (ya calculados por INTRALU) y lista completa de evaluaciones (con y sin fecha) por curso — para `/simular` y `/notas` |
```

with:

```
| `last_grades` | `jsonb` | Evaluaciones con fecha de registro — snapshot para detectar qué cambió entre corridas |
| `cursos` | `jsonb` | Fórmulas, promedios (ya calculados por INTRALU) y lista completa de evaluaciones (con y sin fecha) del **ciclo actual** — para `/simular` y `/notas` |
| `periodos_disponibles` | `jsonb` | Lista de códigos de período del selector de INTRALU — poblada gratis durante el chequeo normal, la usa `/ciclos` para armar los botones |
| `historial` | `jsonb` | Caché permanente de ciclos pasados ya consultados por `/ciclos` (mismo formato que `cursos`, uno por `codper`) — nunca la toca el chequeo de 5 min |
```

- [ ] **Step 2: `docs/GRADING-RULES.md` — documentar `codper` por período**

Insert a new section right before `## Examen Sustitutorio (ES)`:

```markdown
## Períodos (`codper`) y ciclos pasados

`codper` tiene el formato `AAAA` + un dígito de ciclo: `1` primer
ciclo, `2` segundo ciclo, `3` verano (confirmado por un alumno real de
la universidad; existe la posibilidad no confirmada de un `0`, sin
significado asumido). El selector `#cb-periodos` de
`/informacion-academica/cursos` trae **todos** los períodos donde el
alumno tuvo actividad, no solo el actual — y `GET
/informacion-academica/cursos?codper=X` sí devuelve los cursos de un
período pasado (confirmado contra el sitio real). `fetchEvaluaciones`
ya recibía `codper` como parámetro desde el principio; solo hacía
falta que `fetchCursosMatriculados` también lo aceptara.

Etiqueta legible: año + número romano del ciclo (`2026-I`, `2026-II`,
`2026-III`) — nunca la palabra "Verano", por preferencia del
mantenedor. Un dígito desconocido cae a un formato genérico
(`2026 (ciclo 0)`) en vez de asumir un numeral que no existe.

```

- [ ] **Step 3: `CHANGELOG.md` — nueva entrada**

Replace:

```markdown
## [Sin publicar]

## [1.1.0] - 2026-07-16
```

with:

```markdown
## [Sin publicar]

### Added

- **`/ciclos`**: consulta las notas de un ciclo pasado bajo demanda, un
  período a la vez (nunca todos de golpe) — la primera vez que se pide
  un período dispara un login real (`fetch-historial.yml`, workflow
  aparte); una vez consultado, queda en caché permanente (`historial`)
  y las siguientes veces responde al toque.
- Primer uso de botones sin Mini App en el bot (`callback_query`) — los
  botones de `/ciclos` son una elección simple, no necesitan un
  formulario.

## [1.1.0] - 2026-07-16
```

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/GRADING-RULES.md CHANGELOG.md
git commit -m "Documenta /ciclos, periodos_disponibles/historial y el mecanismo de codper por período"
```

## Context

This is Task 7 of an 8-task plan — documentation only, no code changes. `docs/SCALING.md` doesn't need changes: this feature doesn't touch the 5-minute chain or its concurrency groups at all (Task 5's `fetch-historial.yml` has its own, differently-scoped concurrency group, already explained inline in that file's own comments).

Work directly on the `main` branch.

## Before You Begin

If anything is unclear, ask now.

## Your Job

1. Make all three doc edits exactly as specified.
2. Commit with the exact message.
3. Self-review.
4. Report back.

## Before Reporting Back: Self-Review

- Do all three files render as valid markdown (no broken tables, no unclosed code fences)?
- Is the commit message exact?

## Report Format

Report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Files changed
- Git commit SHA
- Self-review findings (if any)

---

### Task 8: Despliegue + migración manual + verificación end-to-end

**Files:** none (deployment/verification only)

- [ ] **Step 1: Remind the human maintainer to run the schema migration**

This must happen before deploying the updated Edge Function/workflows, since they now write to columns that don't exist yet on the live database. Tell the user to run this once in the Supabase SQL Editor (from Task 1's migration snippet):

```sql
alter table usuarios add column if not exists periodos_disponibles jsonb not null default '[]'::jsonb;
alter table usuarios add column if not exists historial jsonb not null default '{}'::jsonb;
```

Do not attempt to run this yourself against the production database — wait for the human to confirm it's done before proceeding to Step 3.

- [ ] **Step 2: Push everything to `main`**

```bash
git push origin main
```

This makes `fetch-historial.yml` dispatchable via the GitHub API and triggers `deploy-pages.yml` (harmless no-op here, since this plan doesn't touch `public/`).

- [ ] **Step 3: Redeploy `telegram-webhook`**

```bash
pnpm dlx supabase functions deploy telegram-webhook --no-verify-jwt
```

- [ ] **Step 4: Confirm GitHub recognizes the new workflow**

```bash
curl -s "https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const j = JSON.parse(d);
  for (const w of j.workflows) console.log(w.id, w.name, w.path, w.state);
});
"
```

Expected: a `Fetch historial` entry with `path: .github/workflows/fetch-historial.yml` and `state: active`.

- [ ] **Step 5: Wait for one real periodic check to populate `periodos_disponibles`**

Either wait for the next natural 5-minute chain run, or trigger `check-grade.yml` manually (Actions tab → Run workflow), then confirm the column populated for a real active user:

```bash
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data } = await supabase.from('usuarios').select('chat_id, periodos_disponibles').eq('active', true);
  for (const u of data) console.log(u.chat_id, (u.periodos_disponibles || []).length, 'período(s)');
})();
"
```

Expected: at least one active user shows a non-zero period count.

- [ ] **Step 6: Real end-to-end test in Telegram**

1. Send `/ciclos` to the bot. Confirm buttons appear, one per period, labeled like `2026-I`/`2025-II`/etc. (no checkmarks, per the approved design).
2. Tap a period you've never checked before. Confirm the button stops spinning quickly (no "please wait" text message), and a `📚 Tus notas del ciclo ...` message arrives within roughly the time a `check-new-registration.yml` run takes (well under a minute for one period, typically).
3. Send `/ciclos` again, tap the **same** period. Confirm the response is immediate this time (served from `historial`, no new Action run).
4. Confirm `/notas` and the 5-minute chain still behave exactly as before this plan (unaffected).

- [ ] **Step 7: Report final status to the user**

Summarize what's live, what was verified, and any residual manual step (none expected beyond the schema migration already done in Step 1).
