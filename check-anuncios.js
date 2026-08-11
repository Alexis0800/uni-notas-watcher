require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { login, fetchPublicaciones, descargarAdjunto } = require('./lib/session');
const { decrypt } = require('./lib/crypto');
const { sendTelegram, sendDocument } = require('./lib/notificaciones');

const CONCURRENCY = Number(process.env.CONCURRENCY) || 15;

// Cuántas claves de publicaciones vistas se guardan por usuario. INTRALU
// publica del orden de un anuncio por semana, así que 100 son años de
// margen — el tope existe solo para que la columna no crezca sin fin.
const MAX_VISTAS = 100;

// Identifica una publicación sin depender del codanu: un anuncio puede no
// tener adjunto, y el texto del cuerpo podría editarse sin que sea una
// publicación nueva. Tipo + fecha + título es lo estable.
function clavePublicacion(pub) {
  return `${pub.tipo}|${pub.fecha}|${pub.titulo}`;
}

function nuevas(publicaciones, vistas) {
  const yaVistas = new Set(vistas);
  return publicaciones.filter((p) => !yaVistas.has(clavePublicacion(p)));
}

function recortarVistas(claves) {
  return claves.slice(-MAX_VISTAS);
}

// Escapa lo que va dentro de un mensaje con parse_mode HTML — los títulos
// los escribe la universidad, no nosotros, y un "&" o un "<" sueltos hacen
// que Telegram rechace el mensaje entero.
function escaparHtml(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mensajePublicacion(pub) {
  const encabezado = pub.tipo === 'Anuncio' ? '📢' : '📕';
  const lineas = [`${encabezado} <b>${escaparHtml(pub.titulo)}</b>`];
  if (pub.fecha) lineas.push(`<i>${escaparHtml(pub.fecha)}</i>`);
  if (pub.texto) lineas.push('', escaparHtml(pub.texto));
  return lineas.join('\n');
}

async function revisarUsuario(supabase, telegramToken, encryptionKey, usuario) {
  const { id, chat_id, codigo_uni, password_encrypted, anuncios_vistos, anuncios_seeded } = usuario;

  try {
    const password = await decrypt(password_encrypted, encryptionKey);
    const client = await login(codigo_uni, password);
    const publicaciones = await fetchPublicaciones(client);

    const vistas = Array.isArray(anuncios_vistos) ? anuncios_vistos : [];

    // Primera corrida para este usuario: guardar lo que ya está publicado
    // sin avisar nada. Si no, alguien recién registrado recibiría de golpe
    // todos los anuncios viejos que INTRALU tenga en la home.
    if (!anuncios_seeded) {
      await supabase
        .from('usuarios')
        .update({
          anuncios_vistos: recortarVistas(publicaciones.map(clavePublicacion)),
          anuncios_seeded: true,
        })
        .eq('id', id);
      console.log(`🌱 ${chat_id} (${codigo_uni}): estado inicial guardado (${publicaciones.length} publicación/es)`);
      return;
    }

    const pendientes = nuevas(publicaciones, vistas);
    if (pendientes.length === 0) {
      console.log(`✅ ${chat_id} (${codigo_uni}): sin novedades`);
      return;
    }

    for (const [indice, pub] of pendientes.entries()) {
      // El recordatorio de cómo apagarlos va una sola vez, pegado a la
      // última publicación de la tanda — repetirlo en cada mensaje sería
      // ruido, y no ponerlo nunca esconde el opt-out.
      const pie = indice === pendientes.length - 1 ? '\n\n🔕 Para dejar de recibir estos avisos: /avisos' : '';
      await sendTelegram(telegramToken, chat_id, mensajePublicacion(pub) + pie);

      for (const adjunto of pub.adjuntos) {
        const archivo = await descargarAdjunto(client, adjunto.codanu);
        if (!archivo) {
          console.error(`⚠️ ${chat_id}: no pude bajar ${adjunto.nombre} (codanu ${adjunto.codanu})`);
          continue;
        }
        await sendDocument(telegramToken, chat_id, archivo, adjunto.nombre);
      }
    }

    // Se marcan como vistas aunque algún adjunto haya fallado: el aviso ya
    // se entregó, y reintentarlo la hora siguiente sería mandar el mismo
    // mensaje de nuevo.
    await supabase
      .from('usuarios')
      .update({ anuncios_vistos: recortarVistas([...vistas, ...pendientes.map(clavePublicacion)]) })
      .eq('id', id);

    console.log(`📢 ${chat_id} (${codigo_uni}): ${pendientes.length} publicación(es) nueva(s)`);
  } catch (err) {
    // A propósito no se toca consecutive_failures ni active: de desactivar
    // usuarios con credenciales malas se encarga check-all-users.js, que
    // corre cada 5 min. Acá un fallo solo significa que este usuario se
    // pierde esta pasada; la próxima hora se reintenta solo, y como
    // anuncios_vistos no se actualizó, no se pierde ningún aviso.
    console.error(`❌ ${chat_id} (${codigo_uni}): ${err.message}`);
  }
}

// Corrido por .github/workflows/check-anuncios.yml, una vez por hora.
// Revisa la home de INTRALU de cada usuario activo y suscrito, y le manda
// las publicaciones que todavía no vio. Se revisa por usuario (y no con una
// sola cuenta haciendo broadcast) porque no sabemos si la lista de anuncios
// es global o depende de la facultad.
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY, TELEGRAM_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CREDENTIALS_ENCRYPTION_KEY || !TELEGRAM_TOKEN) {
    console.error('❌ Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY o TELEGRAM_TOKEN en el entorno');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('active', true)
    .eq('avisos_activos', true);
  if (error) throw error;

  console.log(`Revisando anuncios de ${usuarios.length} usuario(s) suscrito(s)...`);

  const start = Date.now();
  for (let i = 0; i < usuarios.length; i += CONCURRENCY) {
    const batch = usuarios.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => revisarUsuario(supabase, TELEGRAM_TOKEN, CREDENTIALS_ENCRYPTION_KEY, u)));
  }

  console.log(`Listo en ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

module.exports = { clavePublicacion, nuevas, recortarVistas, mensajePublicacion, escaparHtml, MAX_VISTAS };

// Solo corre si lo invocan directo, no cuando test/anuncios.test.js lo
// importa para probar las funciones puras.
if (require.main === module) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
