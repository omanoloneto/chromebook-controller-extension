// Rate-limit do `up` (L1–L4) com relógio falso.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificar, registrar, limparEstado, estadoVazio, TEXTO_LIMITE } from '../src/lib/limites.js';

const T0 = 1767369600000;

test('L1: chat 1 a cada 2 s', () => {
  let e = registrar(estadoVazio(), 'chat', { agora: T0 });
  assert.equal(verificar(e, 'chat', { agora: T0 + 1999 }), 'L1');
  assert.equal(verificar(e, 'chat', { agora: T0 + 2000 }), null);
});

test('L2: 30 mensagens por hora (janela deslizante)', () => {
  let e = estadoVazio();
  for (let i = 0; i < 30; i++) e = registrar(e, 'chat', { agora: T0 + i * 60000 });
  const depois = T0 + 29 * 60000 + 5000;
  assert.equal(verificar(e, 'chat', { agora: depois }), 'L2');
  // a primeira sai da janela 1 h depois dela
  assert.equal(verificar(e, 'chat', { agora: T0 + 3600000 }), null);
});

test('L3: 1 pedido por site a cada 60 s e no máximo 5 pendentes', () => {
  let e = registrar(estadoVazio(), 'unblock_request', { agora: T0, site: 'youtube.com' });
  assert.equal(verificar(e, 'unblock_request', { agora: T0 + 59999, site: 'youtube.com' }), 'L3');
  assert.equal(verificar(e, 'unblock_request', { agora: T0 + 1000, site: 'outro.com' }), null);
  assert.equal(verificar(e, 'unblock_request', { agora: T0 + 60000, site: 'youtube.com' }), null);
  assert.equal(verificar(e, 'unblock_request', { agora: T0, site: 'novo.com', pendentes: 5 }), 'L3');
  assert.equal(verificar(e, 'unblock_request', { agora: T0, site: 'novo.com', pendentes: 4 }), null);
});

test('L4: mão 1 a cada 10 s', () => {
  const e = registrar(estadoVazio(), 'raise_hand', { agora: T0 });
  assert.equal(verificar(e, 'raise_hand', { agora: T0 + 9999 }), 'L4');
  assert.equal(verificar(e, 'raise_hand', { agora: T0 + 10000 }), null);
  // a mão não segura o chat e vice-versa
  assert.equal(verificar(e, 'chat', { agora: T0 + 1 }), null);
});

test('relógio que voltou não prende o aluno; storage corrompido vira vazio', () => {
  const e = registrar(estadoVazio(), 'chat', { agora: T0 });
  assert.equal(verificar(e, 'chat', { agora: T0 - 60000 }), null);
  assert.deepEqual(limparEstado('lixo', T0), estadoVazio());
  assert.deepEqual(limparEstado({ chat: 'x', pedidos: [1], mao: 'y' }, T0), estadoVazio());
});

test('textos ao aluno são os da spec', () => {
  assert.equal(TEXTO_LIMITE.L1, 'Espere um pouquinho para mandar outra mensagem.');
  assert.equal(TEXTO_LIMITE.L2, 'Você mandou muitas mensagens. Espere o professor responder.');
  assert.equal(TEXTO_LIMITE.L3, 'Você já pediu. Aguarde o professor responder.');
  assert.equal(TEXTO_LIMITE.L4, 'Mão levantada ✋');
});
