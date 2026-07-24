// Limpeza de sessão — parte pura (allowlist + montagem dos args do
// chrome.browsingData.remove). Sem chrome.*.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCHOOL_ORIGINS,
  DATA_A_LIMPAR,
  normalizarOrigens,
  montarOpcoesLimpeza,
} from '../src/lib/session-wipe.js';

test('DEFAULT_SCHOOL_ORIGINS é vazio (limpa TODOS os sites, inclusive Canva)', () => {
  assert.deepEqual([...DEFAULT_SCHOOL_ORIGINS], []);
});

test('normalizarOrigens: undefined/não-array volta ao DEFAULT (chave nunca configurada)', () => {
  assert.deepEqual(normalizarOrigens(undefined), [...DEFAULT_SCHOOL_ORIGINS]);
  assert.deepEqual(normalizarOrigens(null), [...DEFAULT_SCHOOL_ORIGINS]);
  assert.deepEqual(normalizarOrigens('https://x.com'), [...DEFAULT_SCHOOL_ORIGINS]);
});

test('normalizarOrigens: array vazio é respeitado (limpar TODOS os sites)', () => {
  assert.deepEqual(normalizarOrigens([]), []);
});

test('normalizarOrigens: mantém só origins http(s) puros, deduplica', () => {
  const out = normalizarOrigens([
    'https://www.canva.com',
    'https://www.canva.com', // dup
    'https://www.canva.com/design', // tem path -> descarta
    'canva.com', // sem esquema -> descarta
    'ftp://x.com', // esquema errado -> descarta
    '  https://mb.escolacelita.com  ', // trim
    42, // não-string -> descarta
  ]);
  assert.deepEqual(out, ['https://www.canva.com', 'https://mb.escolacelita.com']);
});

test('montarOpcoesLimpeza: com allowlist gera excludeOrigins + unprotectedWeb', () => {
  const { options, dataToRemove } = montarOpcoesLimpeza(['https://www.canva.com']);
  assert.equal(options.since, 0);
  assert.deepEqual(options.originTypes, { unprotectedWeb: true });
  assert.deepEqual(options.excludeOrigins, ['https://www.canva.com']);
  assert.ok(!('origins' in options)); // mutuamente exclusivo com excludeOrigins
  assert.deepEqual(dataToRemove, { ...DATA_A_LIMPAR });
});

test('montarOpcoesLimpeza: allowlist vazia OMITE excludeOrigins (limpa tudo)', () => {
  const { options } = montarOpcoesLimpeza([]);
  assert.ok(!('excludeOrigins' in options));
  assert.deepEqual(options.originTypes, { unprotectedWeb: true });
});

test('montarOpcoesLimpeza: só limpa tipos que suportam filtro por origin', () => {
  const { dataToRemove } = montarOpcoesLimpeza(DEFAULT_SCHOOL_ORIGINS);
  // history/downloads/passwords NÃO suportam excludeOrigins e fariam o remove()
  // rejeitar — garantir que não vazem para o conjunto.
  for (const proibido of ['history', 'downloads', 'passwords', 'formData']) {
    assert.ok(!(proibido in dataToRemove), `${proibido} não deve estar no conjunto`);
  }
  assert.equal(dataToRemove.cookies, true);
});
