const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { login, RateLimitError } = require('../lib/session');

// Un /login falso: el GET trae el token CSRF y el POST contesta lo que diga
// `responderPost`. Cuenta los POST y cuántos hubo en vuelo a la vez.
async function intralu(responderPost) {
  const stats = { posts: 0, enVuelo: 0, maxEnVuelo: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') return res.end('<input name="_token" value="t">');
    stats.posts++;
    stats.maxEnVuelo = Math.max(stats.maxEnVuelo, ++stats.enVuelo);
    setTimeout(() => {
      stats.enVuelo--;
      responderPost(res);
    }, 20);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cerrar = () => {
    srv.close();
    srv.closeAllConnections();
  };
  return { baseUrl: `http://127.0.0.1:${srv.address().port}`, stats, cerrar };
}

// El orden importa: login() guarda el bloqueo por 429 a nivel de módulo, así
// que el test que lo dispara va último.
test('los logins en paralelo llegan a INTRALU de a uno', async () => {
  const { baseUrl, stats, cerrar } = await intralu((res) => res.writeHead(302, { Location: '/home' }).end());
  try {
    await Promise.all([login('A1', 'x', baseUrl), login('B2', 'x', baseUrl), login('C3', 'x', baseUrl)]);
    assert.strictEqual(stats.posts, 3);
    assert.strictEqual(stats.maxEnVuelo, 1);
  } finally {
    cerrar();
  }
});

test('un 429 es RateLimitError y frena los logins siguientes sin gastar intentos', async () => {
  const { baseUrl, stats, cerrar } = await intralu((res) => res.writeHead(429, { 'Retry-After': '90' }).end());
  try {
    await assert.rejects(login('A1', 'x', baseUrl), RateLimitError);
    await assert.rejects(login('B2', 'x', baseUrl), RateLimitError);
    assert.strictEqual(stats.posts, 1);
  } finally {
    cerrar();
  }
});
