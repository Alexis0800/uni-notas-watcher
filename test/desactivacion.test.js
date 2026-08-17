const test = require('node:test');
const assert = require('node:assert');
const { esRechazoSistemico, debeDesactivar, MIN_FAILURE_WINDOW_MS } = require('../check-all-users');

const HORA = 60 * 60 * 1000;
const AHORA = Date.parse('2026-08-17T17:10:00Z');
// `ultimoExito` es el updated_at del usuario: el último chequeo que entró bien.
const ultimoExitoHace = (ms) => new Date(AHORA - ms).toISOString();

test('el incidente del 2026-08-17 no desactiva a nadie', () => {
  // INTRALU le contestó "Acercarse a admisión para actualizar sus datos" a
  // los 3 usuarios y el ciclo corto de 60s juntó los 3 rechazos en 3 minutos,
  // con chequeos que venían entrando bien hasta minutos antes.
  assert.equal(esRechazoSistemico(3, 0), true);
  assert.equal(debeDesactivar(3, ultimoExitoHace(6 * 60 * 1000), AHORA), false);
});

test('nadie entró pero es un solo usuario: no alcanza para culpar al sitio', () => {
  // Con un único usuario activo, "no entró nadie" y "su contraseña está mal"
  // son el mismo dato. Ahí decide el tiempo, no esta señal.
  assert.equal(esRechazoSistemico(1, 0), false);
});

test('si alguien más entró bien, el rechazo es de ese usuario', () => {
  assert.equal(esRechazoSistemico(2, 1), false);
});

test('una contraseña que sigue mal a los 2 días sí desactiva', () => {
  assert.equal(debeDesactivar(3, ultimoExitoHace(MIN_FAILURE_WINDOW_MS + HORA), AHORA), true);
});

test('no desactiva antes de las 48h aunque sobren rechazos', () => {
  assert.equal(debeDesactivar(500, ultimoExitoHace(47 * HORA), AHORA), false);
});

test('no desactiva con pocos rechazos aunque la racha sea vieja', () => {
  assert.equal(debeDesactivar(2, ultimoExitoHace(10 * 24 * HORA), AHORA), false);
});

test('sin fecha de último éxito no desactiva', () => {
  assert.equal(debeDesactivar(1, null, AHORA), false);
});
