require('dotenv').config();
const { login, fetchCursosMatriculados } = require('./lib/session');

async function main() {
  const codigo = process.env.UNI_CODIGO;
  const password = process.env.UNI_PASSWORD;
  if (!codigo || !password) {
    console.error('❌ Falta UNI_CODIGO o UNI_PASSWORD en .env');
    process.exit(1);
  }

  try {
    const client = await login(codigo, password);
    console.log('✅ Login parece exitoso.');

    const { codper, cursos } = await fetchCursosMatriculados(client);
    console.log(`✅ Periodo actual: ${codper}, ${cursos.length} curso(s) matriculado(s):`);
    for (const c of cursos) console.log(`   - ${c.codcur}-${c.seccion}: ${c.nombre}`);
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

main();
