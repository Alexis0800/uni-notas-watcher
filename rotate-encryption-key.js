require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { encrypt, decrypt } = require('./lib/crypto');

// Re-cifra usuarios.password_encrypted de CREDENTIALS_ENCRYPTION_KEY (vieja) a
// NEW_ENCRYPTION_KEY. Pensado para correrse desde .github/workflows/rotate-key.yml,
// que es el único sitio donde la llave vieja sigue existiendo — ninguna de las dos
// se imprime nunca.
//
// Es reanudable: cada fila se prueba primero con la llave nueva, así que si la
// corrida se corta a la mitad puedes volver a lanzarla sin dañar lo ya migrado.
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, NEW_ENCRYPTION_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !NEW_ENCRYPTION_KEY) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY o NEW_ENCRYPTION_KEY');
    process.exit(1);
  }
  if (CREDENTIALS_ENCRYPTION_KEY === NEW_ENCRYPTION_KEY) {
    console.error('❌ La llave nueva es idéntica a la vieja — no hay nada que rotar');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: usuarios, error } = await supabase.from('usuarios').select('id, chat_id, password_encrypted');
  if (error) {
    console.error('❌ No pude leer usuarios:', error.message);
    process.exit(1);
  }

  let migrados = 0, yaEstaban = 0;
  const fallidos = [];

  for (const u of usuarios) {
    // ¿Ya está con la llave nueva? Entonces esta fila viene de una corrida previa.
    try {
      await decrypt(u.password_encrypted, NEW_ENCRYPTION_KEY);
      yaEstaban++;
      continue;
    } catch { /* esperado en la primera pasada: sigue con la llave vieja */ }

    let password;
    try {
      password = await decrypt(u.password_encrypted, CREDENTIALS_ENCRYPTION_KEY);
    } catch {
      // Ni la vieja ni la nueva la abren: contraseña irrecuperable, el usuario
      // tendrá que volver a registrarse. No tocamos la fila.
      fallidos.push(u.chat_id);
      continue;
    }

    const nuevo = await encrypt(password, NEW_ENCRYPTION_KEY);
    const { error: errUpd } = await supabase
      .from('usuarios')
      .update({ password_encrypted: nuevo })
      .eq('id', u.id);
    if (errUpd) {
      console.error(`❌ chat_id ${u.chat_id}: ${errUpd.message}`);
      fallidos.push(u.chat_id);
      continue;
    }
    migrados++;
  }

  console.log(`✅ ${migrados} re-cifrados, ${yaEstaban} ya estaban con la llave nueva, ${fallidos.length} fallidos`);
  if (fallidos.length) {
    console.log('   chat_ids a re-registrar:', fallidos.join(', '));
    process.exit(1);
  }
}

main();
