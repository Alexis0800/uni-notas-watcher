// API para la Mini App del simulador (docs/simulador.html). Recibe
// { initData, curso } y devuelve, para ese curso y ese chat_id: las
// evaluaciones ya fijas (con fecha de registro — no editables) y las
// pendientes (sin fecha, editables), más las fórmulas para que el cálculo
// en vivo lo haga el navegador. Nunca escribe nada, solo lee.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyInitData } from './init-data.ts';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

type EvaluacionCurso = {
  variable: string;
  descripcion: string;
  nota: number | null;
  anulada: boolean;
  valor: string | null;
  fecha: string | null;
};
type CursoMeta = {
  nombre: string;
  formulas: { practicas: string | null; teoria: string | null } | null;
  evaluaciones: EvaluacionCurso[];
};

function formulaUsaVariable(formulas: CursoMeta['formulas'], variable: string): boolean {
  const re = new RegExp(`\\b${variable}\\b`, 'i');
  return Boolean((formulas?.practicas && re.test(formulas.practicas)) || (formulas?.teoria && re.test(formulas.teoria)));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'JSON inválido' }, 400);

  const { initData, curso } = body as { initData?: string; curso?: string };
  if (!initData || !curso) return json({ ok: false, error: 'Faltan campos' }, 400);

  const verificacion = await verifyInitData(initData, TELEGRAM_TOKEN);
  if (!verificacion.ok) {
    return json({ ok: false, error: 'No se pudo verificar tu sesión de Telegram, abre el formulario de nuevo.' }, 401);
  }

  const { data, error } = await supabase
    .from('usuarios')
    .select('cursos')
    .eq('chat_id', verificacion.userId)
    .maybeSingle();

  if (error || !data) return json({ ok: false, error: 'No estás registrado.' }, 404);

  const cursos = (data.cursos ?? {}) as Record<string, CursoMeta>;
  const cursoKey = Object.keys(cursos).find((k) => k.startsWith(`${curso.toUpperCase()}-`));
  const meta = cursoKey ? cursos[cursoKey] : null;

  if (!meta) return json({ ok: false, error: 'No encontré ese curso.' }, 404);

  const locked: { descripcion: string; valor: string }[] = [];
  const vars: Record<string, number> = {};
  const pending: { variable: string; descripcion: string }[] = [];

  for (const ev of meta.evaluaciones) {
    if (ev.fecha) {
      // Fija: anulada (0A) o no se presentó (NSP) cuentan como 0 en la
      // fórmula; una nota numérica cuenta con su valor real.
      locked.push({ descripcion: ev.descripcion, valor: ev.valor ?? '—' });
      vars[ev.variable] = ev.anulada || ev.nota === null ? 0 : ev.nota;
    } else if (formulaUsaVariable(meta.formulas, ev.variable)) {
      pending.push({ variable: ev.variable, descripcion: ev.descripcion });
    }
  }

  return json({ ok: true, nombre: meta.nombre, formulas: meta.formulas, vars, locked, pending });
});
