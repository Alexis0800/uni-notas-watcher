# Cómo funciona INTRALU por dentro

INTRALU no tiene una API pública documentada — todo lo de acá se sacó
inspeccionando el tráfico real del sitio (`alumnos.uni.edu.pe`) durante
el desarrollo. Si INTRALU cambia su implementación, este documento (y el
código que depende de él) puede quedar desactualizado.

## Login

- El formulario de login usa los campos `txt-codigo` y `txt-password`
  (no `codigo`/`password` como se podría asumir).
- Tiene reCAPTCHA v3 invisible, pero el backend **no lo valida de forma
  estricta**: mandar el campo `g-recaptcha-response` vacío basta para
  pasar el login. Esto podría cambiar si INTRALU endurece su validación
  en el futuro.
- Requiere manejo de cookies de sesión estilo Laravel (`XSRF-TOKEN` +
  `intranet_alumno_session`) — `lib/session.js` usa `tough-cookie` +
  `axios-cookiejar-support` para esto.

## Modelo de evaluaciones

Cada curso matriculado tiene una lista de "evaluaciones" (endpoint
`/informacion-academica/cursos/notas`), cada una con un código `camnot`
que mapea a un nombre de variable usado en las fórmulas:

| `camnot` | Variable | Significado típico |
|---|---|---|
| 1-12 | `N1`...`N12` | Prácticas, monografías, o lo que el curso tenga configurado — **el número no implica qué tipo de evaluación es** |
| 13 | `EP` | Examen Parcial |
| 14 | `EF` | Examen Final |
| 15 | `ES` | Examen Sustitutorio |

**Importante:** `N3`, por ejemplo, no siempre es "Práctica 3". En un
curso puede ser la tercera práctica, en otro puede ser "Monografía 1".
El campo `descripcion` que devuelve la API tiene el nombre real — se usa
ese, nunca se asume el nombre a partir del número de variable.

## Estados de una nota

Cada evaluación puede estar en uno de estos estados:

- **Sin fecha de registro** (`fecha_registro_acta: null`): todavía no
  pasó nada — ni examen rendido ni nota puesta. Este proyecto **no
  notifica ni muestra** estas evaluaciones en `/notas` (generarían ruido
  eterno, ej. "Examen Sustitutorio" para quien nunca lo necesita), pero
  sí las usa en `/simular` como campos editables.
- **Con fecha, nota numérica**: evaluación calificada normalmente.
- **Con fecha, `nota: null`**: se muestra como **NSP** ("No Se
  Presentó") — la evaluación se cerró administrativamente sin que el
  alumno rindiera.
- **`flgnot: true`** (viene en la respuesta de la API): la nota fue
  **anulada** (ej. copia/falta grave) — se muestra como **0A**,
  independientemente del valor numérico de `nota`.

Ver la implementación en `lib/session.js` (`formatearNota`) y su
contraparte en cada Edge Function.

## Fórmulas

Cada curso trae dos fórmulas como texto plano en la respuesta de la API
(`formulas.practicas`, `formulas.teoria`), ej:

```
practicas: "(N1 + N2 + N3 + N4- MIN(N1, N2, N3, N4))/3"
teoria:    "( PP + EP + 2.EF )/  4"
```

- `PP` es el promedio de prácticas — se calcula con la fórmula
  `practicas`, no se pide directamente al usuario en el simulador.
- `MIN(...)` existe en fórmulas reales (típicamente para descartar la
  práctica más baja).
- **`2.EF` no es un decimal** — es la notación que usa INTRALU para "2
  veces EF" (peso doble). El evaluador de fórmulas normaliza
  `dígito.letra` a `dígito*letra` antes de tokenizar, sin tocar
  decimales reales como `3.5` (dígito seguido de dígito).
- Las fórmulas varían por curso: no asumir una estructura fija (algún
  curso tiene una fórmula de un solo término, ej. `( PP )/  1`).

El evaluador de fórmulas (tokenizador + parser recursivo, sin ejecutar
el texto como código) está implementado en tres lugares — ver
[`ARCHITECTURE.md`](ARCHITECTURE.md#por-qué-hay-código-duplicado-entre-node-y-deno).

### Variables que la fórmula menciona pero que todavía no existen

A veces la fórmula ya menciona `N1`-`N4` pero INTRALU **todavía no creó
el registro** de esas prácticas (pasa con cursos recién empezando el
ciclo). El simulador trata la fórmula como fuente de verdad: si una
variable no tiene evaluación real, igual se ofrece como campo editable,
mostrando el código de la variable como nombre (no hay descripción real
que mostrar todavía).

## Examen Sustitutorio (ES)

`ES` **no aparece en ninguna fórmula** — es una regla de negocio aparte
del sistema de INTRALU: si el alumno lo rinde, reemplaza su **peor**
nota entre Parcial y Final (lo que más le convenga).

El simulador lo detecta por separado (evaluación con `variable === 'ES'`
sin fecha de registro) y, si el usuario ingresa una nota hipotética,
calcula el resultado final reemplazando primero `EP` y después `EF`,
mostrando el mejor de los dos — comparando el **resultado final real**
de la fórmula (con sus pesos), no cuál nota es numéricamente más baja.
Esto importa cuando una evaluación pesa más que otra: reemplazar la nota
más baja no siempre da el mejor resultado si la más alta pesa más en la
fórmula final.

## Nota aprobatoria

10 (sobre 20), usado como umbral para 🟢/🔴 y en el simulador. No se
encontró un endpoint que confirme este valor — está tomado del
conocimiento del alumno sobre las reglas de la universidad, no
verificado contra la API.
