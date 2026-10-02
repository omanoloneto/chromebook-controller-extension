// Canal aluno→professor (`up`): ids, pushId, poda, site, caps e monograma.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  novoId,
  idValido,
  pushIdMs,
  chavesParaPodar,
  siteValido,
  hostDeUrl,
  cortarCodePoints,
  limparPayloadUp,
  monograma,
  UpType,
  MAX_CHAT_TEXTO,
  MAX_PEDIDO_MOTIVO,
  UP_IDADE_MAX_PC,
} from '../src/lib/up.js';

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
function pushIdDe(ms, sufixo = 'AAAAAAAAAAAA') {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = PUSH_CHARS[ms % 64] + s;
    ms = Math.floor(ms / 64);
  }
  return s + sufixo;
}

test('novoId: 16 caracteres base64url, sem repetição em 10⁴', () => {
  const vistos = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = novoId();
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(idValido(id));
    vistos.add(id);
  }
  assert.equal(vistos.size, 10000);
  assert.equal(idValido('curto'), false);
  assert.equal(idValido('a'.repeat(16) + '!'), false);
  assert.equal(idValido(42), false);
});

test('pushIdMs decodifica o ms do servidor; chave que não é pushId → null', () => {
  const ms = 1767369600123;
  assert.equal(pushIdMs(pushIdDe(ms)), ms);
  assert.equal(pushIdMs('-Nabc'), null);
  assert.equal(pushIdMs('chave com espaço'), null);
  assert.equal(pushIdMs(null), null);
});

test('chavesParaPodar: > 2 h e além das 20 mais novas; lixo também sai', () => {
  const agora = 1767369600000;
  const velha = pushIdDe(agora - UP_IDADE_MAX_PC - 1);
  const novas = Array.from({ length: 25 }, (_, i) => pushIdDe(agora - 60000 + i * 1000));
  const podar = chavesParaPodar([...novas, velha, 'lixo!'], agora);
  assert.ok(podar.includes(velha));
  assert.ok(podar.includes('lixo!'));
  // as 5 mais antigas das 25 recentes saem; as 20 mais novas ficam
  for (const k of novas.slice(0, 5)) assert.ok(podar.includes(k));
  for (const k of novas.slice(5)) assert.ok(!podar.includes(k));
  assert.deepEqual(chavesParaPodar(novas.slice(0, 3), agora), []);
});

test('siteValido: minúsculo, ≥ 2 rótulos, nunca sufixo público', () => {
  assert.equal(siteValido('youtube.com'), true);
  assert.equal(siteValido('m.youtube.com'), true);
  assert.equal(siteValido('escola.edu.br'), true);
  for (const ruim of ['com', 'com.br', 'gov.br', 'localhost', 'YouTube.com', 'a..b', '.a.b', 'a b.com', '', 'x'.repeat(98) + '.com']) {
    assert.equal(siteValido(ruim), false, ruim);
  }
  assert.equal(hostDeUrl('https://WWW.Exemplo.com.br/x'), 'www.exemplo.com.br');
  assert.equal(hostDeUrl('lixo'), '');
});

test('caps por code point (emoji conta 1) e payload limpo', () => {
  assert.equal(cortarCodePoints('😀'.repeat(600), MAX_CHAT_TEXTO), '😀'.repeat(500));
  assert.deepEqual(limparPayloadUp(UpType.CHAT, { texto: '  oi  ' }), { texto: 'oi' });
  assert.equal(limparPayloadUp(UpType.CHAT, { texto: '   ' }), null);
  const pedido = limparPayloadUp(UpType.UNBLOCK_REQUEST, {
    site: 'youtube.com',
    url: 'https://youtube.com/' + 'a'.repeat(900),
    motivo: 'x'.repeat(300),
    bloqueio: 'outra',
    extra: 'some',
  });
  assert.equal(Array.from(pedido.url).length, 500);
  assert.equal(Array.from(pedido.motivo).length, MAX_PEDIDO_MOTIVO);
  assert.equal(pedido.bloqueio, 'regra');
  assert.equal('extra' in pedido, false);
  assert.equal(limparPayloadUp(UpType.UNBLOCK_REQUEST, { site: 'com' }), null);
  assert.deepEqual(limparPayloadUp(UpType.RAISE_HAND, { qualquer: 1 }), {});
  assert.equal(limparPayloadUp('tipo_estranho', {}), null);
});

test('monograma: exemplos da spec e casos de borda', () => {
  assert.equal(monograma('Prof. Manoel'), 'MA');
  assert.equal(monograma('Ana Paula Souza'), 'AS');
  assert.equal(monograma('professora   júlia mendes'), 'JM');
  assert.equal(monograma('PROFA. Bia'), 'BI');
  assert.equal(monograma('Prof.'), '?');
  assert.equal(monograma(''), '?');
  assert.equal(monograma(null), '?');
  assert.equal(monograma('Élio'), 'ÉL');
});
