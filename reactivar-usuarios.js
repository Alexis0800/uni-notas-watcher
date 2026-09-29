require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Corrido a mano desde .github/workflows/reactivar-usuarios.yml. Reactiva a
// los usuarios que el watcher desactivó (active=false). /baja borra la fila,
// así que acá no hay nadie que se haya dado de baja por su cuenta.
//
// Se reactivan con seeded=false para que el próximo chequeo les mande su
// snapshot completo ("Estas son tus notas actuales") en vez de una ráfaga de
// "nota nueva" por todo lo que pasó mientras estaban desactivados. updated_at
// en ahora les da una ventana nueva de 48h antes de poder desactivarse
// (ver debeDesactivar en check-all-users.js).
//
// Solo imprime conteos: el log de Actions puede ser público.
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const soloContar = process.env.SOLO_CONTAR === 'true';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: usuarios, error } = await supabase.from('usuarios').select('id, active, codigo_uni');
  if (error) throw error;

  const inactivos = usuarios.filter((u) => !u.active);
  // Un código que INTRALU nunca va a aceptar (ej. el registro con texto
  // árabe del 2026-08-23) no vale la pena reactivarlo.
  const reactivables = inactivos.filter((u) => /^[A-Za-z0-9]{6,12}$/.test(u.codigo_uni || ''));

  console.log(`👥 Usuarios registrados: ${usuarios.length}`);
  console.log(`   Activos: ${usuarios.length - inactivos.length}`);
  console.log(`   Inactivos: ${inactivos.length} (${inactivos.length - reactivables.length} con código inválido, no se reactivan)`);

  if (soloContar || reactivables.length === 0) {
    console.log(soloContar ? 'Modo solo contar: no se cambió nada.' : 'No hay nadie que reactivar.');
    return;
  }

  const { error: updError } = await supabase
    .from('usuarios')
    .update({
      active: true,
      seeded: false,
      consecutive_failures: 0,
      network_issue_notified: false,
      updated_at: new Date().toISOString(),
    })
    .in(
      'id',
      reactivables.map((u) => u.id),
    );
  if (updError) throw updError;

  console.log(`✅ Reactivados: ${reactivables.length}. Activos ahora: ${usuarios.length - inactivos.length + reactivables.length}.`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
