# Avisos de caída de INTRALU y transparencia de datos guardados

**Fecha:** 2026-07-17
**Estado:** Aprobado, pendiente de implementación

## Contexto

Cuando INTRALU (`alumnos.uni.edu.pe`, IP `190.105.247.141`) no responde
(`ECONNREFUSED`, típicamente por horas o días), `check-all-users.js` lo
trata igual que cualquier error no-credencial: lo loguea en la consola de
GitHub Actions y no le dice nada a nadie (`check-all-users.js` líneas
133-140). Esto rompe la promesa explícita que hace el mensaje de
confirmación de registro ("...te aviso aquí también" si algo falla) y dejó
al admin sin forma de enterarse de la caída salvo revisando logs a mano.

`fetch-historial.js` (el que respalda `/ciclos` para períodos no
cacheados) ya hace lo correcto — su `catch` no discrimina tipo de error y
siempre le avisa al usuario. La inconsistencia entre los dos archivos es
la causa raíz.

De paso, el brainstorming destapó dos huecos más: el cliente axios de
`lib/session.js` no tiene `timeout`, así que una conexión que se queda
colgada (a diferencia de un `ECONNREFUSED` limpio, que falla al toque)
podría trabar un lote entero sin límite de tiempo; y `/notas` no dice
cuándo se actualizaron los datos por última vez, aunque `/estado` sí.

## Alcance

**Dentro de esta spec:**
- Detectar errores de red (`ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/
  `ECONNRESET`/sin respuesta de axios) como categoría aparte de
  `CredentialError` y de "error desconocido".
- Avisar al admin (una vez por cambio de estado, no por cada usuario ni
  cada corrida) cuando INTRALU se cae y cuando se recupera.
- Avisar una vez al usuario recién registrado si su primer chequeo falla
  por red (no repetir en cada reintento de 5 min).
- Agregar `timeout` al cliente axios para evitar cuelgues indefinidos.
- Mientras INTRALU esté caído, encadenar la siguiente corrida de
  `check-grade.yml` en 60s en vez de 300s, para detectar la recuperación
  rápido sin necesitar un chequeo de salud aparte.
- Mostrar "Última actualización" en `/notas` (ya existe en `/estado`) y un
  aviso de "no en vivo" en la vista de un ciclo pasado cacheado.

**Fuera de alcance (decisión explícita durante el brainstorming):**
- Chequeo de salud dedicado antes de la tanda (opción A evaluada y
  descartada — ver "Alternativas consideradas"): el re-encadenado corto
  reusando el estado que ya se guarda logra lo mismo con menos código.
- Cambiar el paceo del cron cuando INTRALU está sano (el auto-encadenado
  ya se ajusta solo: espera el resto del ciclo de 5 min si el lote fue
  rápido, no espera nada si el lote ya usó los 5 min) — confirmado que el
  diseño actual es correcto, no es "tiempo muerto" por accidente sino
  paceo a propósito para no exponer logins repetidos hacia INTRALU sin
  necesidad.
- Notificar a usuarios ya "seeded" (no recién registrados) sobre caídas de
  red en sus chequeos periódicos — el aviso al admin ya cubre que alguien
  se entere y lo arregle; spamear a todos los usuarios activos cada vez
  que hay una caída de horas/días sería peor UX, no mejor.

## Diseño

### 1. Detección de error de red (`lib/session.js`)

Nueva función exportada junto a `CredentialError`:

```js
function isNetworkError(err) {
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(err.code)
    || (err.isAxiosError && !err.response); // axios sin respuesta = red/timeout, no HTTP
}
```

Y `timeout: 20000` en `newClient()` (línea 24), para que una conexión
colgada (a diferencia de un `ECONNREFUSED` que falla al instante) nunca
tarde más de 20s en fallar y liberar su slot de concurrencia.

### 2. Esquema nuevo (`supabase/schema.sql`, migración manual)

Tabla de una fila por servicio externo trackeado (hoy solo INTRALU, pero
con clave por nombre para no tener que rehacer esto si algún día se
trackea otro):

```sql
create table if not exists service_status (
  service text primary key,
  is_down boolean not null default false,
  since timestamptz,
  updated_at timestamptz not null default now()
);
insert into service_status (service) values ('intralu') on conflict do nothing;

alter table usuarios add column if not exists network_issue_notified boolean not null default false;
```

Igual que con `historial`/`periodos_disponibles`: esto se pega en el SQL
Editor de Supabase y lo corres tú a mano, no se ejecuta automáticamente.

### 3. Helper de estado (`lib/service-status.js`, nuevo)

Dos funciones con `UPDATE ... WHERE is_down = false/true` — el `WHERE`
hace que solo la llamada que "gana la carrera" (entre hasta 15 checks en
paralelo) reciba una fila de vuelta y dispare el aviso; el resto ve 0
filas afectadas y no hace nada:

```js
async function markIntraluDown(supabase, telegramToken, adminChatId) {
  const { data } = await supabase
    .from('service_status')
    .update({ is_down: true, since: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', false)
    .select();
  if (!data || data.length === 0) return false; // ya estaba marcado caído
  console.error('🔴 INTRALU no responde — marcado como caído.');
  if (adminChatId) {
    await sendTelegram(telegramToken, adminChatId, '🔴 INTRALU parece estar caído (no responde). Voy a avisar cuando se recupere.').catch(() => {});
  }
  return true;
}

async function markIntraluUp(supabase, telegramToken, adminChatId) {
  const { data } = await supabase
    .from('service_status')
    .update({ is_down: false, updated_at: new Date().toISOString() })
    .eq('service', 'intralu')
    .eq('is_down', true)
    .select();
  if (!data || data.length === 0) return;
  const since = data[0].since ? new Date(data[0].since) : null;
  const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
  const msg = `🟢 INTRALU volvió a responder${mins != null ? ` (estuvo caído ~${mins} min)` : ''}.`;
  console.log(msg);
  if (adminChatId) await sendTelegram(telegramToken, adminChatId, msg).catch(() => {});
}
```

`markIntraluDown` devuelve si el estado cambió en esta llamada — no hace
falta para el aviso en sí (ya deduplicado adentro), pero `main()` lo usa
para decidir el intervalo de re-encadenado (sección 5).

### 4. `check-all-users.js` — `checkUser()`

En el `catch` (líneas 133-156), agregar una rama antes de la lógica de
`CredentialError` existente:

```js
} catch (err) {
  if (isNetworkError(err)) {
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
    return; // igual que hoy: no toca updated_at, se reintenta el próximo ciclo
  }

  if (!(err instanceof CredentialError)) {
    // ... rama existente sin cambios (errores desconocidos, no de red ni credenciales)
  }
  // ... resto sin cambios
}
```

Y en el camino de éxito (después de la actualización de la línea 120-130),
resetear el flag y avisar si veníamos de una caída:

```js
await supabase.from('usuarios').update({ ..., network_issue_notified: false }).eq('id', id);
await markIntraluUp(supabase, telegramToken, process.env.ADMIN_CHAT_ID);
```

### 5. Re-encadenado corto mientras está caído (`check-grade.yml`)

`main()` en `check-all-users.js`, al final, escribe si el servicio quedó
marcado caído a `$GITHUB_OUTPUT` (leyendo `service_status` una vez, no
por usuario):

```js
const { data: status } = await supabase.from('service_status').select('is_down').eq('service', 'intralu').maybeSingle();
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `intralu_down=${status?.is_down ?? false}\n`);
}
```

El step "Run check-all-users" en `check-grade.yml` gana un `id:`, y el
step "Encadenar la siguiente corrida" calcula el objetivo de ciclo antes
de restar `elapsed`:

```yaml
- name: Run check-all-users
  id: check
  env: {...}
  run: pnpm run check-all

- name: Encadenar la siguiente corrida
  if: always()
  env:
    DISPATCH_TOKEN: ${{ secrets.WORKFLOW_DISPATCH_TOKEN }}
    INTRALU_DOWN: ${{ steps.check.outputs.intralu_down }}
  run: |
    ...
    ciclo=300
    if [ "$INTRALU_DOWN" = "true" ]; then ciclo=60; fi
    elapsed=$(( $(date +%s) - JOB_START ))
    sleep_for=$(( ciclo - elapsed ))
    ...
```

`check-new-registration.yml` no necesita este cambio — no se auto-encadena
(corre una vez por registro), así que no hay ritmo que acelerar ahí.

### 6. `ADMIN_CHAT_ID`

- `.env` local: `ADMIN_CHAT_ID=837156967` (valor real, no se commitea).
- `.env.example`: `ADMIN_CHAT_ID=` con comentario — *"Opcional. Tu chat_id
  de Telegram (ej. vía @userinfobot). Si lo pones, te avisa por Telegram
  cuando INTRALU se cae y cuando se recupera."*
- `check-grade.yml` y `check-new-registration.yml`: agregar
  `ADMIN_CHAT_ID: ${{ secrets.ADMIN_CHAT_ID }}` al `env:` del step que
  corre `check-all-users`. **Acción manual tuya**: crear el secret
  `ADMIN_CHAT_ID` = `837156967` en GitHub → Settings → Secrets and
  variables → Actions.

### 7. Transparencia de "datos guardados, no en vivo"

- `telegram-webhook/index.ts`, rama `/notas` (líneas 395-407): agregar
  `Última actualización: ${formatearFecha(data.updated_at)}` al final del
  bloque de notas, igual que ya hace `/estado` (línea 390).
- Vista de ciclo pasado cacheado (`manejarCallbackQuery`, líneas 178-186):
  agregar una línea fija `📌 Datos guardados de cuando se consultó este
  ciclo, no en vivo.` — sin timestamp puntual, porque `historial` no
  guarda una fecha por período y los ciclos pasados casi no cambian, así
  que un timestamp exacto no aportaría información real.

## Alternativas consideradas

**Chequeo de salud dedicado antes de la tanda** (evaluado durante el
brainstorming): un request liviano al inicio de `main()` decide si vale
la pena intentar con los usuarios de la tanda, saltándola entera si no.
Se descartó porque el error reportado (`ECONNREFUSED`) falla casi
instantáneo — el costo de igual intentar con ~135 usuarios cuando está
caído es de segundos, no minutos — y porque el re-encadenado corto
(sección 5) ya logra la detección rápida de recuperación sin un endpoint
de salud aparte ni lógica de "saltar la tanda". El `timeout` de axios
(sección 1) cierra el único escenario donde de verdad hubiera hecho falta
(un cuelgue en vez de un rechazo limpio).

## Testing

- `isNetworkError()`: casos con `code = 'ECONNREFUSED'`, con
  `isAxiosError: true` sin `response`, y con un error random (debe dar
  `false`) — ver si vale un test rápido en `lib/session.js` o alcanza con
  probarlo manual junto al resto (proyecto no tiene suite de tests hoy).
- `markIntraluDown`/`markIntraluUp`: probar en local contra la base real
  (ya existe `login-test.js` como precedente de diagnóstico manual) que
  dos llamadas concurrentes a `markIntraluDown` solo mandan un mensaje.
- Verificar a mano que `check-grade.yml` calcula bien `sleep_for` con
  `INTRALU_DOWN=true` (ciclo de 60s) y `false` (ciclo de 300s, comportamiento actual).
