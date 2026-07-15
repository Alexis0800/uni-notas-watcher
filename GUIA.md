# Guía: Bot de Telegram multiusuario para notas UNI (INTRALU)

## Objetivo

Un bot de Telegram (**@OrceBotV2_bot**) al que **cualquier estudiante UNI**
le manda su código y contraseña de INTRALU, y a partir de ahí el bot le
avisa automáticamente cada vez que le sale una nota nueva (por evaluación:
Práctica 1, Examen Parcial, Examen Final, etc.), sin que nadie tenga que
entrar a revisar.

## Arquitectura

Esto ya no es un script de una sola persona — es un servicio con varios
usuarios registrando sus propias credenciales. Son **cuatro piezas**:

1. **Mini App de registro (`docs/registro.html`, GitHub Pages).**
   Un formulario de verdad (código + contraseña con campo oculto) que se
   abre *dentro* de Telegram al tocar el botón "📝 Registrarme" — la
   contraseña nunca se escribe como mensaje de texto en el chat. Supabase
   Edge Functions no puede servir HTML en el plan gratis (lo reescribe a
   texto plano y bloquea el JS con un CSP), por eso la página vive en
   GitHub Pages y solo le pega a la API por `fetch`.
2. **Bot de Telegram (webhook) → Supabase Edge Function.**
   `supabase/functions/telegram-webhook` recibe los comandos
   (`/registrar`, `/notas`, `/estado`, `/baja`, `/ayuda`). El registro por
   texto (`/registrar CODIGO CONTRASEÑA`) también sigue funcionando como
   alternativa. `supabase/functions/registro-webapp` es la API que llama
   la Mini App — valida que el mensaje realmente venga de Telegram
   verificando la firma HMAC del `initData` antes de guardar nada.
3. **Base de datos (Supabase Postgres).** Una tabla `usuarios` con
   `chat_id`, `codigo_uni`, `password_encrypted` (cifrada, nunca en texto
   plano) y `last_grades` (notas por evaluación de cada uno, con curso,
   descripción, nota y fecha de registro).
4. **Chequeo periódico (GitHub Actions, cada 5 min, repo público).**
   `check-all-users.js` lee todos los usuarios activos de Supabase,
   descifra su contraseña **en memoria**, hace login real a INTRALU,
   compara sus notas por evaluación (solo las que ya tienen fecha de
   registro) y notifica por Telegram — agrupado por curso, no una línea
   plana por evaluación.

```
Mini App (GitHub Pages) ──┐
                           ├─→ Edge Functions (Supabase) → guarda credencial cifrada
Texto "/registrar" ────────┘
                                        ↓
GitHub Actions (cada 5 min) → lee usuarios de Supabase → login INTRALU
                                → compara notas → Telegram al usuario
```

## Seguridad — qué implica guardar contraseñas de otras personas

Esto es una responsabilidad real, no solo un detalle técnico:

- **Cifrado en reposo**: las contraseñas se guardan cifradas con
  AES-256-GCM usando una llave maestra (`CREDENTIALS_ENCRYPTION_KEY`) que
  **nunca** está en la base de datos — vive solo como secreto de GitHub
  Actions y de Supabase. Probé el cifrado (roundtrip, rechazo con llave
  incorrecta) y la interoperabilidad Deno↔Node — funciona.
- **RLS activado sin policies** en la tabla `usuarios`: nadie puede leer
  esa tabla con la llave pública (`anon key`), solo el `service_role key`
  (que solo tienen la Edge Function y GitHub Actions, nunca el repo
  público ni el cliente).
- **Webhook protegido**: Telegram manda un header secreto
  (`X-Telegram-Bot-Api-Secret-Token`) que la función valida antes de
  procesar nada, para que nadie más pueda mandarle datos falsos.
- **Mini App protegida**: `registro-webapp` valida la firma HMAC-SHA256
  del `initData` que manda Telegram (algoritmo oficial de Telegram Web
  Apps) antes de guardar nada, así nadie puede pegarle directo a la API
  simulando ser otro chat_id. Probado con un `initData` firmado en Node y
  verificado en Deno, y con un hash corrompido para confirmar el rechazo.
- **Aun así**: si algún día se filtra `CREDENTIALS_ENCRYPTION_KEY` *y* la
  base de datos, alguien podría descifrar las contraseñas de todos los
  usuarios registrados. No hay forma de eliminar ese riesgo del todo — la
  mitigación es no compartir esa llave con nadie, no ponerla en ningún
  lado público, y avisar a los usuarios si algo así llegara a pasar.
- El bot menciona en `/ayuda` que la contraseña se guarda cifrada, sin
  detallar el método ni la arquitectura — esos detalles quedan solo en
  este documento, no en algo que vea un usuario cualquiera.

## Estado actual — en producción ✅

Proyecto de Supabase: **Uni Watcher** (`dfitaqdfkcxeroisjeic`). Repo:
[github.com/Alexis0800/uni-notas-watcher](https://github.com/Alexis0800/uni-notas-watcher).

| Pieza | Estado |
|---|---|
| `lib/session.js` | ✅ Login a INTRALU + notas por evaluación (con fecha de registro), probado contra el sitio real |
| `lib/crypto.js` | ✅ Cifrado AES-256-GCM, roundtrip + rechazo de llave incorrecta + interoperabilidad Deno↔Node verificados |
| Tabla `usuarios` (Supabase) | ✅ Creada, con RLS y la columna `seeded` |
| Edge Function `telegram-webhook` | ✅ Desplegada — comandos, menú nativo, botón de registro |
| Edge Function `registro-webapp` | ✅ Desplegada — valida `initData` (HMAC-SHA256) verificado con un test cruzado Node↔Deno, probado de punta a punta con un registro real |
| `docs/registro.html` (GitHub Pages) | ✅ En línea, formulario probado en vivo desde Telegram |
| Webhook + menú de comandos de Telegram | ✅ Conectados (`setWebhook`, `setMyCommands`) |
| `.github/workflows/check-grade.yml` | ✅ Corriendo cada 5 min en GitHub Actions (Node 22) |

**Bugs que aparecieron al probar en producción y ya están corregidos:**
- El primer chequeo tras `/registrar` notificaba todas las notas ya
  existentes como "nuevas" (comparaba contra un estado vacío). Se agregó
  la columna `seeded`: el primer chequeo solo guarda el estado base en
  silencio, recién desde el segundo avisa de cambios reales.
- El workflow estaba fijado a Node 20, pero `@supabase/supabase-js`
  necesita WebSocket nativo (Node 22+). Subido a Node 22.
- El secret `SUPABASE_URL` en GitHub tenía el sufijo `/rest/v1/` de más,
  duplicando la ruta y tirando "Invalid path specified in request URL".
  Corregido a la URL base.
- Supabase Edge Functions no sirve HTML en el plan gratis (lo reescribe a
  texto plano y bloquea el JS con CSP). La página de registro se movió a
  GitHub Pages; la función de Supabase quedó como API JSON con CORS.

### Registro

Tu propio usuario ya está registrado y probado de punta a punta,
incluyendo el formulario nuevo. Cualquier otra persona solo necesita
escribirle a **@OrceBotV2_bot** y tocar "📝 Registrarme".

## Comandos del bot

Aparecen en el menú nativo de Telegram (botón "/" junto al cuadro de texto):

- `/registrar` — abre el formulario de registro (o `/registrar CODIGO CONTRASEÑA` como alternativa por texto)
- `/notas` — todas tus notas registradas, agrupadas por curso
- `/estado` — si estás activo y cuándo se revisó por última vez
- `/baja` — borra tu registro y tu contraseña
- `/ayuda` — lista de comandos
