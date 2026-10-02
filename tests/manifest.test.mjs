// Manifest: a miniatura usa permissão OPCIONAL. Host obrigatório novo numa
// atualização desativaria a extensão da Web Store até reaprovação (fail-open).
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const atual = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));

const HOSTS_FIREBASE = [
  'https://*.firebaseio.com/*',
  'https://*.firebasedatabase.app/*',
  'https://identitytoolkit.googleapis.com/*',
  'https://securetoken.googleapis.com/*',
];

test('host_permissions = as 4 entradas do Firebase (iguais às da 0.6.0)', () => {
  assert.deepEqual(atual.host_permissions, HOSTS_FIREBASE);
  // Confere também contra a base no git, quando disponível.
  let base = null;
  try {
    base = JSON.parse(
      execFileSync('git', ['show', '834a6ac:src/manifest.json'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    base = null; // fora do repositório (tarball): fica a lista fixa acima
  }
  if (base) assert.deepEqual(atual.host_permissions, base.host_permissions);
});

test('optional_host_permissions = ["<all_urls>"] e nenhuma permissão obrigatória nova', () => {
  assert.deepEqual(atual.optional_host_permissions, ['<all_urls>']);
  assert.deepEqual(
    [...atual.permissions].sort(),
    ['alarms', 'browsingData', 'nativeMessaging', 'notifications', 'offscreen', 'storage', 'tabs', 'wallpaper'],
  );
});
