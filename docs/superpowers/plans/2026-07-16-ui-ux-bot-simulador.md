# UI/UX simulador, registro y bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NSP/0A support to the simulator (with a real MIN()-elimination bug fix), polish the registration form, and improve bot messages — including an almost-instant grade check right after registration.

**Architecture:** Three isolated runtimes stay isolated (Node scraper, Deno Edge Functions, browser-only Mini Apps) — no new cross-runtime sharing is introduced. The simulator's formula evaluator gains an `anuladas` (annulled-variables) parameter threaded through `MIN(...)` resolution. The bot's immediate-check feature reuses the exact `workflow_dispatch` mechanism already built for the 5-minute self-chain, called this time from the Deno webhook instead of from the workflow itself.

**Tech Stack:** Node (`check-all-users.js`), Deno/TypeScript (Supabase Edge Functions), vanilla browser JS (`public/*.html`, no build step, no framework).

**Reference:** Design spec at [`docs/superpowers/specs/2026-07-16-ui-ux-bot-simulador-design.md`](../specs/2026-07-16-ui-ux-bot-simulador-design.md).

---

### Task 1: Backend — mark annulled variables in `simular-datos`

**Files:**
- Modify: `supabase/functions/simular-datos/index.ts:87-116`

- [ ] **Step 1: Add the `anuladas` array and populate it**

Replace:

```ts
  const locked: { descripcion: string; valor: string }[] = [];
  const vars: Record<string, number> = {};
  const pending: { variable: string; descripcion: string }[] = [];

  const evalPorVariable = new Map(meta.evaluaciones.map((ev) => [ev.variable.toUpperCase(), ev]));

  for (const variable of extraerVariables(meta.formulas)) {
    const ev = evalPorVariable.get(variable);
    if (ev && ev.fecha) {
      // Fija: anulada (0A) o no se presentó (NSP) cuentan como 0 en la
      // fórmula; una nota numérica cuenta con su valor real.
      locked.push({ descripcion: ev.descripcion, valor: ev.valor ?? '—' });
      vars[variable] = ev.anulada || ev.nota === null ? 0 : ev.nota;
    } else if (ev) {
      pending.push({ variable, descripcion: ev.descripcion });
    } else {
      // La fórmula la menciona pero INTRALU ni creó el casillero todavía
      // (pasa con prácticas de cursos recién empezando) — no hay nombre
      // real que mostrar, se usa el propio código de la variable.
      pending.push({ variable, descripcion: variable });
    }
  }
```

with:

```ts
  const locked: { descripcion: string; valor: string }[] = [];
  const vars: Record<string, number> = {};
  const anuladas: string[] = [];
  const pending: { variable: string; descripcion: string }[] = [];

  const evalPorVariable = new Map(meta.evaluaciones.map((ev) => [ev.variable.toUpperCase(), ev]));

  for (const variable of extraerVariables(meta.formulas)) {
    const ev = evalPorVariable.get(variable);
    if (ev && ev.fecha) {
      // Fija: anulada (0A) o no se presentó (NSP) cuentan como 0 en la
      // fórmula; una nota numérica cuenta con su valor real. Una anulada
      // además se marca en `anuladas` para que el simulador nunca la deje
      // ser la que MIN(...) descarta (ver public/simulador.html).
      locked.push({ descripcion: ev.descripcion, valor: ev.valor ?? '—' });
      vars[variable] = ev.anulada || ev.nota === null ? 0 : ev.nota;
      if (ev.anulada) anuladas.push(variable);
    } else if (ev) {
      pending.push({ variable, descripcion: ev.descripcion });
    } else {
      // La fórmula la menciona pero INTRALU ni creó el casillero todavía
      // (pasa con prácticas de cursos recién empezando) — no hay nombre
      // real que mostrar, se usa el propio código de la variable.
      pending.push({ variable, descripcion: variable });
    }
  }
```

- [ ] **Step 2: Return `anuladas` in the response**

Replace:

```ts
  return json({ ok: true, nombre: meta.nombre, formulas: meta.formulas, vars, locked, pending, sustitutorio });
```

with:

```ts
  return json({ ok: true, nombre: meta.nombre, formulas: meta.formulas, vars, anuladas, locked, pending, sustitutorio });
```

- [ ] **Step 3: Verify with Deno's type checker and linter**

Run:
```bash
cd "supabase/functions/simular-datos"
deno check --no-config index.ts
deno lint --no-config index.ts
```
Expected: both commands exit with no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/simular-datos/index.ts
git commit -m "Marca las variables anuladas (0A) en la respuesta del simulador"
```

---

### Task 2: Simulador — `evaluarFormula` respeta anuladas en `MIN(...)`

**Files:**
- Modify: `public/simulador.html:101-156`

- [ ] **Step 1: Replace `evaluarFormula` to accept and use `anuladas`**

Replace the entire existing function:

```js
    function evaluarFormula(expr, vars) {
      const tokens = tokenize(expr);
      let pos = 0;
      const peek = () => tokens[pos];
      const next = () => tokens[pos++];
      function parseExpr() {
        let value = parseTerm();
        while (peek() === '+' || peek() === '-') {
          const op = next();
          const rhs = parseTerm();
          value = op === '+' ? value + rhs : value - rhs;
        }
        return value;
      }
      function parseTerm() {
        let value = parseFactor();
        while (peek() === '*' || peek() === '/') {
          const op = next();
          const rhs = parseFactor();
          value = op === '*' ? value * rhs : value / rhs;
        }
        return value;
      }
      function parseFactor() {
        const tok = peek();
        if (tok === undefined) throw new Error('Fórmula incompleta');
        if (tok === '-') { next(); return -parseFactor(); }
        if (tok === '(') {
          next();
          const value = parseExpr();
          if (next() !== ')') throw new Error('Falta paréntesis de cierre');
          return value;
        }
        if (/^[A-Za-z]/.test(tok)) {
          if (tok.toUpperCase() === 'MIN') {
            next();
            if (next() !== '(') throw new Error('Se esperaba "(" después de MIN');
            const valores = [parseExpr()];
            while (peek() === ',') { next(); valores.push(parseExpr()); }
            if (next() !== ')') throw new Error('Falta paréntesis de cierre en MIN');
            return Math.min(...valores);
          }
          next();
          const key = tok.toUpperCase();
          if (!(key in vars)) throw new Error('Variable desconocida: ' + tok);
          return vars[key];
        }
        next();
        const n = Number(tok);
        if (Number.isNaN(n)) throw new Error('Token numérico inválido: ' + tok);
        return n;
      }
      const resultado = parseExpr();
      if (pos !== tokens.length) throw new Error('Fórmula mal formada');
      return resultado;
    }
```

with:

```js
    // `anuladas` es un Set<string> con los nombres de variable (ej. "N1")
    // marcadas como 0A — nunca pueden ser la que MIN(...) descarta, aunque
    // numéricamente sean las más bajas (cuentan como 0 en la suma igual,
    // pero no son candidatas a ser eliminadas).
    function evaluarFormula(expr, vars, anuladas) {
      anuladas = anuladas || new Set();
      const tokens = tokenize(expr);
      let pos = 0;
      const peek = () => tokens[pos];
      const next = () => tokens[pos++];
      function parseExpr() {
        let value = parseTerm();
        while (peek() === '+' || peek() === '-') {
          const op = next();
          const rhs = parseTerm();
          value = op === '+' ? value + rhs : value - rhs;
        }
        return value;
      }
      function parseTerm() {
        let value = parseFactor();
        while (peek() === '*' || peek() === '/') {
          const op = next();
          const rhs = parseFactor();
          value = op === '*' ? value * rhs : value / rhs;
        }
        return value;
      }
      // Un argumento de MIN(...) que es directamente una referencia a una
      // variable (un solo token identificador, no una subexpresión) trae
      // también su nombre — así MIN sabe si esa variable está anulada.
      function parseArgConNombre() {
        const tok = peek();
        let nombre = null;
        if (tok !== undefined && /^[A-Za-z]/.test(tok) && tok.toUpperCase() !== 'MIN') {
          const siguiente = tokens[pos + 1];
          if (siguiente === ',' || siguiente === ')') nombre = tok.toUpperCase();
        }
        const valor = parseExpr();
        return { valor, nombre };
      }
      function parseFactor() {
        const tok = peek();
        if (tok === undefined) throw new Error('Fórmula incompleta');
        if (tok === '-') { next(); return -parseFactor(); }
        if (tok === '(') {
          next();
          const value = parseExpr();
          if (next() !== ')') throw new Error('Falta paréntesis de cierre');
          return value;
        }
        if (/^[A-Za-z]/.test(tok)) {
          if (tok.toUpperCase() === 'MIN') {
            next();
            if (next() !== '(') throw new Error('Se esperaba "(" después de MIN');
            const args = [parseArgConNombre()];
            while (peek() === ',') { next(); args.push(parseArgConNombre()); }
            if (next() !== ')') throw new Error('Falta paréntesis de cierre en MIN');
            const elegibles = args.filter((a) => !(a.nombre && anuladas.has(a.nombre)));
            const candidatos = elegibles.length > 0 ? elegibles : args;
            return Math.min(...candidatos.map((a) => a.valor));
          }
          next();
          const key = tok.toUpperCase();
          if (!(key in vars)) throw new Error('Variable desconocida: ' + tok);
          return vars[key];
        }
        next();
        const n = Number(tok);
        if (Number.isNaN(n)) throw new Error('Token numérico inválido: ' + tok);
        return n;
      }
      const resultado = parseExpr();
      if (pos !== tokens.length) throw new Error('Fórmula mal formada');
      return resultado;
    }
```

- [ ] **Step 2: Verify the MIN(...) fix with a temp-file Node check**

This is browser-only JS with no permanent test file (per `CONTRIBUTING.md#por-qué-hay-código-duplicado` — verify manually via a temp file, don't create a permanent duplicate copy). Write this exact temp file (it's the same `normalizar`/`tokenize`/`evaluarFormula` code from Step 1, plus three assertions), run it, then delete it:

```bash
cat > /tmp/verificar-min-anuladas.js <<'EOF'
function normalizar(expr) {
  return expr.replace(/(\d)\s*\.\s*([A-Za-z])/g, '$1*$2');
}
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const s = normalizar(expr);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/(),'.includes(c)) { tokens.push(c); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push(s.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      tokens.push(s.slice(i, j)); i = j; continue;
    }
    throw new Error('Carácter inesperado en fórmula: ' + c);
  }
  return tokens;
}
function evaluarFormula(expr, vars, anuladas) {
  anuladas = anuladas || new Set();
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseExpr() {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }
  function parseTerm() {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }
  function parseArgConNombre() {
    const tok = peek();
    let nombre = null;
    if (tok !== undefined && /^[A-Za-z]/.test(tok) && tok.toUpperCase() !== 'MIN') {
      const siguiente = tokens[pos + 1];
      if (siguiente === ',' || siguiente === ')') nombre = tok.toUpperCase();
    }
    const valor = parseExpr();
    return { valor, nombre };
  }
  function parseFactor() {
    const tok = peek();
    if (tok === undefined) throw new Error('Fórmula incompleta');
    if (tok === '-') { next(); return -parseFactor(); }
    if (tok === '(') {
      next();
      const value = parseExpr();
      if (next() !== ')') throw new Error('Falta paréntesis de cierre');
      return value;
    }
    if (/^[A-Za-z]/.test(tok)) {
      if (tok.toUpperCase() === 'MIN') {
        next();
        if (next() !== '(') throw new Error('Se esperaba "(" después de MIN');
        const args = [parseArgConNombre()];
        while (peek() === ',') { next(); args.push(parseArgConNombre()); }
        if (next() !== ')') throw new Error('Falta paréntesis de cierre en MIN');
        const elegibles = args.filter((a) => !(a.nombre && anuladas.has(a.nombre)));
        const candidatos = elegibles.length > 0 ? elegibles : args;
        return Math.min(...candidatos.map((a) => a.valor));
      }
      next();
      const key = tok.toUpperCase();
      if (!(key in vars)) throw new Error('Variable desconocida: ' + tok);
      return vars[key];
    }
    next();
    const n = Number(tok);
    if (Number.isNaN(n)) throw new Error('Token numérico inválido: ' + tok);
    return n;
  }
  const resultado = parseExpr();
  if (pos !== tokens.length) throw new Error('Fórmula mal formada');
  return resultado;
}

console.log('a)', evaluarFormula('N1+N2+N3+N4-MIN(N1,N2,N3,N4)', {N1:1,N2:5,N3:9,N4:3}, new Set()));
console.log('b)', evaluarFormula('N1+N2+N3+N4-MIN(N1,N2,N3,N4)', {N1:1,N2:5,N3:9,N4:3}, new Set(['N1'])));
console.log('c)', evaluarFormula('MIN(N1,N2)', {N1:1,N2:2}, new Set(['N1','N2'])));
EOF
node /tmp/verificar-min-anuladas.js
rm /tmp/verificar-min-anuladas.js
```

Expected output (verified by running this exact script during plan-writing):

```text
a) 17
b) 15
c) 1
```

- `a) 17`: sum 1+5+9+3=18, MIN(1,5,9,3)=1, 18-1=17 — no anuladas, behaves exactly like before this change.
- `b) 15`: same sum=18, but N1 is excluded from MIN's candidates since it's anulada — MIN among N2,N3,N4 = 3, 18-3=15.
- `c) 1`: MIN(1,2) with both N1 and N2 anuladas — no eligible candidate left, falls back to the normal min over everyone = 1.

If the printed values don't match, the argument-name-tracking logic has a bug — re-check `parseArgConNombre` before moving on.

- [ ] **Step 3: Commit**

```bash
git add public/simulador.html
git commit -m "El simulador nunca deja que una nota 0A sea la que MIN() descarta"
```

---

### Task 3: Simulador — chips NSP/0A, fórmulas visibles y desglose de PP

**Files:**
- Modify: `public/simulador.html` (CSS block and the "Página" script section)

- [ ] **Step 1: Add CSS for chips, disabled inputs, formula text and the PP warning**

Insert after the existing `.badge { font-weight: 600; }` rule (before `#resultado {`):

```css
  .grupo-input { display: flex; gap: 6px; align-items: center; }
  .grupo-input input { width: 60px; }
  .grupo-input input:disabled {
    opacity: 0.5;
    background: var(--tg-theme-secondary-bg-color, #e8e8e8);
  }
  .chip {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--tg-theme-hint-color, #cccccc);
    background: var(--tg-theme-bg-color, #ffffff);
    color: var(--tg-theme-text-color, #111111);
    font-size: 12px;
    cursor: pointer;
  }
  .chip.activo { border-color: #d64545; background: #d64545; color: #ffffff; }
  .formula {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    background: var(--tg-theme-secondary-bg-color, #f2f2f2);
    padding: 8px 10px;
    border-radius: 8px;
    word-break: break-all;
  }
  .nota-pp { display: block; font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  .aviso { font-size: 13px; margin: 8px 0 0; text-align: left; font-weight: 600; }
```

- [ ] **Step 2: Replace the "Página" section**

Replace everything from the `// --- Página ---` comment to the end of the `<script>` block with:

```js
    // --- Página ---
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    const params = new URLSearchParams(location.search);
    const curso = params.get('curso');

    const contenidoEl = document.getElementById('contenido');
    const resultadoEl = document.getElementById('resultado');
    const errorEl = document.getElementById('error');
    const tituloEl = document.getElementById('titulo');
    const subtituloEl = document.getElementById('subtitulo');

    function mostrarError(msg) {
      errorEl.textContent = msg;
    }

    function limpiar(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    function crearFila(etiquetaTexto, nodoValor) {
      const fila = document.createElement('div');
      fila.className = 'fila';
      const etiqueta = document.createElement('span');
      etiqueta.textContent = etiquetaTexto;
      fila.appendChild(etiqueta);
      fila.appendChild(nodoValor);
      return fila;
    }

    // 🟢 si el valor es un número >= 10, 🔴 en cualquier otro caso (incluye
    // "0A" y "NSP", que Number() convierte en NaN).
    function emoji(valor) {
      const n = Number(valor);
      return !Number.isNaN(n) && n >= NOTA_APROBATORIA ? '🟢' : '🔴';
    }

    // Fila de una evaluación pendiente: input numérico + chips NSP/0A. Tocar
    // un chip fija esa fila en modo "valor especial" (input deshabilitado,
    // cuenta como 0 en el cálculo); tocarlo de nuevo o tocar el input vuelve
    // a modo numérico. NSP/0A no se guardan como texto en el input — se
    // guardan en input.dataset.modo, que calcular() interpreta.
    function crearFilaPendiente(ev) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '20';
      input.step = '0.5';
      input.placeholder = '0-20';
      input.dataset.variable = ev.variable;
      input.dataset.modo = 'numero';

      const chipNSP = document.createElement('button');
      chipNSP.type = 'button';
      chipNSP.className = 'chip';
      chipNSP.textContent = 'NSP';

      const chip0A = document.createElement('button');
      chip0A.type = 'button';
      chip0A.className = 'chip';
      chip0A.textContent = '0A';

      function activarModo(modo) {
        input.dataset.modo = modo;
        input.disabled = modo !== 'numero';
        if (modo !== 'numero') input.value = '';
        chipNSP.classList.toggle('activo', modo === 'NSP');
        chip0A.classList.toggle('activo', modo === '0A');
        input.dispatchEvent(new Event('input'));
      }

      chipNSP.addEventListener('click', () => activarModo(input.dataset.modo === 'NSP' ? 'numero' : 'NSP'));
      chip0A.addEventListener('click', () => activarModo(input.dataset.modo === '0A' ? 'numero' : '0A'));
      input.addEventListener('focus', () => {
        if (input.dataset.modo !== 'numero') activarModo('numero');
      });

      const grupo = document.createElement('div');
      grupo.className = 'grupo-input';
      grupo.appendChild(input);
      grupo.appendChild(chipNSP);
      grupo.appendChild(chip0A);

      return { fila: crearFila(ev.descripcion, grupo), input };
    }

    if (!curso) {
      mostrarError('Falta indicar el curso. Abre este formulario desde /simular en el bot.');
    } else {
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, curso }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) { mostrarError(data.error || 'No se pudo cargar.'); return; }
          render(data);
        })
        .catch(() => mostrarError('Error de red, intenta de nuevo.'));
    }

    function render(data) {
      tituloEl.textContent = data.nombre; // texto plano, sin HTML
      subtituloEl.textContent = data.pending.length > 0 || data.sustitutorio
        ? 'Las notas con fecha ya registrada quedan fijas. Completa las pendientes para simular tu nota final.'
        : 'Todas tus notas de este curso ya están registradas.';

      limpiar(contenidoEl);

      if (data.locked.length > 0) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Ya registradas';
        contenidoEl.appendChild(h2);
        for (const ev of data.locked) {
          const badge = document.createElement('span');
          badge.className = 'badge ' + (emoji(ev.valor) === '🟢' ? 'verde' : 'rojo');
          badge.textContent = ev.valor;
          contenidoEl.appendChild(crearFila(ev.descripcion, badge));
        }
      }

      const filas = [];
      if (data.pending.length > 0) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Pendientes (simula tu nota)';
        contenidoEl.appendChild(h2);
        for (const ev of data.pending) {
          const filaInfo = crearFilaPendiente(ev);
          contenidoEl.appendChild(filaInfo.fila);
          filas.push(filaInfo);
        }
      }

      let esInput = null;
      if (data.sustitutorio) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Examen Sustitutorio (opcional)';
        contenidoEl.appendChild(h2);
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'Si lo rindes, reemplaza tu peor nota entre Parcial y Final — solo si te conviene.';
        contenidoEl.appendChild(hint);
        esInput = document.createElement('input');
        esInput.type = 'number';
        esInput.min = '0';
        esInput.max = '20';
        esInput.step = '0.5';
        esInput.placeholder = '0-20';
        contenidoEl.appendChild(crearFila(data.sustitutorio.descripcion, esInput));
        esInput.addEventListener('input', () => calcular(data, filas, esInput));
      }

      if (data.formulas && (data.formulas.practicas || data.formulas.teoria)) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Fórmulas de este curso';
        contenidoEl.appendChild(h2);
        if (data.formulas.practicas) {
          const p = document.createElement('p');
          p.className = 'formula';
          p.textContent = 'Prácticas (PP): ' + data.formulas.practicas;
          contenidoEl.appendChild(p);
        }
        if (data.formulas.teoria) {
          const p = document.createElement('p');
          p.className = 'formula';
          p.textContent = 'Nota final: ' + data.formulas.teoria;
          contenidoEl.appendChild(p);
        }
      }

      filas.forEach(({ input }) => input.addEventListener('input', () => calcular(data, filas, esInput)));
      calcular(data, filas, esInput);
    }

    function calcular(data, filas, esInput) {
      const vars = Object.assign({}, data.vars);
      const anuladas = new Set(data.anuladas || []);
      for (const { input } of filas) {
        if (input.dataset.modo === 'numero') {
          const val = input.value.trim();
          if (val === '') { limpiar(resultadoEl); return; }
          const n = Number(val);
          if (Number.isNaN(n) || n < 0 || n > 20) { limpiar(resultadoEl); return; }
          vars[input.dataset.variable] = n;
        } else {
          vars[input.dataset.variable] = 0;
          if (input.dataset.modo === '0A') anuladas.add(input.dataset.variable);
        }
      }
      let valorES = null;
      if (esInput && esInput.value.trim() !== '') {
        const n = Number(esInput.value.trim());
        if (Number.isNaN(n) || n < 0 || n > 20) { limpiar(resultadoEl); return; }
        valorES = n;
      }
      calcularConVars(data, vars, valorES, anuladas);
    }

    function calcularConVars(data, vars, valorES, anuladas) {
      try {
        let pp = null;
        if (data.formulas.practicas) {
          pp = evaluarFormula(data.formulas.practicas, vars, anuladas);
          vars.PP = pp;
        }
        const final = evaluarFormula(data.formulas.teoria, vars, anuladas);
        const aprueba = final >= NOTA_APROBATORIA;

        let mejorConES = null;
        if (valorES !== null && 'EP' in vars && 'EF' in vars) {
          const conEPReemplazada = evaluarFormula(data.formulas.teoria, Object.assign({}, vars, { EP: valorES }), anuladas);
          const conEFReemplazada = evaluarFormula(data.formulas.teoria, Object.assign({}, vars, { EF: valorES }), anuladas);
          const mejor = Math.max(conEPReemplazada, conEFReemplazada);
          if (mejor > final) mejorConES = mejor;
        }

        limpiar(resultadoEl);

        if (pp !== null) {
          const ppSpan = document.createElement('span');
          ppSpan.className = 'nota-pp ' + (pp >= NOTA_APROBATORIA ? 'verde' : 'rojo');
          ppSpan.textContent = 'PP: ' + pp.toFixed(2);
          resultadoEl.appendChild(ppSpan);
          if (pp < 6) {
            const aviso = document.createElement('p');
            aviso.className = 'aviso';
            aviso.textContent = '⚠️ Promedio de Prácticas menor a 6 — revisa si puedes rendir el examen o necesitas Sustitutorio.';
            resultadoEl.appendChild(aviso);
          }
        }

        const notaSpan = document.createElement('span');
        notaSpan.className = 'nota ' + (aprueba ? 'verde' : 'rojo');
        notaSpan.textContent = final.toFixed(2);
        const msgSpan = document.createElement('span');
        msgSpan.textContent = (aprueba ? '✅ Aprobarías' : '❌ No alcanzaría') + ' (nota final aproximada)';
        resultadoEl.appendChild(notaSpan);
        resultadoEl.appendChild(msgSpan);

        if (mejorConES !== null) {
          const mejorAprueba = mejorConES >= NOTA_APROBATORIA;
          const br = document.createElement('br');
          resultadoEl.appendChild(br);
          const esSpan = document.createElement('span');
          esSpan.className = 'nota ' + (mejorAprueba ? 'verde' : 'rojo');
          esSpan.style.fontSize = '20px';
          esSpan.textContent = mejorConES.toFixed(2);
          const esMsg = document.createElement('span');
          esMsg.textContent = ' rindiendo el Sustitutorio (te conviene)';
          resultadoEl.appendChild(esSpan);
          resultadoEl.appendChild(esMsg);
        }
      } catch (err) {
        limpiar(resultadoEl);
        mostrarError('No pude calcular: ' + err.message);
      }
    }
```

- [ ] **Step 3: Verify syntax**

```bash
sed -n '/<script>/,/<\/script>/p' public/simulador.html | sed '1d;$d' > /tmp/verificar-simulador.js
node --check /tmp/verificar-simulador.js
rm /tmp/verificar-simulador.js
```

Expected: `node --check` prints no output (exit 0).

- [ ] **Step 4: Manual browser check**

Open `public/simulador.html` locally (or deploy to a preview) with `?curso=XXX` for a real course that has pending evaluations and a `MIN(...)`-based `practicas` formula. Confirm:
- Clicking `NSP` on a pending row disables its input and recalculates.
- Clicking `0A` on a pending row disables its input, recalculates, and (if that variable would otherwise be the dropped one) the final grade changes to reflect it counting as a real 0 instead of being dropped.
- Clicking the active chip again re-enables the input.
- The formulas section shows the raw `practicas`/`teoria` text.
- The result shows a separate `PP: X.XX` line.
- Setting inputs so `PP < 6` shows the warning text; `PP >= 6` doesn't.

- [ ] **Step 5: Commit**

```bash
git add public/simulador.html
git commit -m "Agrega chips NSP/0A, fórmulas visibles y desglose de PP al simulador"
```

---

### Task 4: Registro — mostrar/ocultar contraseña, validación en vivo, bloqueo durante envío

**Files:**
- Modify: `public/registro.html` (full file replacement — CSS, markup and script all change together)

- [ ] **Step 1: Replace the entire file**

```html
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Registro INTRALU</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 24px 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #ffffff);
    color: var(--tg-theme-text-color, #111111);
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.hint {
    font-size: 13px;
    color: var(--tg-theme-hint-color, #888888);
    margin: 0 0 24px;
    line-height: 1.4;
  }
  label {
    display: block;
    font-size: 13px;
    color: var(--tg-theme-hint-color, #888888);
    margin: 16px 0 6px;
  }
  .campo { position: relative; }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px 14px;
    font-size: 16px;
    border-radius: 10px;
    border: 1px solid var(--tg-theme-hint-color, #cccccc);
    background: var(--tg-theme-secondary-bg-color, #f2f2f2);
    color: var(--tg-theme-text-color, #111111);
  }
  input.valido { border-color: #34a853; }
  input.invalido { border-color: #e05353; }
  input:disabled { opacity: 0.6; }
  #password { padding-right: 44px; }
  .alternar-clave {
    position: absolute;
    right: 6px;
    top: 6px;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    font-size: 16px;
    cursor: pointer;
    color: var(--tg-theme-hint-color, #888888);
  }
  #status {
    margin-top: 20px;
    font-size: 14px;
    min-height: 20px;
  }
  #status.error { color: #e05353; }
  #status.ok { color: #34a853; }
</style>
</head>
<body>
  <h1>Registrar mi usuario de INTRALU</h1>
  <p class="hint">
    🔒 Tu contraseña se cifra al llegar al servidor y nunca queda como
    mensaje de texto en el chat.
  </p>

  <form id="form">
    <label for="codigo">Código UNI</label>
    <div class="campo">
      <input id="codigo" name="codigo" type="text" autocomplete="username" placeholder="20201234A" required />
    </div>

    <label for="password">Contraseña de INTRALU</label>
    <div class="campo">
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="button" class="alternar-clave" id="alternarClave" aria-label="Mostrar contraseña">👁</button>
    </div>
  </form>

  <div id="status"></div>

  <script>
    const API_URL = 'https://dfitaqdfkcxeroisjeic.supabase.co/functions/v1/registro-webapp';

    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    const form = document.getElementById('form');
    const statusEl = document.getElementById('status');
    const codigoEl = document.getElementById('codigo');
    const passwordEl = document.getElementById('password');
    const alternarClaveEl = document.getElementById('alternarClave');

    alternarClaveEl.addEventListener('click', () => {
      const oculta = passwordEl.type === 'password';
      passwordEl.type = oculta ? 'text' : 'password';
      alternarClaveEl.textContent = oculta ? '🙈' : '👁';
      alternarClaveEl.setAttribute('aria-label', oculta ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });

    function marcarValidez(input) {
      const valido = input.value.trim().length > 0;
      input.classList.toggle('valido', valido);
      input.classList.toggle('invalido', !valido && input.dataset.tocado === '1');
    }

    [codigoEl, passwordEl].forEach((input) => {
      input.addEventListener('input', () => {
        input.dataset.tocado = '1';
        marcarValidez(input);
      });
      input.addEventListener('blur', () => {
        input.dataset.tocado = '1';
        marcarValidez(input);
      });
    });

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = kind || '';
    }

    function validar() {
      return codigoEl.value.trim().length > 0 && passwordEl.value.length > 0;
    }

    function bloquearFormulario(bloqueado) {
      codigoEl.disabled = bloqueado;
      passwordEl.disabled = bloqueado;
      alternarClaveEl.disabled = bloqueado;
    }

    async function enviar() {
      codigoEl.dataset.tocado = '1';
      passwordEl.dataset.tocado = '1';
      marcarValidez(codigoEl);
      marcarValidez(passwordEl);

      if (!validar()) {
        setStatus('Completa código y contraseña.', 'error');
        return;
      }
      bloquearFormulario(true);
      tg.MainButton.showProgress();
      setStatus('Registrando...', '');
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            codigo: codigoEl.value.trim(),
            password: passwordEl.value,
            initData: tg.initData,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          setStatus('✅ Registrado. Puedes cerrar esta ventana.', 'ok');
          tg.MainButton.hideProgress();
          setTimeout(() => tg.close(), 1200);
        } else {
          setStatus('❌ ' + (data.error || 'No se pudo registrar.'), 'error');
          tg.MainButton.hideProgress();
          bloquearFormulario(false);
        }
      } catch (err) {
        setStatus('❌ Error de red, intenta de nuevo.', 'error');
        tg.MainButton.hideProgress();
        bloquearFormulario(false);
      }
    }

    tg.MainButton.setText('Registrarme');
    tg.MainButton.show();
    tg.MainButton.onClick(enviar);
    form.addEventListener('submit', (e) => { e.preventDefault(); enviar(); });
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify syntax**

```bash
sed -n '/<script>/,/<\/script>/p' public/registro.html | sed '1d;$d' > /tmp/verificar-registro.js
node --check /tmp/verificar-registro.js
rm /tmp/verificar-registro.js
```

Expected: `node --check` prints no output (exit 0).

- [ ] **Step 3: Manual browser check**

Open `public/registro.html` locally. Confirm:
- The 👁 icon toggles the password field between hidden/visible text and swaps to 🙈 when visible.
- Typing in either field turns its border green once non-empty; clearing a touched field turns it red.
- Clicking "Registrarme" with both fields disables them and shows "Registrando..." (network call will fail locally without a real backend — that's expected, just confirm the disabled/enabled states around it).

- [ ] **Step 4: Commit**

```bash
git add public/registro.html
git commit -m "Pule el formulario de registro: ver contraseña, validación en vivo, bloqueo durante el envío"
```

---

### Task 5: Bot — `check-all-users.js` manda botones y el snapshot inicial

**Files:**
- Modify: `check-all-users.js:1-19` (new constants), `:28-34` (sendTelegram), `:141-151` (deactivation message), `:108-124` (seeded/snapshot logic), `:136` (log line)

- [ ] **Step 1: Add the registration button helper and extend `sendTelegram`**

Replace:

```js
async function sendTelegram(token, chatId, text) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}
```

with:

```js
const PAGES_BASE = 'https://alexis0800.github.io/uni-notas-watcher';
const REGISTRO_WEBAPP_URL = `${PAGES_BASE}/registro.html`;

function botonRegistrar() {
  return {
    inline_keyboard: [[{ text: '📝 Registrarme', web_app: { url: REGISTRO_WEBAPP_URL } }]],
  };
}

async function sendTelegram(token, chatId, text, replyMarkup) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
```

- [ ] **Step 2: Send the registration button with the deactivation warning**

Replace:

```js
    if (failures >= FAILURE_THRESHOLD) {
      await sendTelegram(
        telegramToken,
        chat_id,
        '⚠️ No pude iniciar sesión en INTRALU con tus credenciales varias veces seguidas. Te desactivé del watcher — usa /registrar para volver a intentarlo.',
      ).catch(() => {});
```

with:

```js
    if (failures >= FAILURE_THRESHOLD) {
      await sendTelegram(
        telegramToken,
        chat_id,
        '⚠️ No pude iniciar sesión en INTRALU con tus credenciales varias veces seguidas. Te desactivé del watcher — usa /registrar para volver a intentarlo.',
        botonRegistrar(),
      ).catch(() => {});
```

- [ ] **Step 3: Send the current-grades snapshot on the first check instead of staying silent**

Replace:

```js
    // Primer chequeo tras registrarse: guarda el estado base sin notificar,
    // para no avisar "nota nueva" de notas que la persona ya tenía antes.
    let cambios = [];
    if (seeded) {
      const previousMap = last_grades || {};
      for (const [key, ev] of Object.entries(currentMap)) {
        const prev = previousMap[key];
        if (!prev || prev.valor !== ev.valor) cambios.push(ev);
      }
    }

    if (cambios.length > 0) {
      await sendTelegram(
        telegramToken,
        chat_id,
        `🎓 Nueva(s) nota(s) en INTRALU:\n\n${agruparPorCurso(cambios)}`,
      );
    }
```

with:

```js
    // Primer chequeo tras registrarse: en vez de guardar el estado en
    // silencio, manda un snapshot de las notas que ya hay hasta ahora.
    let cambios = [];
    if (seeded) {
      const previousMap = last_grades || {};
      for (const [key, ev] of Object.entries(currentMap)) {
        const prev = previousMap[key];
        if (!prev || prev.valor !== ev.valor) cambios.push(ev);
      }
      if (cambios.length > 0) {
        await sendTelegram(
          telegramToken,
          chat_id,
          `🎓 Nueva(s) nota(s) en INTRALU:\n\n${agruparPorCurso(cambios)}`,
        );
      }
    } else {
      const todas = Object.values(currentMap);
      await sendTelegram(
        telegramToken,
        chat_id,
        todas.length > 0
          ? `📋 Estas son tus notas actuales en INTRALU:\n\n${agruparPorCurso(todas)}\n\nDesde ahora te aviso cuando aparezca algo nuevo.`
          : 'Todavía no tienes notas registradas en INTRALU para este ciclo. Desde ahora te aviso cuando aparezca algo nuevo.',
      );
    }
```

- [ ] **Step 4: Update the log line to match**

Replace:

```js
    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'estado base guardado'}`);
```

with:

```js
    console.log(`✅ ${chat_id} (${codigo_uni}): ${seeded ? `${cambios.length} nota(s) nueva(s)` : 'snapshot inicial enviado'}`);
```

- [ ] **Step 5: Verify syntax**

```bash
node --check check-all-users.js
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add check-all-users.js
git commit -m "El bot manda un snapshot de notas en la primera revisión y el botón de registro cuando se desactiva"
```

---

### Task 6: Bot — `telegram-webhook`: mensaje nuevo, botón en `/estado`, chequeo inmediato

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts:40-56` (new function), `:196-201` (registration success message), `:206-221` (`/estado`)

- [ ] **Step 1: Add the immediate-dispatch helper**

Insert after `deleteMessage` (after its closing `}`, before `function botonRegistrar()`):

```ts
// Dispara la corrida de check-grade.yml ya mismo en vez de esperar a la
// cadena de 5 min — best-effort: si falla (falta el secret, GitHub no
// responde), el registro ya se guardó bien igual, y la cadena normal lo
// recoge de todas formas (ver docs/SCALING.md).
async function dispararChequeoInmediato() {
  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) return;
  try {
    await fetch(
      'https://api.github.com/repos/Alexis0800/uni-notas-watcher/actions/workflows/check-grade.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );
  } catch {
    // best-effort, no pasa nada si falla
  }
}
```

- [ ] **Step 2: Call it and rewrite the confirmation message on successful registration**

Replace:

```ts
      if (error) {
        console.error(error);
        await sendMessage(chatId, '❌ No pude guardar tu registro, intenta de nuevo en un rato.');
      } else {
        await sendMessage(
          chatId,
          `✅ Registrado con código ${codigo.toUpperCase()}. En los próximos minutos hago la primera revisión para guardar tu estado actual (sin avisarte nada todavía) — si tu código o contraseña están mal, te aviso aquí. Desde la revisión siguiente ya te aviso solo de notas nuevas de verdad.`,
        );
      }
```

with:

```ts
      if (error) {
        console.error(error);
        await sendMessage(chatId, '❌ No pude guardar tu registro, intenta de nuevo en un rato.');
      } else {
        await dispararChequeoInmediato();
        await sendMessage(
          chatId,
          `✅ Registrado con código <b>${codigo.toUpperCase()}</b>.\n\nYa estoy revisando tus notas — te mando tu estado actual por acá en cuanto termine.\nSi tu código o contraseña están mal, te aviso aquí también.`,
        );
      }
```

- [ ] **Step 3: Attach the registration button to `/estado` when inactive**

Replace:

```ts
  } else if (text === '/estado') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const evaluaciones = Object.keys(data.last_grades ?? {}).length;
      await sendMessage(
        chatId,
        [
          `Código: ${data.codigo_uni}`,
          `Activo: ${data.active ? 'sí' : 'no (tu contraseña parece estar mal, usa /registrar de nuevo)'}`,
          `Evaluaciones registradas: ${evaluaciones}`,
          `Última actualización: ${formatearFecha(data.updated_at)}`,
        ].join('\n'),
      );
    }
```

with:

```ts
  } else if (text === '/estado') {
    const { data } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).maybeSingle();
    if (!data) {
      await sendMessage(chatId, 'No estás registrado.', botonRegistrar());
    } else {
      const evaluaciones = Object.keys(data.last_grades ?? {}).length;
      await sendMessage(
        chatId,
        [
          `Código: ${data.codigo_uni}`,
          `Activo: ${data.active ? 'sí' : 'no (tu contraseña parece estar mal)'}`,
          `Evaluaciones registradas: ${evaluaciones}`,
          `Última actualización: ${formatearFecha(data.updated_at)}`,
        ].join('\n'),
        data.active ? undefined : botonRegistrar(),
      );
    }
```

- [ ] **Step 4: Verify with Deno's type checker and linter**

```bash
cd "supabase/functions/telegram-webhook"
deno check --no-config index.ts
deno lint --no-config index.ts
```
Expected: both exit with no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "Chequeo casi-inmediato al registrarse, mensaje de confirmación más claro, botón en /estado inactivo"
```

---

### Task 7: Documentación de despliegue — nuevo secret y mensajes actualizados

**Files:**
- Modify: `docs/DEPLOYMENT.md:138-157` (Paso 8 y Paso 9)

- [ ] **Step 1: Document both dispatch tokens and update the "what happens after registering" description**

Replace:

```markdown
## Paso 8 — GitHub Secrets y activar el chequeo periódico

En tu repo → **Settings → Secrets and variables → Actions**, crea:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CREDENTIALS_ENCRYPTION_KEY`
- `TELEGRAM_TOKEN`

Pestaña **Actions** → workflow **Check grade** → **Run workflow** para
probarlo manualmente. Con 0 usuarios registrados debería terminar en
verde diciendo "Revisando 0 usuario(s) activo(s)... Listo." Después
queda corriendo solo cada 5 minutos ([`.github/workflows/check-grade.yml`](../.github/workflows/check-grade.yml)).

## Paso 9 — Probar

Escríbele a tu bot `/start` → toca **Registrarme** → completa el
formulario con tu propio usuario de INTRALU. En los siguientes 5
minutos debería llegarte una revisión silenciosa (estado base) y desde
la segunda, avisos reales de notas nuevas.
```

with:

```markdown
## Paso 8 — GitHub Secrets y activar el chequeo periódico

En tu repo → **Settings → Secrets and variables → Actions**, crea:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CREDENTIALS_ENCRYPTION_KEY`
- `TELEGRAM_TOKEN`
- `WORKFLOW_DISPATCH_TOKEN` — un [fine-grained Personal Access Token](https://github.com/settings/tokens?type=beta)
  con acceso *solo* a este repo y permiso "Actions: Read and write".
  Sin este secret el chequeo periódico igual funciona, pero solo dispara
  cada ~1h (el `schedule` nativo de GitHub Actions no es confiable para
  intervalos de 5 min — ver [`docs/SCALING.md`](SCALING.md)); con él,
  cada corrida se auto-encadena a la siguiente cada 5 min de verdad.

Pestaña **Actions** → workflow **Check grade** → **Run workflow** para
probarlo manualmente. Con 0 usuarios registrados debería terminar en
verde diciendo "Revisando 0 usuario(s) activo(s)... Listo." Con el
secret configurado, queda encadenándose solo cada 5 min
([`.github/workflows/check-grade.yml`](../.github/workflows/check-grade.yml)).

**Opcional — chequeo casi-inmediato al registrarse**: agrega el mismo
valor del token de arriba como secret de **Supabase** (no de GitHub):

```bash
pnpm dlx supabase secrets set GITHUB_DISPATCH_TOKEN=el-mismo-token-de-arriba
```

Con esto, `telegram-webhook` dispara una corrida apenas alguien se
registra, en vez de esperar a la próxima corrida encadenada. Es
opcional — sin este secret el registro funciona igual, solo que la
primera revisión llega en la corrida siguiente en vez de casi al toque.

## Paso 9 — Probar

Escríbele a tu bot `/start` → toca **Registrarme** → completa el
formulario con tu propio usuario de INTRALU. Deberías recibir la
confirmación de registro casi al toque, y minutos después (o casi
inmediato si configuraste `GITHUB_DISPATCH_TOKEN`) un mensaje con tus
notas actuales. Desde ahí, avisos reales cada vez que aparezca algo
nuevo.
```

- [ ] **Step 2: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "Documenta WORKFLOW_DISPATCH_TOKEN y GITHUB_DISPATCH_TOKEN en la guía de despliegue"
```

---

### Task 8: Verificación final end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Add the new Supabase secret**

```bash
pnpm dlx supabase secrets set GITHUB_DISPATCH_TOKEN=<mismo-valor-que-WORKFLOW_DISPATCH_TOKEN>
```

- [ ] **Step 2: Deploy the two changed Edge Functions**

```bash
pnpm dlx supabase functions deploy telegram-webhook --no-verify-jwt
pnpm dlx supabase functions deploy simular-datos --no-verify-jwt
```

- [ ] **Step 3: Push to `main`**

```bash
git push origin main
```
This triggers `deploy-pages.yml`, publishing the updated `registro.html`/`simulador.html`.

- [ ] **Step 4: Real registration flow, real Telegram chat**

1. Send `/registrar` to the bot, complete the form with a real INTRALU account.
2. Confirm the new short confirmation message arrives immediately.
3. Confirm a `📋 Estas son tus notas actuales...` (or the "no grades yet" variant) message arrives within roughly a minute — not the old "en los próximos minutos" wait.
4. Send `/estado`. If credentials are ever intentionally broken to force `active: false`, confirm the registration button appears alongside the text.

- [ ] **Step 5: Simulator, real course with a `MIN(...)` practicas formula**

1. Open `/simular`, pick a course with pending evaluations.
2. Toggle NSP and 0A chips on different pending rows, confirm the numeric input disables/enables correctly and the result recalculates each time.
3. Confirm the formulas section shows the real formula text and the result shows a separate `PP: X.XX` line with its own 🟢/🔴.
4. Drive `PP` below 6 with test inputs, confirm the warning text appears; above 6, confirm it doesn't.

- [ ] **Step 6: Light/dark check on both Mini Apps**

Open both `registro.html` and `simulador.html` inside Telegram with the device set to light mode, then dark mode. Confirm the chips, disabled-input styling, and formula text block stay readable in both.
