# UI/UX: simulador, registro y mensajes del bot

**Fecha:** 2026-07-16
**Estado:** Aprobado, pendiente de implementación

## Contexto

El bot y las dos Mini Apps (`registro.html`, `simulador.html`) funcionan,
pero se armaron rápido y sin un pase dedicado de UI/UX. Esta sesión de
brainstorming cubrió tres frentes: agregar NSP/0A al simulador (pedido
original), pulir el formulario de registro, y mejorar los mensajes de
texto del bot — aplicando principios generales (escaneable, consistente,
con acción clara) en vez de solo "verse más bonito".

En el camino salió un bug real (no algo nuevo a diseñar): el simulador ya
trata mal las notas 0A registradas al usar `MIN(...)` para descartar la
más baja — las puede descartar cuando nunca debería poder pasar eso, una
nota anulada siempre tiene que contar.

## Alcance

**Dentro de esta spec:**
- Simulador: chips NSP/0A, fix del bug de `MIN(...)` con 0A, mostrar
  fórmulas y PP por separado, aviso (no bloqueo) si PP < 6.
- Registro: mostrar/ocultar contraseña, validación en vivo, bloquear
  campos durante el envío.
- Mensajes del bot: botón de registro faltante en el aviso de
  desactivación, reescritura del mensaje de confirmación de
  `/registrar`, chequeo inmediato al registrarse, primera revisión que
  manda las notas actuales en vez de guardarlas en silencio.

**Fuera de alcance (decisión explícita durante el brainstorming):**
- Regla dura de "PP ≥ 6 para rendir el examen" — no verificada contra
  INTRALU, se dejó como aviso informativo nada más.
- Excepción de "Sustitutorio reemplaza NSP aunque el PP no llegue a 6" —
  misma razón, no verificada.

## Diseño

### 1. Simulador (`public/simulador.html`, `supabase/functions/simular-datos/index.ts`)

**Chips NSP/0A** junto a cada evaluación pendiente (opción "A" del
mockup, la de menor cambio visual): el input numérico se mantiene tal
cual, y dos botones chicos `NSP` / `0A` al lado. Tocar uno fija esa fila
en modo "valor especial" (el input queda deshabilitado, no editable);
tocarlo de nuevo (deselecciona) o tocar el input vuelve a modo numérico.
Internamente ambos valores cuentan como `0` para el cálculo — igual que
ya hace `simular-datos` con las evaluaciones ya registradas (línea 99 de
ese archivo: `ev.anulada || ev.nota === null ? 0 : ev.nota`).

**Fix del bug de `MIN(...)` con 0A** — dos partes:

- `simular-datos/index.ts` hoy colapsa una anulada registrada a un `0`
  plano, sin marcar que viene de una anulación. Se agrega un campo
  `anuladas: string[]` a la respuesta JSON con los nombres de variable
  (`N1`, `N2`, ...) de las evaluaciones **ya registradas** que son 0A.
- `evaluarFormula` en `simulador.html` pasa a aceptar un tercer
  parámetro: `evaluarFormula(expr, vars, anuladas)`, donde `anuladas` es
  un `Set<string>`. El parseo de `MIN(...)` cambia: para cada argumento,
  si es una referencia directa a una variable (un solo token, no una
  subexpresión), se guarda su nombre junto a su valor. Al elegir el
  mínimo, se excluyen los argumentos cuyo nombre esté en `anuladas`
  (si **todos** los argumentos de un `MIN` están anulados, se usa el
  mínimo normal sobre todos — no queda otra opción sensata). El resto de
  la fórmula (la suma que rodea al `MIN`) no cambia — la anulada sigue
  sumando su `0` como cualquier variable.
- El set `anuladas` que se le pasa a `evaluarFormula` en cada cálculo es
  la unión de `data.anuladas` (las ya registradas) más las pendientes
  que el usuario marcó con el chip `0A` en esa sesión. Las marcadas
  `NSP` **no** entran a ese set — sí pueden ser la descartada por
  `MIN(...)`, tal como confirmaste.

**Mostrar fórmulas y desglose**: debajo del resultado (o donde quede más
legible sin estorbar), se muestra el texto crudo de `formulas.practicas`
y `formulas.teoria` tal como los devuelve INTRALU, y el resultado deja
de mostrar solo la nota final — también muestra el **PP** calculado por
separado, con su propio 🟢/🔴 según si llega a 10.

**Aviso de PP bajo**: si el curso tiene fórmula de prácticas y el `PP`
calculado da menos de 6, se muestra un texto de advertencia (no bloquea
nada, no cambia el cálculo):
> ⚠️ Promedio de Prácticas menor a 6 — revisa si puedes rendir el examen o necesitas Sustitutorio.

### 2. Formulario de registro (`public/registro.html`)

Cambios chicos, sin rediseño de layout:

- **Mostrar/ocultar contraseña**: ícono de ojito dentro del campo de
  contraseña, alterna `type="password"` / `type="text"`.
- **Validación en vivo**: el borde de cada input cambia de color
  (neutro → rojo/verde) según se va escribiendo, en vez de enterarte
  solo al tocar el botón de enviar.
- **Bloquear inputs durante el envío**: mientras está en curso el
  `fetch` a `registro-webapp`, los campos quedan `disabled` (hoy se
  puede seguir editando o volver a tocar "Registrarme" en ese momento).
- El texto de confianza existente ("tu contraseña se cifra...") se
  mantiene igual, solo se le antepone un ícono 🔒.

### 3. Mensajes del bot (`telegram-webhook/index.ts`, `check-all-users.js`)

**Gap — botón faltante**: el aviso de desactivación por 3 fallos de
login (en `checkUser()`, `check-all-users.js`) hoy solo dice "usa
/registrar" en texto. Se le agrega el mismo `botonRegistrar()`-equivalente
que ya usan otros mensajes (ese `sendTelegram` no soporta botones hoy —
ver nota de implementación abajo). Mismo tratamiento para `/estado`
cuando `active: false`: agregar el botón de registro ahí también, no
solo el texto.

**Chequeo inmediato al registrarse (opción B, la elegida)**: al terminar
el `upsert` exitoso en `/registrar`, el webhook dispara un
`workflow_dispatch` al mismo workflow `check-grade.yml`, usando el mismo
mecanismo que ya existe para la cadena de 5 min (`POST
.../actions/workflows/check-grade.yml/dispatches`). Es *best-effort*:
si falla (falta el secret, GitHub no responde, etc.), el registro igual
se guardó bien y la cadena normal de 5 min lo va a recoger de todas
formas — nunca bloquea ni rompe la respuesta al usuario.

- Necesita un secret nuevo en **Supabase** (no en GitHub — el webhook
  corre en Supabase Edge Functions): `GITHUB_DISPATCH_TOKEN`, mismo
  valor que ya generaste para `WORKFLOW_DISPATCH_TOKEN` en GitHub (el
  mismo fine-grained PAT sirve para ambos, ya está scopeado a
  `Actions: write` en este único repo).
- Como la corrida disparada entra al mismo `concurrency: group:
  check-grade, cancel-in-progress: false` que ya existe, no hay riesgo
  de corridas duplicadas ni de romper la cadena — ya se comprobó en
  producción que solo la corrida en cola más reciente sobrevive.

**Primera revisión manda las notas, no las guarda en silencio**: en
`checkUser()`, cuando `!seeded` (primera vez), hoy no se manda ningún
mensaje. Pasa a mandar un snapshot completo:
> 📋 Estas son tus notas actuales en INTRALU:
>
> *(mismo formato agrupado por curso que usa `/notas`)*
>
> Desde ahora te aviso cuando aparezca algo nuevo.

Si el usuario no tiene ninguna evaluación con fecha todavía, el mensaje
cambia a avisar eso en vez de mostrar una lista vacía.

**Mensaje de confirmación de `/registrar` reescrito** (sin el
paréntesis, sin la promesa vaga de "próximos minutos" ya que ahora el
chequeo es casi inmediato):
> ✅ Registrado con código **{codigo}**.
>
> Ya estoy revisando tus notas — te mando tu estado actual por acá en cuanto termine.
> Si tu código o contraseña están mal, te aviso aquí también.

## Notas de implementación

- `sendTelegram` en `check-all-users.js` hoy no soporta `reply_markup`
  (botones) — solo el de `telegram-webhook/index.ts` sí. Para agregar el
  botón de registro al aviso de desactivación hace falta extender la
  firma de `sendTelegram` en `check-all-users.js` para aceptar un
  teclado opcional, igual que ya hace `sendMessage` en el webhook.
- El nombre del repo/owner para el `workflow_dispatch` desde el webhook
  se hardcodea igual que en `check-grade.yml` (`Alexis0800/uni-notas-watcher`),
  no hace falta configurarlo aparte.
- No se toca `docs/GRADING-RULES.md` en esta spec — la regla de PP ≥ 6 y
  la excepción del Sustitutorio quedan fuera de alcance, sin
  documentarse como reglas confirmadas todavía.

## Testing

- `evaluarFormula` con `anuladas`: casos manuales — (a) sin anuladas,
  igual que hoy; (b) una anulada que sería el mínimo natural, confirmar
  que NO se descarta; (c) todas las variables de un `MIN` anuladas,
  confirmar que no explota (usa el mínimo normal como fallback).
- Probar el flujo de registro completo contra una cuenta real: que
  llegue el mensaje de confirmación, que llegue el snapshot de notas
  poco después, y que si se borra el secret `GITHUB_DISPATCH_TOKEN` el
  registro siga funcionando igual (solo más lento, vía la cadena de 5
  min).
- Verificar visualmente ambas Mini Apps en claro y oscuro (usan las
  variables de tema de Telegram, pero hay que confirmar que los chips
  nuevos y el ícono de ojito se ven bien en ambos).
