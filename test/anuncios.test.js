const test = require('node:test');
const assert = require('node:assert');
const { parsearPublicaciones, descargarAdjunto } = require('../lib/session');
const { clavePublicacion, nuevas, recortarVistas, mensajePublicacion } = require('../check-anuncios');

// Recorte del HTML real de la home de INTRALU (2026-08-11).
const HTML_HOME = `
<div class="card h-100">
  <div class="card-header d-flex justify-content-between pb-2">
    <div class="card-title mb-1"><h5 class="m-0 me-2">Reglamentos y Resoluciones</h5></div>
  </div>
  <div class="card-body">
    <div class="nav-align-top">
      <ul class="nav nav-tabs nav-fill" role="tablist">
        <li class="nav-item"><button type="button" class="nav-link active" data-bs-target="#navs-justified-new">Reglamentos</button></li>
        <li class="nav-item"><button type="button" class="nav-link" data-bs-target="#navs-justified-link-preparing">Resoluciones</button></li>
      </ul>
      <div class="tab-content px-2 mx-1 pb-0">
        <div class="tab-pane fade show active" id="navs-justified-new">
          <ul class="list-unstyled mb-0">
            <li class="d-flex mb-4 pb-1 align-items-center">
              <div class="avatar flex-shrink-0 me-3">
                <a href="javascript:void(0)" class="avatar-initial rounded btn-file bg-label-primary"
                   data-codanu="18124" data-extension="pdf">
                  <span class="avatar-initial rounded bg-label-primary"><i class="ti ti-bookmarks ti-md"></i></span>
                </a>
              </div>
              <div class="row w-100 align-items-center">
                <div class="col-sm-8"><p class="mb-0 fw-medium">REGLAMENTO MATRICULA</p></div>
                <div class="col-sm-4"><div class="badge bg-label-secondary">07/02/2025</div></div>
              </div>
            </li>
          </ul>
        </div>
        <div class="tab-pane fade" id="navs-justified-link-preparing">
          <ul class="timeline mb-0 pb-1"><li class="text-center">Sin publicaciones</li></ul>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-header d-flex justify-content-between">
    <h5 class="card-title m-0 me-2 pt-1 mb-2 d-flex align-items-center">Anuncios</h5>
  </div>
  <div class="card-body pb-0">
    <ul class="timeline ms-1 mb-0">
      <li class="timeline-item timeline-item-transparent ps-4">
        <div class="timeline-event">
          <div class="timeline-header">
            <h6 class="mb-0">HORARIO ENTREGA DE EXAMENES 2026-1</h6>
            <small class="text-muted" title="27/07/2026">hace 2 semanas</small>
          </div>
          <p class="mb-2" style="width: 85%">PARA CONOCIMIENTO.</p>
          <div class="d-flex flex-wrap gap-2 pt-1">
            <a href="javascript:void(0)" class="me-1 badge bg-label-secondary btn-file"
               data-codanu="54480" data-extension="docx">
              <i class="ti ti-download me-1 ti-xs"></i>
              <span class="fw-medium text-heading">HORARIO ENTREGA DE EXAMENES 2026-1.docx</span>
            </a>
          </div>
        </div>
      </li>
      <li class="timeline-item timeline-item-transparent ps-4">
        <div class="timeline-event">
          <div class="timeline-header">
            <h6 class="mb-0">AVISO SIN ARCHIVO</h6>
            <small class="text-muted" title="01/08/2026">hace 1 semana</small>
          </div>
          <p class="mb-2" style="width: 85%">Solo texto, sin adjunto.</p>
        </div>
      </li>
    </ul>
  </div>
</div>
`;

test('parsearPublicaciones lee los anuncios del timeline con su adjunto', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  assert.deepStrictEqual(pubs.find((p) => p.titulo === 'HORARIO ENTREGA DE EXAMENES 2026-1'), {
    tipo: 'Anuncio',
    titulo: 'HORARIO ENTREGA DE EXAMENES 2026-1',
    fecha: '27/07/2026',
    texto: 'PARA CONOCIMIENTO.',
    adjuntos: [{ codanu: '54480', nombre: 'HORARIO ENTREGA DE EXAMENES 2026-1.docx' }],
  });
});

test('parsearPublicaciones acepta un anuncio sin adjuntos', () => {
  const anuncio = parsearPublicaciones(HTML_HOME).find((p) => p.titulo === 'AVISO SIN ARCHIVO');
  assert.deepStrictEqual(anuncio.adjuntos, []);
  assert.strictEqual(anuncio.texto, 'Solo texto, sin adjunto.');
});

test('parsearPublicaciones lee los reglamentos y arma el nombre del archivo', () => {
  // En este bloque el <a> no trae el nombre del archivo (solo un ícono), así
  // que se arma con el título y data-extension.
  assert.deepStrictEqual(parsearPublicaciones(HTML_HOME).find((p) => p.titulo === 'REGLAMENTO MATRICULA'), {
    tipo: 'Reglamentos',
    titulo: 'REGLAMENTO MATRICULA',
    fecha: '07/02/2025',
    texto: '',
    adjuntos: [{ codanu: '18124', nombre: 'REGLAMENTO MATRICULA.pdf' }],
  });
});

test('parsearPublicaciones ignora las pestañas sin publicaciones', () => {
  const pubs = parsearPublicaciones(HTML_HOME);
  assert.ok(!pubs.some((p) => p.titulo === 'Sin publicaciones'));
  assert.strictEqual(pubs.length, 3);
});

test('parsearPublicaciones devuelve [] si el HTML cambió', () => {
  assert.deepStrictEqual(parsearPublicaciones('<html><body><p>nada</p></body></html>'), []);
});

function clienteFalso(respuesta) {
  return { get: async () => respuesta };
}

test('descargarAdjunto devuelve el buffer cuando INTRALU responde 200', async () => {
  const archivo = Buffer.from('contenido binario cualquiera');
  const res = await descargarAdjunto(clienteFalso({ status: 200, data: archivo }), '54480');
  assert.ok(Buffer.isBuffer(res));
  assert.strictEqual(res.toString(), 'contenido binario cualquiera');
});

test('descargarAdjunto devuelve null si el status no es 200', async () => {
  assert.strictEqual(await descargarAdjunto(clienteFalso({ status: 404, data: Buffer.from('') }), '999'), null);
});

test('descargarAdjunto devuelve null si el archivo viene vacío', async () => {
  assert.strictEqual(await descargarAdjunto(clienteFalso({ status: 200, data: Buffer.from('') }), '999'), null);
});

const PUB_A = { tipo: 'Anuncio', titulo: 'HORARIO', fecha: '27/07/2026', texto: '', adjuntos: [] };
const PUB_B = { tipo: 'Anuncio', titulo: 'ENCUESTA', fecha: '04/07/2026', texto: '', adjuntos: [] };

test('clavePublicacion no depende de los adjuntos ni del texto', () => {
  const conAdjunto = { ...PUB_A, texto: 'otra cosa', adjuntos: [{ codanu: '1', nombre: 'x.pdf' }] };
  assert.strictEqual(clavePublicacion(PUB_A), clavePublicacion(conAdjunto));
});

test('clavePublicacion distingue publicaciones distintas', () => {
  assert.notStrictEqual(clavePublicacion(PUB_A), clavePublicacion(PUB_B));
});

test('nuevas devuelve solo las que no están en vistas', () => {
  assert.deepStrictEqual(nuevas([PUB_A, PUB_B], [clavePublicacion(PUB_A)]), [PUB_B]);
});

test('nuevas devuelve todo si no se vio nada todavía', () => {
  assert.deepStrictEqual(nuevas([PUB_A, PUB_B], []), [PUB_A, PUB_B]);
});

test('nuevas devuelve [] si ya se vio todo', () => {
  assert.deepStrictEqual(nuevas([PUB_A, PUB_B], [clavePublicacion(PUB_A), clavePublicacion(PUB_B)]), []);
});

test('recortarVistas se queda con las últimas 100', () => {
  const claves = Array.from({ length: 130 }, (_, i) => `k${i}`);
  const res = recortarVistas(claves);
  assert.strictEqual(res.length, 100);
  assert.strictEqual(res[0], 'k30');
  assert.strictEqual(res[99], 'k129');
});

test('recortarVistas deja la lista igual si no llega al tope', () => {
  assert.deepStrictEqual(recortarVistas(['a', 'b']), ['a', 'b']);
});

test('mensajePublicacion arma el texto con título, fecha y cuerpo', () => {
  assert.strictEqual(
    mensajePublicacion({
      tipo: 'Anuncio',
      titulo: 'HORARIO ENTREGA DE EXAMENES 2026-1',
      fecha: '27/07/2026',
      texto: 'PARA CONOCIMIENTO.',
      adjuntos: [],
    }),
    '📢 <b>HORARIO ENTREGA DE EXAMENES 2026-1</b>\n<i>27/07/2026</i>\n\nPARA CONOCIMIENTO.',
  );
});

test('mensajePublicacion escapa el HTML que venga en el título', () => {
  assert.strictEqual(
    mensajePublicacion({ tipo: 'Anuncio', titulo: 'MATRÍCULA <2026> & OTROS', fecha: '', texto: '', adjuntos: [] }),
    '📢 <b>MATRÍCULA &lt;2026&gt; &amp; OTROS</b>',
  );
});
