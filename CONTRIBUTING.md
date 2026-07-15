# Contribuir

## Correr localmente

```bash
npm install
cp .env.example .env   # completa tus propias credenciales de prueba
npm run test-login     # login de diagnóstico contra INTRALU con tu usuario
npm run check-all      # corre el chequeo completo contra tu Supabase
```

`npm run test-login` no toca Supabase — solo confirma que el login y el
scraping siguen funcionando contra el sitio real. Útil para aislar si un
problema es del scraper o del resto del sistema.

## Estructura del código

Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#estructura-de-archivos)
para el mapa completo. Resumen rápido:

- `lib/` y los archivos `.js` en la raíz corren en **Node** (GitHub
  Actions, tu máquina).
- `supabase/functions/*/` corren en **Deno** (Supabase Edge Functions).
- `public/*.html` corren en el **navegador**, dentro de Telegram.

Tres runtimes distintos — antes de tocar algo, fíjate en cuál corre el
archivo que estás editando (`require`/`module.exports` = Node,
`import`/`export` con `Deno.env` = Edge Function, `<script>` plano =
navegador).

## Por qué hay código duplicado

`lib/crypto.js` (Node) y `supabase/functions/*/crypto.ts` (Deno, una
copia por función) son el mismo esquema de cifrado, copiado a propósito
en vez de importado entre runtimes — ver la explicación completa en
[`ARCHITECTURE.md`](docs/ARCHITECTURE.md#por-qué-hay-código-duplicado-entre-node-y-deno).

**Si modificas `crypto.js`/`crypto.ts`, tenés que actualizar todas las
copias y volver a verificar que sigan dando el mismo resultado.** Así se
verificó durante el desarrollo (podés repetir el mismo patrón):

```bash
# Cifrar en un runtime, descifrar en el otro, confirmar interoperabilidad
node -e "
const { encrypt } = require('./lib/crypto');
encrypt('texto de prueba', 'TU_LLAVE_BASE64').then(console.log);
"
# copiar el resultado y pasarlo al equivalente en Deno con decrypt()
```

El evaluador de fórmulas de INTRALU (`public/simulador.html`) es JS de
navegador puro y **no** tiene copia en Deno/Node — si lo tocás, probalo
directo en el navegador o extrayendo el bloque `<script>` a un archivo
`.js` temporal y corriendo `node --check archivo.js` para al menos
confirmar que la sintaxis es válida antes de desplegar.

No existe un test automatizado que corra esto en CI todavía — es manual.
Si agregas una funcionalidad nueva que dependa de estas piezas duplicadas,
considera si un test rápido (`node -e`) vale la pena antes de desplegar.

## Verificar las Edge Functions antes de desplegar

```bash
cd supabase/functions/telegram-webhook   # o la función que tocaste
deno check --no-config index.ts
deno lint --no-config index.ts
```

Esto atrapa errores de tipos y de estilo antes de gastar un deploy. El
proyecto usa [Deno](https://deno.com/) — instálalo si no lo tienes
(`irm https://deno.land/install.ps1 | iex` en PowerShell,
`curl -fsSL https://deno.land/install.sh | sh` en bash).

## Desplegar un cambio

```bash
npx supabase functions deploy NOMBRE_DE_LA_FUNCION --no-verify-jwt
```

Necesitas estar logueado (`npx supabase login`) y con el proyecto
linkeado (`npx supabase link --project-ref TU_REF`) — ver
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Para cambios en `public/*.html`, un simple `git push` a `main` dispara
[`deploy-pages.yml`](.github/workflows/deploy-pages.yml) automáticamente.

## Antes de hacer un PR

- `deno check` + `deno lint` en cualquier Edge Function que tocaste.
- Si tocaste `lib/session.js` o el scraping, corré `npm run test-login`
  contra tu propio usuario real — no hay forma de probar el scraper sin
  pegarle al sitio real (no hay ambiente de staging de INTRALU).
- Si agregaste texto que le llega al usuario final (mensajes del bot,
  `/ayuda`, las Mini Apps), revisa que no esté filtrando detalles de
  arquitectura o de implementación (ver
  [`SECURITY.md`](docs/SECURITY.md#qué-no-se-le-muestra-al-usuario-final)).
- Nunca commitees `.env`, ni pegues tokens/llaves reales en ningún
  archivo del repo — ni siquiera en un comentario "temporal". Ya pasó
  una vez en este proyecto (ver
  [`SECURITY.md`](docs/SECURITY.md#incidentes-reales-durante-el-desarrollo))
  y costó reescribir el historial de git.

## Reportar bugs o proponer cambios

Abre un issue. Si es una vulnerabilidad de seguridad, no lo hagas
público — ver [`SECURITY.md`](docs/SECURITY.md#reportar-una-vulnerabilidad).
