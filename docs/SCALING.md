# Escalabilidad: ¿soporta 10.000 o 100.000 usuarios?

**No, no con la arquitectura actual.** El cuello de botella no es la base
de datos ni el costo de hosting — es la velocidad a la que se puede
hacer scraping de un solo sitio de terceros (INTRALU) sin que empiece a
bloquear o limitar el tráfico.

## El número real, medido

La primera versión de este documento decía **~14 segundos por
usuario** (login + lista de cursos + notas de 5 cursos ≈ 7
ida-y-vuelta HTTP contra `alumnos.uni.edu.pe`), medido corriendo el
script desde una máquina local. Corriendo el mismo chequeo **desde
GitHub Actions** (que es donde realmente corre en producción) el
número real es **~28-30 segundos por usuario** — casi el doble, porque
la ruta de red desde los runners de GitHub hacia la universidad es más
lenta que desde una conexión local. Medido con la API de GitHub Actions
sobre 5 corridas reales (con 1 solo usuario activo en cada una):

| Corrida | Duración del paso "Run check-all-users" |
| --- | --- |
| 1 | 26.0s |
| 2 | 29.0s |
| 3 | 32.0s |
| 4 | 30.0s |
| 5 | 27.0s |

Con `CONCURRENCY = 5` (5 usuarios en paralelo) en el diseño original
(sin cola por antigüedad, revisando a todos en cada corrida):

```text
tiempo por pasada completa ≈ (usuarios / 5) × 30s
```

| Usuarios | Tiempo de una pasada completa | ¿Cabe en el intervalo de 5 min? |
| --- | --- | --- |
| 50 | ~5 min | Al límite |
| 100 | ~10 min | No — ya se atrasa |
| 500 | ~50 min | No — se atrasa progresivamente |
| 1.000 | ~1.7 horas | No — la promesa de "cada 5 min" deja de tener sentido |
| 10.000 | ~16.7 horas | No, ni de cerca |
| 100.000 | ~167 horas | No es viable con este diseño |

El workflow tiene `concurrency: cancel-in-progress: false` — si una
pasada tarda más que el intervalo de 5 minutos, la siguiente corrida
**se encola** en vez de correr en paralelo o cancelar la anterior. Con
más de unos cientos de usuarios, el atraso crece sin límite: cada
pasada nueva empieza más atrasada que la anterior, para siempre.

## Por qué no alcanza con "subir la concurrencia"

Subir `CONCURRENCY` ayuda la matemática (con 50 en paralelo, 10.000
usuarios bajarían de ~16.7h a ~1.7h), pero exponer 50-100 logins
simultáneos desde las IPs compartidas de GitHub Actions hacia el
sistema de una universidad es:

- **Un riesgo técnico real**: cualquier WAF/protección anti-bot
  razonable marcaría eso como tráfico sospechoso — podría terminar en
  bloqueo de IP, o en que INTRALU empiece a exigir el reCAPTCHA que hoy
  no valida de forma estricta (ver
  [`GRADING-RULES.md`](GRADING-RULES.md#login)).
- **Un problema que no es solo técnico**: una herramienta que un puñado
  de compañeros usan para revisar sus propias notas es una cosa. Un
  servicio no oficial que hace scraping masivo contra el sistema de una
  universidad, con las credenciales de decenas de miles de estudiantes,
  sin que la universidad lo sepa ni lo autorice, es otra — cambia el
  perfil de riesgo (términos de servicio, posible atención no deseada
  de TI de la universidad) de forma real. Esto es una pregunta de
  "deberías" tanto como de "podrías", y no se puede resolver solo con
  más cómputo.

## Otros límites que también aparecen antes de 100k

- **Base de datos**: cada fila de `usuarios` (contraseña cifrada +
  `last_grades` + `cursos` con fórmulas/promedios de cada curso) pesa
  aproximadamente 10-15 KB. El plan free de Supabase da 500 MB — eso
  alcanza para unos ~30.000-50.000 usuarios solo de espacio, pero ese
  límite aparece mucho antes que el de scraping, así que en la práctica
  nunca se llega a probarlo con la arquitectura actual.
- **Invocaciones de Edge Functions**: el plan free da 500.000
  invocaciones/mes. El webhook y las Mini Apps se usan bajo demanda (no
  en el loop de chequeo), así que esto no sería el límite antes que el
  scraping.

## Mitigación implementada: cola por antigüedad, no franjas de tiempo

[`check-all-users.js`](../check-all-users.js) ya no intenta revisar a
todos los usuarios activos en cada corrida de cron. En vez de eso, le
pide a Postgres los `MAX_BATCH_SIZE` más atrasados:

```sql
select * from usuarios where active
order by seeded asc, updated_at asc
limit :MAX_BATCH_SIZE
```

- **`seeded asc` primero**: los que nunca se revisaron (recién
  registrados) van antes que todos, para no atrasar su primer chequeo
  detrás de una cola larga.
- **`updated_at asc` después**: entre los ya revisados, el más
  atrasado (el que lleva más tiempo sin un chequeo exitoso) va primero.
- Un usuario a quien `checkUser()` le falla **no** actualiza
  `updated_at`, así que vuelve a quedar primero en la cola — se
  reintenta en la próxima corrida, no en el próximo "ciclo".
- `MAX_BATCH_SIZE = floor((RUN_WINDOW_SECONDS / SECONDS_PER_USER) × CONCURRENCY)`,
  con `RUN_WINDOW_SECONDS = 270s` (el overhead real de checkout +
  setup-node + `pnpm install`, medido con la API de GitHub Actions, es
  de solo ~5s — no los ~90s que se asumían antes de medirlo, así que
  270s deja margen de sobra) y `CONCURRENCY = 15` (configurable con la
  env var `CONCURRENCY`, subida desde 5 — sigue lejos de los 50-100 en
  paralelo que dispararían protección anti-bot).

Con `SECONDS_PER_USER = 30` (medido, ver arriba) esto da
`MAX_BATCH_SIZE ≈ 135`. Si hay menos usuarios activos que eso, se
comporta igual que antes (todos revisados cada 5 min). Si hay más,
cada usuario espera aproximadamente
`(usuarios_activos / MAX_BATCH_SIZE) × 5 min` entre chequeos:

| Usuarios activos | Intervalo real aproximado por usuario |
| --- | --- |
| ≤ 135 | 5 min (igual que antes) |
| 500 | ~20 min |
| 1.000 | ~40 min |
| 5.000 | ~190 min (~3.2 h) |

`main()` en [`check-all-users.js`](../check-all-users.js) loggea el
tiempo real y segundos/usuario de cada corrida, así que estos números
se pueden ir corrigiendo con datos reales de producción en vez de
quedarse fijos en esta medición inicial.

Esto reemplaza un diseño anterior basado en repartir usuarios en
franjas rotativas por bloques de tiempo (`chat_id % N`, rotando según
el reloj). Se descartó porque dependía de que GitHub Actions disparara
el cron exactamente cada 5 min (si se atrasaba o se saltaba una
corrida, esa franja se perdía ese ciclo entero) y de que el número de
franjas no cambiara entre corridas (si el conteo de usuarios activos
cruzaba un umbral, la asignación se desincronizaba). La cola por
`updated_at` no tiene ninguno de esos dos problemas: no asume nada
sobre cuándo corre el cron, y no hay "número de franjas" que se pueda
desincronizar — cada corrida simplemente toma a los que más esperaron,
sin importar cuántos sean ni cuándo corrió la corrida anterior.

### Cómo se midió esto (y qué falta por medir)

Dos fuentes de datos reales, ambas del 2026-07-15:

**1. Corridas reales de producción**, vía la API de GitHub Actions
(`/repos/.../actions/runs`, `/actions/runs/:id/jobs`) — de ahí salen
los ~28-30s/usuario de la tabla de arriba y el overhead de ~5s del
setup del job. Limitación real: en este momento solo hay **1 usuario
activo** en la base (el propio desarrollador), así que estas corridas
nunca ejercitaron `CONCURRENCY > 1` de verdad — no hay todavía forma
de observar el comportamiento a 1.000-5.000 usuarios reales sin
esperar a tenerlos.

**2. [`benchmark-concurrency.js`](../benchmark-concurrency.js)**
(`pnpm run benchmark-concurrency`) — mide el mismo flujo de
`checkUser()` (login + cursos + notas) a distinta concurrencia, con la
única cuenta real disponible logueada varias veces en paralelo. Corrida
una vez el 2026-07-15:

| Concurrencia | Resultado |
| --- | --- |
| 1 | 1/1 OK, 11.1s |
| 3 | 3/3 OK, promedio 12.2s, máximo 12.5s |
| 5 | 1/5 OK, 4 fallaron con `401` |

Dos lecturas de esto:

- **De 1 a 3 en paralelo, el tiempo casi no sube** (11.1s → 12.2s,
  ~10%) — no hay señal de que INTRALU se ponga dramáticamente más
  lento con algo de concurrencia. Buena noticia parcial para
  `CONCURRENCY = 15`, aunque esto solo prueba hasta 3, no 15.
- **A concurrencia 5, 4 de 5 fallaron con 401** — pero esto es un
  artefacto de usar la *misma cuenta* logueada varias veces a la vez:
  INTRALU invalida sesiones concurrentes de un mismo usuario (un login
  nuevo tumba al anterior), así que esto no mide degradación del
  servidor bajo carga — mide que una cuenta no puede tener 5 sesiones
  simultáneas. En producción cada usuario tiene su propia cuenta, así
  que este conflicto puntual no debería repetirse ahí. Vale la pena
  tenerlo presente igual: si alguna vez una misma persona queda
  "duplicada" en la tabla `usuarios` (dos filas, mismo `codigo_uni`),
  sus chequeos sí competirían por la misma sesión.

**Conclusión honesta**: no hay evidencia de que `CONCURRENCY = 15` con
cuentas *distintas* cause problemas, pero tampoco hay una prueba real
a esa escala — solo se pudo probar hasta 3 en paralelo con la única
cuenta disponible. La corrección real y confirmada es la de
`SECONDS_PER_USER` (14s → 30s); el efecto de la concurrencia en sí
queda como una hipótesis razonable, no un hecho medido, hasta que haya
más usuarios reales y los logs de `main()` lo confirmen o lo
contradigan.

### Hallazgo: el `schedule` de GitHub Actions no dispara cada 5 minutos

Revisando las corridas reales vía la API de GitHub Actions, el
`schedule: '*/5 * * * *'` no se cumplió — **4 disparos programados,
todos con ~1 hora de diferencia** (19:33, 20:37, 21:35, 22:34; huecos
de 63.6, 58.0 y 59.7 min), no de 5 minutos. Es consistente entre las 3
mediciones, no ruido — comportamiento documentado de GitHub Actions
(los `schedule` triggers se atrasan o se saltan bajo carga de la
plataforma, más en repos/workflows nuevos o de poca actividad) y **era
un límite más grande que todo lo demás en este documento**: sin
importar qué tan bien esté calibrado `CONCURRENCY` o la cola por
antigüedad, si el disparador mismo no dispara cada 5 min, nadie recibe
avisos cada 5 min.

### Mitigación implementada: auto-encadenado de corridas

[`check-grade.yml`](../.github/workflows/check-grade.yml) ya no
depende únicamente del `schedule` nativo. El último paso del job
(`Encadenar la siguiente corrida en ~5 min`) espera a que se cumplan
5 minutos desde que arrancó el job y dispara la siguiente corrida él
mismo, vía la API de GitHub (`POST .../actions/workflows/check-grade.yml/dispatches`).
El `schedule: '*/5 * * * *'` se deja como respaldo — GitHub lo va a
seguir disparando cada ~1h nada más, pero eso basta para **reiniciar
la cadena** si alguna corrida falla antes de llegar a ese último paso.

Por qué no alcanza con el `GITHUB_TOKEN` automático: GitHub bloquea a
propósito que el token por defecto de un job dispare otro
`workflow_dispatch` (para evitar loops recursivos accidentales). Hace
falta un Personal Access Token real, guardado como secret del repo —
esto **sí requiere una acción manual tuya**, no hay forma de
generarlo desde acá:

1. GitHub → tu foto de perfil → **Settings** → **Developer settings**
   → **Personal access tokens** → **Fine-grained tokens** → **Generate
   new token**.
2. **Resource owner**: tu cuenta. **Repository access**: "Only select
   repositories" → `uni-notas-watcher` (nada más — no le des acceso a
   otros repos).
3. **Permissions** → Repository permissions → **Actions**: "Read and
   write". No hace falta ningún otro permiso (ni "Contents", ni
   "Secrets" — con esto no se puede leer código ni credenciales, solo
   disparar/cancelar corridas de Actions de este repo).
4. Ponle una expiración razonable (ej. 1 año) — si expira, el
   auto-encadenado simplemente deja de funcionar sin romper nada más
   (vuelve al respaldo de ~1h), así que no es catastrófico si se te
   pasa renovarlo.
5. Copia el token generado y agrégalo como secret del repo: **Settings**
   del repo → **Secrets and variables** → **Actions** → **New
   repository secret** → nombre `WORKFLOW_DISPATCH_TOKEN`, valor el
   token.

Una vez agregado el secret, la próxima corrida (manual o del
`schedule` de respaldo) arranca la cadena de 5 min sola. Sin el
secret, el paso lo detecta y no hace nada (avisa en el log, no falla
el job) — se queda en el intervalo de ~1h del `schedule` nativo hasta
que se agregue.

## Qué seguiría faltando para ir más allá de unos pocos miles

1. **Sacar el chequeo de GitHub Actions cron** — la cola por
   antigüedad estira el rango cómodo, pero para intervalos
   consistentemente cortos (5 min) con decenas de miles de usuarios
   haría falta un worker/cola dedicado (proceso long-running en un VPS
   o servicio tipo Fly.io/Railway).
2. **Coordinar la tasa de requests hacia INTRALU** de forma consciente
   (rate limiting propio, no solo confiar en que no nos bloqueen) — acá
   entra directo el problema ético/de ToS de arriba, no solo el
   técnico.
3. **Subir el plan de Supabase** (Pro, $25/mes, 8GB) antes de acercarse
   al límite de 500MB (~30.000-50.000 usuarios con el peso actual por
   fila).

## Conclusión práctica

Con la cola por antigüedad, el rango cómodo se estira de "un par de
cientos" a **unos pocos miles de usuarios**, a costa de que el aviso
deja de ser "a los 5 min" y pasa a ser "a los 20 min-3h" según cuántos
usuarios activos haya. Eso asume que el cron dispara cada 5 min de
verdad — cosa que el `schedule` nativo de GitHub Actions no cumplía
(medido: ~1h real), corregido con el auto-encadenado de arriba
mientras el secret `WORKFLOW_DISPATCH_TOKEN` esté configurado. Sin ese
secret, el intervalo real vuelve a estar limitado por el respaldo de
~1h, sin importar cuántos usuarios haya. 10.000 o 100.000 usuarios
seguirían necesitando sacar el chequeo de GitHub Actions — y antes de construir
eso, vale la pena decidir si operar a esa escala tiene sentido dado
que no es un servicio oficial de la universidad.
