// Evalúa las fórmulas de nota que devuelve INTRALU, ej:
// "(N1 + N2 + N3 + N4- MIN(N1, N2, N3, N4))/3" o "( PP + EP + 2.EF )/  4".
// "2.EF" es la notación que usa el sitio para "2 veces EF" (no es un
// decimal) — se normaliza antes de tokenizar. Tokeniza y parsea a mano en
// vez de ejecutar el texto como código, para no correr nada arbitrario.

export type Vars = Record<string, number>;

function normalizar(expr: string): string {
  // "2.EF" / "2 . EF" -> "2*EF" (multiplicación implícita del sitio).
  // No toca decimales reales como "3.5" (dígito seguido de dígito).
  return expr.replace(/(\d)\s*\.\s*([A-Za-z])/g, '$1*$2');
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const s = normalizar(expr);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`Carácter inesperado en fórmula: "${c}"`);
  }
  return tokens;
}

export function evaluarFormula(expr: string, vars: Vars): number {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseFactor(): number {
    const tok = peek();
    if (tok === undefined) throw new Error('Fórmula incompleta');
    if (tok === '-') {
      next();
      return -parseFactor();
    }
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
        while (peek() === ',') {
          next();
          valores.push(parseExpr());
        }
        if (next() !== ')') throw new Error('Falta paréntesis de cierre en MIN');
        return Math.min(...valores);
      }
      next();
      const key = tok.toUpperCase();
      if (!(key in vars)) throw new Error(`Variable desconocida en la fórmula: ${tok}`);
      return vars[key];
    }
    next();
    const n = Number(tok);
    if (Number.isNaN(n)) throw new Error(`Token numérico inválido: ${tok}`);
    return n;
  }

  const resultado = parseExpr();
  if (pos !== tokens.length) throw new Error('Fórmula mal formada (sobran tokens)');
  return resultado;
}

// Busca el mínimo valor de `variable` (0 a 20, pasos de 0.5) que hace que
// evaluarFormula(formula, {...vars, [variable]: x}) llegue al mínimo
// aprobatorio. Es fuerza bruta acotada (41 evaluaciones), no álgebra
// simbólica — funciona igual de bien con fórmulas raras (MIN, pesos, lo que
// sea) porque solo evalúa hacia adelante, nunca intenta "despejar" la fórmula.
export function minimoParaAprobar(
  formula: string,
  vars: Vars,
  variable: string,
  minimoAprobatorio = 10,
): { alcanza: boolean; minimo: number | null; yaAprobado: boolean } {
  const conCero = evaluarFormula(formula, { ...vars, [variable]: 0 });
  if (conCero >= minimoAprobatorio) {
    return { alcanza: true, minimo: 0, yaAprobado: true };
  }
  for (let x = 0.5; x <= 20; x += 0.5) {
    const resultado = evaluarFormula(formula, { ...vars, [variable]: x });
    if (resultado >= minimoAprobatorio) {
      return { alcanza: true, minimo: x, yaAprobado: false };
    }
  }
  return { alcanza: false, minimo: null, yaAprobado: false };
}
