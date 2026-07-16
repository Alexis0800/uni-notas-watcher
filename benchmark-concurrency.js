require('dotenv').config();
const { login, fetchCursosMatriculados, fetchEvaluaciones } = require('./lib/session');

// Mide cuánto tarda un chequeo completo (login + cursos + notas, igual que
// checkUser() en check-all-users.js) a distintos niveles de concurrencia,
// usando la misma cuenta real (UNI_CODIGO/UNI_PASSWORD en .env) logueada en
// paralelo varias veces. Responde la pregunta abierta en docs/SCALING.md:
// ¿el tiempo por usuario se mantiene ~14s con más solicitudes en paralelo,
// o INTRALU se pone más lento bajo carga concurrente?
//
// OJO: esto genera tráfico real contra alumnos.uni.edu.pe. Corre esto una
// vez para tener un dato real — no lo automatices ni lo dejes en un cron.
// Niveles conservadores (1, 3, 5): no hace falta llegar a 15 para ver si
// hay degradación, y no tiene sentido golpear el sitio real más de lo
// necesario para responder la pregunta.

const LEVELS = [1, 3, 5];

async function timedCheck() {
  const start = Date.now();
  const client = await login(process.env.UNI_CODIGO, process.env.UNI_PASSWORD);
  const { codper, csrfToken, cursos } = await fetchCursosMatriculados(client);
  for (const curso of cursos) {
    await fetchEvaluaciones(client, csrfToken, { codper, ...curso });
  }
  return Date.now() - start;
}

async function main() {
  if (!process.env.UNI_CODIGO || !process.env.UNI_PASSWORD) {
    console.error('❌ Falta UNI_CODIGO o UNI_PASSWORD en .env');
    process.exit(1);
  }

  console.log('Midiendo tiempo por chequeo completo (login + cursos + notas) a distinta concurrencia, misma cuenta en paralelo.\n');

  for (const level of LEVELS) {
    const results = await Promise.allSettled(Array.from({ length: level }, timedCheck));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.length - ok.length;
    const avg = ok.length ? (ok.reduce((a, b) => a + b, 0) / ok.length / 1000).toFixed(1) : 'N/A';
    const max = ok.length ? (Math.max(...ok) / 1000).toFixed(1) : 'N/A';
    console.log(
      `Concurrencia ${level}: ${ok.length}/${level} OK — promedio ${avg}s, máximo ${max}s` +
        (failed ? ` — ⚠️ ${failed} falló(s): ${results.find((r) => r.status === 'rejected')?.reason?.message}` : ''),
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
