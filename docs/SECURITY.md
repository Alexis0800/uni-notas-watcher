# Seguridad

Este proyecto guarda credenciales de INTRALU (código + contraseña) de
terceros — cualquier estudiante que se registre. Eso es una
responsabilidad real, no solo un detalle técnico. Este documento explica
qué protecciones hay, cómo se probaron, y qué riesgos quedan de todas
formas.

## Reportar una vulnerabilidad

Si encontraste un problema de seguridad, no abras un issue público.
Contacta directamente a [@Alexis0800](https://github.com/Alexis0800) por
GitHub.

## Modelo de amenazas

| Actor | Qué podría intentar | Mitigación |
|---|---|---|
| Alguien en internet | Mandar requests falsos al webhook de Telegram | Header secreto (`X-Telegram-Bot-Api-Secret-Token`) validado antes de procesar nada |
| Alguien en internet | Pegarle directo a la API de las Mini Apps simulando ser otro usuario | Verificación HMAC-SHA256 del `initData` que firma Telegram — sin el bot token no se puede forjar |
| Alguien con acceso de lectura al repo público | Encontrar credenciales o llaves en el código | Ninguna credencial real vive en el repo — todo son Secrets de GitHub/Supabase, verificado antes de cada commit |
| Alguien con acceso a la base de datos (ej. `anon key` filtrada) | Leer contraseñas de usuarios | RLS activado sin policies: el `anon key` no tiene ningún acceso a la tabla `usuarios` |
| Alguien con acceso a la base de datos completa (`service_role key`) | Leer contraseñas | Están cifradas (AES-256-GCM), no en texto plano — necesitaría además `CREDENTIALS_ENCRYPTION_KEY` |
| El propio mantenedor (por error) | Filtrar un secreto sin querer | Ver [incidentes ya ocurridos](#incidentes-reales-durante-el-desarrollo) abajo — pasó, y así se corrigió |

## Cifrado de credenciales

Las contraseñas se cifran con **AES-256-GCM** (autenticado, no solo
confidencial — un tag inválido hace que el descifrado falle en vez de
devolver basura silenciosamente) usando `crypto.subtle` (Web Crypto),
disponible como global tanto en Node 20+ como en Deno sin imports.

- La llave maestra (`CREDENTIALS_ENCRYPTION_KEY`, 32 bytes al azar en
  base64) **nunca** se guarda en la base de datos — vive solo como
  secreto de GitHub Actions y de Supabase Edge Functions.
- `lib/crypto.js` (Node) y `supabase/functions/*/crypto.ts` (Deno) son
  el mismo esquema implementado dos veces (ver
  [`ARCHITECTURE.md`](ARCHITECTURE.md#por-qué-hay-código-duplicado-entre-node-y-deno)).
  Se verificó que son interoperables: un valor cifrado en Deno se
  descifra correctamente en Node y viceversa.
- Se probó el rechazo con llave incorrecta (el `AEAD` de GCM lo detecta
  y lanza error, no da un resultado corrupto silencioso).

## Control de acceso a la base de datos

RLS (Row Level Security) está activado en la tabla `usuarios` **sin
ninguna policy definida**. En Postgres/Supabase eso significa: nadie
puede leer ni escribir esa tabla usando el `anon key` (la llave pública
que sí podría terminar expuesta en un cliente). Solo el `service_role
key` — que ignora RLS por diseño de Supabase, y que solo tienen las
Edge Functions y el workflow de GitHub Actions — puede tocarla.

## Autenticación del webhook de Telegram

Telegram permite configurar un `secret_token` al llamar a `setWebhook`.
Cada request entrante trae ese valor en el header
`X-Telegram-Bot-Api-Secret-Token`; la función lo compara antes de leer
el cuerpo del mensaje. Sin el valor correcto, la función responde `401`
sin procesar nada.

## Autenticación de las Mini Apps (`initData`)

Las Mini Apps (`registro-webapp`, `simular-datos`) corren en un
navegador dentro de Telegram — no hay sesión de servidor. Telegram le
pasa a la página un `initData`: una cadena firmada con **HMAC-SHA256**
usando el token del bot, que incluye el `id` real del usuario de
Telegram. El [algoritmo de verificación es el oficial de Telegram](https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app):

1. Se separa el campo `hash` del resto de los datos.
2. Se arma un `data_check_string` con el resto de los campos, ordenados
   alfabéticamente y unidos con `\n`.
3. `secret_key = HMAC_SHA256(clave="WebAppData", datos=bot_token)`
4. `hash_calculado = HMAC_SHA256(clave=secret_key, datos=data_check_string)`
5. Se compara `hash_calculado` contra el `hash` recibido.

Sin conocer el token del bot, nadie puede forjar un `initData` válido —
así que el `chat_id` que llega a la API es confiable sin necesitar una
sesión de servidor tradicional. También se rechaza `initData` con más
de 1 hora de antigüedad (`auth_date`), para acotar el riesgo de reuso
si un `initData` viejo se filtrara por otro medio.

**Cómo se probó:** se firmó un `initData` de prueba con Node (usando el
token real, sin imprimirlo) y se verificó que la función en Deno lo
aceptara y extrajera el `chat_id` correcto; luego se corrompió el hash y
se confirmó el rechazo. Ver el historial de commits del repo para el
detalle de esas pruebas.

## Qué NO se le muestra al usuario final

`/ayuda` le dice al usuario que su contraseña se guarda cifrada, pero
**no** menciona el algoritmo específico, Supabase, ni ningún otro
detalle de la arquitectura — esos detalles quedan en esta documentación,
no en un mensaje que puede leer cualquier estudiante que se registre.
Menos información pública sobre el mecanismo interno es una capa más
(no la principal) de defensa.

## Riesgo residual

Si `CREDENTIALS_ENCRYPTION_KEY` se filtrara **y** alguien obtuviera
acceso a la base de datos (ej. el `service_role key` también filtrado),
podría descifrar las contraseñas de todos los usuarios registrados. No
hay forma de eliminar ese riesgo por completo mientras el sistema
necesite loguearse en INTRALU automáticamente sin intervención humana —
la mitigación es operativa: esa llave nunca se comparte, nunca se pone
en código ni en ningún lugar público, y ante cualquier sospecha de
filtración correspondería rotarla (lo que invalida todas las
credenciales guardadas — los usuarios tendrían que volver a
`/registrar`) y avisar a los usuarios registrados.

## Repo público: qué implica

El scraper y la lógica del bot son públicos — pero:

- Ninguna credencial real (tokens, llaves, contraseñas) vive en el
  código ni en el historial de git.
- Las notas de los usuarios **no se commitean a git** — viven solo en
  Postgres.
- El código de estudiante de terceros nunca se expone (solo se guarda
  cifrado en la base de datos).

## Incidentes reales durante el desarrollo

Documentados acá con honestidad porque son parte de la historia real
del proyecto, no para esconderlos:

1. **Token de Telegram y llave de cifrado en texto plano en `GUIA.md`**,
   a punto de commitearse — un clasificador de seguridad automático
   bloqueó el commit antes de que pasara. Se corrigió reemplazando los
   valores reales por referencias a `.env` (nunca commiteado).
2. **El mismo token quedó en un commit anterior** que sí se había hecho
   localmente (antes de detectarse), sin llegar a pushearse a GitHub
   todavía. Se reescribió el historial local (`git init` desde cero)
   antes del primer push.
3. **El código de estudiante del autor apareció en `GUIA.md` y como
   placeholder en el formulario de registro**, ya en un repo público con
   varios commits pusheados. Se corrigieron ambos archivos y se
   reescribió **todo el historial remoto** con `git push --force` — la
   opción más segura disponible en ese momento, aceptando que un repo
   que estuvo público un rato no garantiza que nadie lo haya visto antes
   del rewrite (ver la nota de riesgo residual arriba: no es lo mismo
   que filtrar una contraseña, pero se trató con el mismo cuidado).
