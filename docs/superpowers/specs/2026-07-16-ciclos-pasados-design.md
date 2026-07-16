# Consultar ciclos pasados + PP por curso

**Fecha:** 2026-07-16
**Estado:** Aprobado, pendiente de implementación

## Contexto

`check-all-users.js` y `telegram-webhook` solo conocían el período
"actual" de INTRALU (el que aparece seleccionado por defecto). Se
confirmó contra el sitio real (con la cuenta de prueba, sin guardar
nada) que:

- La página de cursos trae un selector `#cb-periodos` con **todos** los
  períodos donde el alumno tuvo actividad (21 en la cuenta de prueba,
  desde 2018).
- `GET /informacion-academica/cursos?codper=X` sí devuelve los cursos
  de un período pasado — el sitio ya soporta esto, nadie lo estaba
  usando.
- `fetchEvaluaciones` (`lib/session.js`) **ya recibe `codper` como
  parámetro** — no hace falta tocar esa función para pedir notas de un
  período específico.

Formato de `codper`: `AAAA` + un dígito de ciclo — `1` primer ciclo,
`2` segundo ciclo, `3` verano (confirmado por el usuario, que es
alumno real de la universidad). Existe la posibilidad no confirmada de
que aparezca un `0`; no se le asume un significado.

De paso, se pidió mostrar el **PP (promedio de prácticas)** junto al
promedio del curso en `/notas` — esto ya se implementó por separado
(commit `ede3ac5`), no es parte de este spec.

## Objetivo

Permitir consultar las notas de un ciclo pasado bajo demanda, sin
afectar en nada el comportamiento del ciclo actual (que sigue siendo lo
único que se revisa cada 5 min y lo único que dispara notificaciones).

## Alcance

**Dentro:**
- Nueva columna `periodos_disponibles` (lista de períodos conocidos,
  poblada gratis durante el chequeo normal del ciclo actual).
- Nueva columna `historial` (caché permanente de períodos ya
  consultados, uno a la vez, bajo demanda).
- Comando `/ciclos`: botones por período, sin marcar cuáles ya se
  consultaron (eso queda interno).
- Workflow nuevo (`fetch-historial.yml`) + script nuevo
  (`fetch-historial.js`) que hacen el login real y traen **un solo
  período** cuando el usuario lo pide — nunca todos de una vez (evita
  una ráfaga de decenas de requests contra INTRALU).
- Soporte de `callback_query` en el webhook (hoy no existe — todos los
  botones actuales son `web_app`, ninguno usa `callback_data`).
- Extracción de `sendTelegram`/`emoji`/`emojiValor`/`agruparPorCurso` a
  un módulo compartido (`lib/notificaciones.js`) para que
  `check-all-users.js` y `fetch-historial.js` no dupliquen esa lógica
  — ambos son Node, comparten módulo sin problema (a diferencia de la
  duplicación Node/Deno, que sí tiene una razón técnica real).

**Fuera:**
- Traer todo el historial de una — siempre un período a la vez.
- Marcar visualmente en `/ciclos` cuáles ya se consultaron.
- Cualquier mensaje intermedio tipo "dame un momento" — solo se
  responde el toque del botón (para que deje de girar) y, si hace
  falta el Action, el próximo mensaje que llega es directamente el
  resultado.
- Refrescar un período ya guardado en `historial` — se asume
  permanente (las notas de un ciclo cerrado no cambian).

## Diseño

### 1. Esquema (`supabase/schema.sql` + migración manual)

```sql
alter table usuarios add column if not exists periodos_disponibles jsonb not null default '[]'::jsonb;
alter table usuarios add column if not exists historial jsonb not null default '{}'::jsonb;
```

Se agrega también a la sentencia `create table` de `schema.sql` (para
instalaciones nuevas) y se documenta la migración de arriba para
correrla una vez en el SQL Editor de Supabase de la instancia ya
desplegada — **acción manual del usuario**, no algo que el agente deba
ejecutar directo contra la base de producción.

`historial` shape: `{ [codper]: { [cursoKey]: CursoMeta } }` — mismo
formato que ya usa `cursos` hoy para el período actual.

### 2. `lib/session.js`: `fetchCursosMatriculados` acepta un período opcional

```js
async function fetchCursosMatriculados(client, codper) {
  const url = codper
    ? `${BASE_URL}/informacion-academica/cursos?codper=${codper}`
    : `${BASE_URL}/informacion-academica/cursos`;
  const res = await client.get(url);
  const $ = cheerio.load(res.data);

  const csrfToken = $('meta[name="csrf-token"]').attr('content');
  const codperActual = $('#cb-periodos option[selected]').attr('value');
  const periodos = $('#cb-periodos option').map((_, o) => $(o).attr('value')).get();

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

Cambios sobre la versión actual: acepta `codper` opcional (si se pasa,
pide ese período por query string; si no, comportamiento idéntico a
hoy), y ahora también devuelve `periodos` (la lista completa del
selector) — **sin costo extra**, es la misma respuesta HTTP que ya se
pedía. `check-all-users.js` (llamada sin `codper`, ciclo actual) puede
ignorar o usar ese campo nuevo sin que cambie nada de su
comportamiento existente.

### 3. `lib/notificaciones.js` (nuevo, compartido entre scripts Node)

Extrae de `check-all-users.js`, sin cambiar su lógica:
`sendTelegram`, `emoji`, `emojiValor`, `agruparPorCurso`. Se agrega
`etiquetaPeriodo`:

```js
const ROMANOS = { '1': 'I', '2': 'II', '3': 'III' };
function etiquetaPeriodo(codper) {
  const anio = codper.slice(0, 4);
  const digito = codper.slice(4);
  return ROMANOS[digito] ? `${anio}-${ROMANOS[digito]}` : `${anio} (ciclo ${digito})`;
}
```

`check-all-users.js` pasa a importar estas funciones en vez de
definirlas inline.

### 4. `check-all-users.js`: guardar `periodos_disponibles`

En `checkUser()`, tras `fetchCursosMatriculados(client)` (sin
`codper` — sigue siendo el ciclo actual), se agrega `periodos` al
mismo `.update(...)` que ya escribe `cursos`/`last_grades`:

```js
.update({
  last_grades: currentMap,
  cursos: cursosMeta,
  periodos_disponibles: periodos,
  seeded: true,
  consecutive_failures: 0,
  updated_at: new Date().toISOString(),
})
```

### 5. `fetch-historial.js` (nuevo script)

Toma `CHAT_ID` y `CODPER` por variable de entorno. Busca al usuario,
descifra su contraseña, hace login, pide **solo ese período**
(`fetchCursosMatriculados(client, CODPER)` + `fetchEvaluaciones` por
curso), guarda el resultado en `historial[CODPER]` (merge, no pisa
otros períodos ya guardados), y manda el resultado por Telegram con el
mismo formato que `/notas` (`agruparPorCurso`), encabezado con
`📚 Tus notas del ciclo {etiquetaPeriodo(CODPER)}:`.

Si falla (login, INTRALU caído, etc.), manda un mensaje de error al
chat en vez de fallar en silencio — el usuario está esperando una
respuesta a algo que pidió activamente.

**Límite conocido, aceptado a propósito**: si el mismo usuario pide dos
períodos *distintos* casi al mismo tiempo, hay una ventana angosta de
"leer-modificar-escribir" sobre la columna `historial` donde uno podría
pisar al otro (mismo tipo de condición que ya existe hoy con
`consecutive_failures` en `checkUser()` — no es nuevo en este proyecto,
no se agrega coordinación extra para cerrarla). Pedir el **mismo**
período dos veces seguido sí está cubierto por el `concurrency group`
del workflow (ver abajo).

### 6. `.github/workflows/fetch-historial.yml` (nuevo)

```yaml
name: Fetch historial

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
        run: node fetch-historial.js
```

`concurrency group` scopeado a `(chat_id, codper)`, no a todo el
workflow — a diferencia de `check-grade.yml`/`check-new-registration.yml`
(que procesan lotes y necesitan serializarse entre sí), acá dos
usuarios distintos pidiendo períodos distintos pueden correr en
paralelo sin problema; solo se evita que el **mismo** usuario dispare
dos veces la **misma** consulta encimada (`cancel-in-progress: true`:
si duplica el toque, se cancela la vieja y gana la nueva).

### 7. `telegram-webhook/index.ts`: comando `/ciclos` + `callback_query`

- `etiquetaPeriodo` (misma lógica que en Node, copia — Deno no puede
  importar el módulo de Node).
- `dispararFetchHistorial(chatId, codper)`: mismo patrón que
  `dispararChequeoInmediato`, pero apunta a
  `fetch-historial.yml/dispatches` con
  `body: JSON.stringify({ ref: 'main', inputs: { chat_id: String(chatId), codper } })`.
- `answerCallbackQuery(callbackQueryId)`: nuevo helper, POST a
  `.../answerCallbackQuery` con `{ callback_query_id }` — sin `text`,
  solo para que el botón deje de girar (sin mensaje de "espera").
- `/ciclos`: lee `data.periodos_disponibles`, arma un botón por período
  (`callback_data: 'ciclo:' + codper`, texto = `etiquetaPeriodo(codper)`,
  sin distinguir ya-consultados). Si la lista está vacía, avisa que
  todavía no hay períodos conocidos (pasa antes del primer chequeo
  completo).
- `Deno.serve`: además de `update.message`, ahora también revisa
  `update.callback_query`. Si `data` empieza con `ciclo:`, extrae el
  `codper`, responde el callback (`answerCallbackQuery`) y:
  - Si `historial[codper]` ya existe: arma el mensaje con
    `agruparPorCurso` sobre ese período y lo manda de una.
  - Si no: dispara `fetch-historial.yml` — el resultado llega después,
    por Telegram, desde el propio script.

### 8. Documentación

- `docs/ARCHITECTURE.md`: agregar `fetch-historial.yml`/`fetch-historial.js`
  a la lista de piezas/archivos, y las dos columnas nuevas a la tabla
  del esquema.
- `docs/GRADING-RULES.md`: documentar el mecanismo de `codper` por
  período (lo que se confirmó contra el sitio real) y la convención
  año-número romano.
- `CHANGELOG.md`: nueva entrada en `[Sin publicar]`.

## Notas de implementación

- El evaluador de fórmulas sigue sin tocarse — el historial se muestra
  igual que `/notas` (valores ya calculados por INTRALU, nunca
  recalculados).
- No se agrega forma de "refrescar" un período ya guardado — si hiciera
  falta más adelante, sería un comando aparte (`/ciclos actualizar
  20252` o similar), no parte de este spec.
- El botón de `/ciclos` no usa Mini App (`web_app`) — es la primera vez
  que este bot usa `callback_data` en vez de eso, porque no hace falta
  ningún formulario, solo elegir una opción.

## Testing

- `fetchCursosMatriculados(client, codper)` con un período pasado real
  (ya probado manualmente contra el sitio, ver Contexto) — confirmar
  que el script nuevo trae los mismos cursos que se vieron en la
  exploración.
- `etiquetaPeriodo`: casos `20261`→`2026-I`, `20262`→`2026-II`,
  `20263`→`2026-III`, y un dígito desconocido (ej. `20260`) → formato
  genérico, sin asumir nada.
- Probar `/ciclos` de punta a punta con la cuenta real: un período
  nunca antes consultado (dispara el workflow, llega el mensaje
  después) y el mismo período de nuevo (respuesta inmediata desde
  `historial`).
- Confirmar que `check-grade.yml`/`check-all-users.js` sin
  `SOLO_NUEVOS` y sin tocar `fetch-historial.js` siguen funcionando
  exactamente igual que antes de este cambio (la extracción a
  `lib/notificaciones.js` no debe alterar ningún mensaje existente).
