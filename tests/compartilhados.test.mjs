// Rules e protocolo são compartilhados com o app (chromebook-controller-app),
// que copia os dois arquivos byte a byte e confere o mesmo hash em
// test/protocolo_identico_test.dart. Mudou um deles? Atualize o fixture
// (sha256sum firebase/database.rules.json docs/protocolo.md) e copie para o app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const raiz = new URL('../', import.meta.url);

test('rules e protocolo batem com tests/fixtures/compartilhados.sha256', () => {
  const linhas = readFileSync(new URL('tests/fixtures/compartilhados.sha256', raiz), 'utf8')
    .split('\n')
    .filter(Boolean);
  const esperados = Object.fromEntries(
    linhas.map((l) => {
      const [hash, arquivo] = l.split(/\s+/);
      return [arquivo, hash];
    }),
  );
  assert.deepEqual(Object.keys(esperados).sort(), ['docs/protocolo.md', 'firebase/database.rules.json']);
  for (const [arquivo, hash] of Object.entries(esperados)) {
    const real = createHash('sha256').update(readFileSync(new URL(arquivo, raiz))).digest('hex');
    assert.equal(real, hash, arquivo);
  }
  // Valor fixado pelo devices/{id}/health (saúde da frota, §3), sobre o
  // meta/diag, o /diag, os guardiões do Wi-Fi (§9) e a meta que não toma id
  // do roster da escola (§4).
  assert.equal(
    esperados['firebase/database.rules.json'],
    '7f6e9b2bc038e5cc7e7f7fb8d9c7d86d6549ea46acc074023723dd4b82a398b7',
  );
});
