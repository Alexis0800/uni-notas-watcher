# Escalabilidad: ¿soporta 10.000 o 100.000 usuarios?

**No, no con la arquitectura actual.** El cuello de botella no es la base
de datos ni el costo de hosting — es la velocidad a la que se puede
hacer scraping de un solo sitio de terceros (INTRALU) sin que empiece a
bloquear o limitar el tráfico.

## El número real, medido

`check-all-users.js` corrido contra una cuenta real tardó **~14
segundos por usuario** (login + lista de cursos + notas de 5 cursos ≈ 7
ida-y-vuelta HTTP contra `alumnos.uni.edu.pe`). Con `CONCURRENCY = 5`
(5 usuarios en paralelo) en
[`check-all-users.js`](../check-all-users.js):

```
tiempo por pasada completa ≈ (usuarios / 5) × 14s
```

| Usuarios | Tiempo de una pasada completa | ¿Cabe en el intervalo de 5 min? |
|---|---|---|
| 50 | ~2.3 min | Sí, con margen |
| 100 | ~4.7 min | Al límite |
| 500 | ~23 min | No — se atrasa progresivamente |
| 1.000 | ~47 min | No — la promesa de "cada 5 min" deja de tener sentido |
| 10.000 | ~7.8 horas | No, ni de cerca |
| 100.000 | ~78 horas | No es viable con este diseño |

El workflow tiene `concurrency: cancel-in-progress: false` — si una
pasada tarda más que el intervalo de 5 minutos, la siguiente corrida
**se encola** en vez de correr en paralelo o cancelar la anterior. Con
más de unos cientos de usuarios, el atraso crece sin límite: cada
pasada nueva empieza más atrasada que la anterior, para siempre.

## Por qué no alcanza con "subir la concurrencia"

Subir `CONCURRENCY` ayuda la matemática (con 50 en paralelo, 10.000
usuarios bajarían de ~7.8h a menos de 1h), pero exponer 50-100 logins
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

## Qué haría falta para escalar en serio (si se decidiera perseguirlo)

1. **Sacar el chequeo de GitHub Actions cron** — no está pensado para
   procesamiento sostenido de alto volumen. Reemplazarlo por un
   worker/cola dedicado (ej. un proceso long-running en un VPS o
   servicio tipo Fly.io/Railway, consumiendo una cola de trabajos).
2. **Repartir la carga en el tiempo**, no revisar a todos cada 5
   minutos — por ejemplo, cada usuario se revisa cada 30-60 min mientras
   la base crece, en vez de mantener la promesa de 5 min a cualquier
   costo.
3. **Coordinar la tasa de requests hacia INTRALU** de forma consciente
   (rate limiting propio, no solo confiar en que no nos bloqueen) — acá
   entra directo el problema ético/de ToS de arriba, no solo el técnico.
4. **Subir el plan de Supabase** (Pro, $25/mes, 8GB) antes de acercarse
   al límite de 500MB.

Ninguno de estos puntos está implementado — este documento es un mapa
de qué haría falta, no una promesa de que está resuelto.

## Conclusión práctica

Con el diseño actual, el rango cómodo es **decenas a un par de cientos
de usuarios** revisados cada 5 minutos. Unos pocos miles probablemente
"funcionan" pero con avisos cada vez más atrasados respecto a la
promesa de 5 minutos. 10.000 o 100.000 usuarios necesitarían un
rediseño real del chequeo periódico — y antes de construir eso, vale la
pena decidir si operar a esa escala tiene sentido dado que no es un
servicio oficial de la universidad.
