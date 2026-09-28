const test = require('node:test');
const assert = require('node:assert');
const { esRechazoPorCaptcha } = require('../lib/session');

test('el rechazo real del 2026-09-28 se reconoce como reCAPTCHA', () => {
  assert.strictEqual(esRechazoPorCaptcha('Por favor complete el reCAPTCHA'), true);
});

test('un rechazo de credenciales no se confunde con reCAPTCHA', () => {
  assert.strictEqual(esRechazoPorCaptcha('Usuario o contraseña incorrectos'), false);
  assert.strictEqual(esRechazoPorCaptcha('El campo código solo puede contener letras y números.'), false);
  assert.strictEqual(esRechazoPorCaptcha(''), false);
  assert.strictEqual(esRechazoPorCaptcha(undefined), false);
});
