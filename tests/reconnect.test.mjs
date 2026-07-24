// Auto-reconexão: só quando preso em 'connecting', respeitando o intervalo de
// 5s. NÃO gateia mais em navigator.onLine (preso em false no offscreen travava
// tudo). Rodar: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';

import { deveAutoReconectar, AUTO_RECONNECT_MS } from '../src/lib/reconnect.js';

const base = {
  estado: 'connecting',
  presoMs: AUTO_RECONNECT_MS,
  desdeUltimoRestartMs: AUTO_RECONNECT_MS,
};

test('preso em connecting há 5s com rede → reconecta', () => {
  assert.equal(deveAutoReconectar(base), true);
});

test('connected e pairing nunca reconectam', () => {
  assert.equal(deveAutoReconectar({ ...base, estado: 'connected' }), false);
  assert.equal(deveAutoReconectar({ ...base, estado: 'pairing' }), false);
});

test('menos de 5s preso (tentativa em andamento) → espera', () => {
  assert.equal(deveAutoReconectar({ ...base, presoMs: 4000 }), false);
});

test('menos de 5s desde o último auto-restart → espera', () => {
  assert.equal(deveAutoReconectar({ ...base, desdeUltimoRestartMs: 1000 }), false);
});

test('navigator.onLine é ignorado: reconecta mesmo com online=false', () => {
  // O flag ficava preso em false no offscreen e travava a reconexão pra
  // sempre — agora não conta mais (campo extra é ignorado).
  assert.equal(deveAutoReconectar({ ...base, online: false }), true);
});
