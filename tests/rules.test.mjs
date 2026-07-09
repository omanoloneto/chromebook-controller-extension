// Vetores do matcher de regras — mesma tabela do docs/protocolo.md §3.2 e do
// espelho Dart (chromebook-controller-app/test/rules_test.dart).
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarPadrao, regraCasa, acharRegra } from '../src/lib/rules.js';

const VETORES = [
  ['youtube.com', 'https://www.youtube.com/watch?v=1', true],
  ['youtube.com', 'https://m.youtube.com/', true],
  ['youtube.com', 'http://youtube.com', true],
  ['youtube.com', 'https://notyoutube.com/', false],
  ['youtube.com', 'chrome://extensions', false],
  ['youtube.com', 'não é url', false],
  ['reddit.com/r/games', 'https://www.reddit.com/r/games/top', true],
  ['reddit.com/r/games', 'https://reddit.com/r/games', true],
  ['reddit.com/r/games', 'https://reddit.com/r/other', false],
  ['reddit.com/r/games', 'https://reddit.com/R/GAMES', true],
  ['', 'https://youtube.com/', false],
];

test('regraCasa segue a tabela de vetores do protocolo', () => {
  for (const [pattern, url, esperado] of VETORES) {
    assert.equal(regraCasa(pattern, url), esperado, `${pattern} × ${url}`);
  }
});

test('normalizarPadrao limpa esquema, porta, barra final e maiúsculas', () => {
  assert.equal(normalizarPadrao('  HTTPS://WWW.YouTube.com:443/  '), 'www.youtube.com');
  assert.equal(normalizarPadrao('Reddit.com/r/Games/'), 'reddit.com/r/games');
  assert.equal(normalizarPadrao('youtube.com'), 'youtube.com');
  assert.equal(normalizarPadrao('http://a.com:8080/x'), 'a.com/x');
});

test('acharRegra retorna a primeira que casa ou null', () => {
  const rules = [{ pattern: 'a.com' }, { pattern: 'b.com' }];
  assert.equal(acharRegra(rules, 'https://x.b.com/'), rules[1]);
  assert.equal(acharRegra(rules, 'https://c.com/'), null);
  assert.equal(acharRegra(null, 'https://a.com/'), null);
});
