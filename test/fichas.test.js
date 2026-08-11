const test = require('node:test');
const assert = require('node:assert');
const { parsearFichas, descargarFicha } = require('../lib/session');

// Recorte del HTML real de /informacion-academica/fichas (2026-08-11).
const HTML_FICHAS = `
<div class="col-md-6 col-xl-4">
  <div class="card bg-info text-white text-center mb-3">
    <div class="card-body">
      <h5 class="card-title text-white">Ficha Datos Personales</h5>
      <p class="card-text">Datos Personales y Académicos del estudiante</p>
      <a href="https://alumnos.uni.edu.pe/informacion-academica/ficha-datos-pdf"
         target="_blank" class="btn btn-flat-dark">Ver</a>
    </div>
  </div>
</div>
<div class="col-md-6 col-xl-4">
  <div class="card bg-danger text-white text-center mb-3">
    <div class="card-body">
      <h5 class="card-title text-white">Ficha Académica</h5>
      <a href="https://alumnos.uni.edu.pe/informacion-academica/ficha-academica-pdf"
         target="_blank" class="btn btn-flat-dark">Ver</a>
    </div>
  </div>
</div>
<footer>
  <a href="https://alumnos.uni.edu.pe/assets/img/legal/MARCO_LEGAL_ACADEMICO.pdf">Licencia</a>
</footer>
`;

test('parsearFichas saca nombre y url de cada tarjeta', () => {
  assert.deepStrictEqual(parsearFichas(HTML_FICHAS), [
    {
      nombre: 'Ficha Datos Personales',
      url: 'https://alumnos.uni.edu.pe/informacion-academica/ficha-datos-pdf',
    },
    {
      nombre: 'Ficha Académica',
      url: 'https://alumnos.uni.edu.pe/informacion-academica/ficha-academica-pdf',
    },
  ]);
});

test('parsearFichas ignora el PDF de licencia del pie de página', () => {
  assert.ok(!parsearFichas(HTML_FICHAS).some((f) => f.url.includes('MARCO_LEGAL')));
});

test('parsearFichas devuelve [] si el HTML cambió y no hay tarjetas', () => {
  assert.deepStrictEqual(parsearFichas('<html><body><p>nada</p></body></html>'), []);
});

// Cliente falso: solo necesita .get(), que es lo único que usa descargarFicha.
function clienteFalso(respuesta) {
  return { get: async () => respuesta };
}

test('descargarFicha devuelve el buffer si el PDF es válido', async () => {
  const pdf = Buffer.from('%PDF-1.4 contenido falso');
  const res = await descargarFicha(clienteFalso({ status: 200, data: pdf }), '/x-pdf');
  assert.ok(Buffer.isBuffer(res));
  assert.strictEqual(res.subarray(0, 4).toString(), '%PDF');
});

test('descargarFicha devuelve null si INTRALU responde 404 con JSON', async () => {
  // Caso real de Constancia de Matrícula (2026-08-11).
  const json = Buffer.from('{"message":""}');
  assert.strictEqual(await descargarFicha(clienteFalso({ status: 404, data: json }), '/x-pdf'), null);
});

test('descargarFicha devuelve null si el status es 200 pero no es un PDF', async () => {
  // Sesión vencida: INTRALU devuelve el HTML del login con status 200.
  const html = Buffer.from('<!DOCTYPE html><html>login</html>');
  assert.strictEqual(await descargarFicha(clienteFalso({ status: 200, data: html }), '/x-pdf'), null);
});

const { nombreArchivo } = require('../fetch-fichas');

test('nombreArchivo convierte el título en un nombre de archivo seguro', () => {
  assert.strictEqual(nombreArchivo('Ficha Académica'), 'ficha-academica.pdf');
  assert.strictEqual(nombreArchivo('Ficha Académica Depurada'), 'ficha-academica-depurada.pdf');
  assert.strictEqual(nombreArchivo('Constancia de Matrícula'), 'constancia-de-matricula.pdf');
  assert.strictEqual(nombreArchivo('Adeudos'), 'adeudos.pdf');
});

// El id que viaja en el callback_data del botón es el último segmento de la
// URL, y así es como fetch-fichas.js encuentra la ficha en la página real.
test('el id de la ficha es el último segmento de su URL', () => {
  const fichas = parsearFichas(HTML_FICHAS);
  const buscada = fichas.find((f) => f.url.endsWith('/ficha-academica-pdf'));
  assert.strictEqual(buscada.nombre, 'Ficha Académica');
  assert.strictEqual(
    fichas.find((f) => f.url.endsWith('/ficha-inexistente-pdf')),
    undefined,
  );
});
