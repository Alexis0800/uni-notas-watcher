# Guía: Bot de Telegram multiusuario para notas UNI (INTRALU)

## Objetivo

Un bot de Telegram (**@OrceBotV2_bot**) al que **cualquier estudiante UNI**
le manda su código y contraseña de INTRALU, y a partir de ahí el bot le
avisa automáticamente cada vez que le sale una nota nueva (por evaluación:
Práctica 1, Examen Parcial, Examen Final, etc.), muestra todas sus notas
agrupadas por curso, y puede simular con cuánto aprobaría cada curso —
sin que nadie tenga que entrar a revisar INTRALU a mano.

## Arquitectura

Son **seis piezas**:

1. **Mini App de registro (`docs/registro.html`, GitHub Pages).**
   Formulario real (código + contraseña con campo oculto) que se abre
   *dentro* de Telegram al tocar "📝 Registrarme" — la contraseña nunca
   se escribe como mensaje de texto en el chat.
2. **Mini App del simulador (`docs/simulador.html`, GitHub Pages).**
   Por curso: muestra las notas ya registradas (fijas) y un campo
   editable por cada evaluación que falte, calcula la nota final en vivo
   con la fórmula real de INTRALU (soporta `MIN(...)`, pesos como
   `2.EF`). Si el Examen Sustitutorio sigue disponible, lo ofrece aparte
   y calcula automáticamente si conviene más reemplazar el Parcial o el
   Final (comparando el resultado real, no la nota más baja — importa
   cuando una evaluación pesa más que otra).
3. **Bot de Telegram (webhook) → Supabase Edge Function
   (`telegram-webhook`).** Comandos: `/registrar`, `/notas`, `/simular`,
   `/estado`, `/baja`, `/ayuda`. Menú nativo configurado con
   `setMyCommands` + `setChatMenuButton`.
4. **APIs de las Mini Apps (`registro-webapp`, `simular-datos`).**
   Ambas verifican la firma HMAC-SHA256 del `initData` que manda
   Telegram antes de tocar la base de datos — así se confirma que el
   chat_id es real sin depender de que el request venga del webhook.
5. **Base de datos (Supabase Postgres).** Tabla `usuarios`:
   `password_encrypted` (cifrada, nunca en texto plano), `last_grades`
   (evaluaciones con fecha registrada, para notificar y `/notas`),
   `cursos` (fórmulas, promedios y la lista completa de evaluaciones —
   con y sin fecha — de cada curso, para el simulador).
6. **Chequeo periódico (GitHub Actions, cada 5 min, repo público).**
   `check-all-users.js` recorre usuarios activos, hace login real a
   INTRALU, actualiza `last_grades` y `cursos`, notifica por Telegram
   agrupado por curso con 🟢/🔴 (Telegram no soporta color de texto en
   mensajes, es lo más parecido).

```
Mini App registro / /registrar ─┐
Mini App simulador ─────────────┼─→ Edge Functions (Supabase, verifican initData/webhook secret)
Comandos de texto ──────────────┘         ↓
                                   Postgres (password cifrada, notas, fórmulas)
                                           ↓
GitHub Actions (cada 5 min) → login INTRALU → compara notas → Telegram
```

## Cómo se leen las notas — reglas que importan

- **Solo cuentan evaluaciones con fecha de registro** para `/notas` y las
  notificaciones — evita ruido de casilleros que nunca se van a usar
  (ej. "Examen Sustitutorio" para quien no lo necesita).
- **NSP** ("No Se Presentó"): evaluación con fecha registrada pero sin
  nota. **0A**: anulada (copia/falta grave, campo `flgnot` de INTRALU).
  Ambas se muestran así en vez de esconderlas u omitirlas.
- **El simulador usa las fórmulas como fuente de verdad, no la lista de
  evaluaciones**: a veces INTRALU menciona una variable en la fórmula
  (ej. `N1`) pero todavía ni crea el casillero de esa práctica. Esas
  variables igual se ofrecen como editables (con el código de la
  variable como nombre, ya que no hay descripción real todavía).
- **El Examen Sustitutorio no aparece en ninguna fórmula** — es una
  regla aparte de INTRALU (reemplaza tu peor nota entre Parcial y
  Final). El simulador lo detecta por separado y ofrece el curso para
  simular aunque el resto ya esté completo.

## Seguridad — qué implica guardar contraseñas de otras personas

- **Cifrado en reposo**: AES-256-GCM con una llave maestra
  (`CREDENTIALS_ENCRYPTION_KEY`) que nunca está en la base de datos —
  solo como secreto de GitHub Actions y de Supabase. Interoperabilidad
  Deno↔Node verificada.
- **RLS activado sin policies** en `usuarios`: solo el `service_role
  key` (Edge Functions + GitHub Actions) puede leer/escribir, nunca el
  repo público ni el cliente.
- **Webhook protegido** con un header secreto que Telegram manda y la
  función valida antes de procesar nada.
- **Mini Apps protegidas**: cada API valida la firma HMAC-SHA256 del
  `initData` (algoritmo oficial de Telegram) antes de tocar la base de
  datos. Probado con un `initData` firmado en Node y verificado en
  Deno, y con un hash corrompido para confirmar el rechazo.
- **Sin datos personales en el repo público**: en el camino se filtró
  el código de estudiante del autor (nunca la contraseña) en `GUIA.md`
  y en un placeholder de `docs/registro.html`. Se corrigió y se
  reescribió el historial de git (`force-push`) para sacarlo de commits
  viejos también.
- **Aun así**: si algún día se filtra `CREDENTIALS_ENCRYPTION_KEY` *y*
  la base de datos, alguien podría descifrar las contraseñas de todos
  los usuarios registrados. La mitigación es no compartir esa llave con
  nadie ni ponerla en ningún lado público.
- `/ayuda` solo dice que la contraseña se guarda cifrada, sin detallar
  método ni arquitectura — esos detalles quedan en este documento.

## Estado actual — en producción ✅

Proyecto de Supabase: **Uni Watcher** (`dfitaqdfkcxeroisjeic`). Repo:
[github.com/Alexis0800/uni-notas-watcher](https://github.com/Alexis0800/uni-notas-watcher).

| Pieza | Estado |
|---|---|
| `lib/session.js` | ✅ Login, notas por evaluación (con fecha, `flgnot`, fórmulas y promedios) |
| `lib/crypto.js` | ✅ Cifrado AES-256-GCM probado y verificado Deno↔Node |
| Tabla `usuarios` | ✅ `last_grades`, `cursos`, `seeded`, RLS activo |
| Edge Function `telegram-webhook` | ✅ Todos los comandos, menú nativo, botones de Mini App |
| Edge Function `registro-webapp` | ✅ initData verificado, probado con registro real |
| Edge Function `simular-datos` | ✅ Variables por fórmula, casos sin registro real y Sustitutorio probados |
| `docs/registro.html` / `docs/simulador.html` (GitHub Pages) | ✅ En línea, probados en vivo desde Telegram |
| `.github/workflows/check-grade.yml` | ✅ Cada 5 min, Node 22 |

**Bugs reales encontrados al probar en producción (todos corregidos):**
notificación falsa al registrarse (columna `seeded`) · Node 20 vs
WebSocket nativo de `@supabase/supabase-js` · `SUPABASE_URL` con sufijo
de más · Supabase Edge Functions no sirve HTML (movido a GitHub Pages) ·
código personal expuesto (historial reescrito) · variables de fórmula
que desaparecían si INTRALU no había creado el casillero todavía ·
cursos con Sustitutorio pendiente que no aparecían como simulables.

## Comandos del bot

- `/registrar` — abre el formulario de registro (o `/registrar CODIGO CONTRASEÑA` por texto)
- `/notas` — todas tus notas registradas, agrupadas por curso, con 🟢/🔴
- `/simular` — elige un curso y simula tu nota final con lo que falta
- `/estado` — si estás activo y cuándo se revisó por última vez
- `/baja` — borra tu registro y tu contraseña
- `/ayuda` — lista de comandos
