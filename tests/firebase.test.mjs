// Testes do cliente Firebase mínimo (parsing SSE + auth com fetch mockado).
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamEvent, FirebaseSession } from '../src/lib/firebase.js';

// ---- parseStreamEvent (frames enlatados do RTDB) ------------------------------

test('put/patch com path e data', () => {
  assert.deepEqual(parseStreamEvent('put', '{"path":"/","data":{"a":1}}'), {
    type: 'put',
    path: '/',
    data: { a: 1 },
  });
  assert.deepEqual(parseStreamEvent('patch', '{"path":"/cmd","data":{"k":"env"}}'), {
    type: 'patch',
    path: '/cmd',
    data: { k: 'env' },
  });
  // Delete chega como put com data null.
  assert.deepEqual(parseStreamEvent('put', '{"path":"/bind","data":null}'), {
    type: 'put',
    path: '/bind',
    data: null,
  });
});

test('keep-alive / cancel / auth_revoked', () => {
  assert.deepEqual(parseStreamEvent('keep-alive', 'null'), { type: 'keep-alive' });
  assert.deepEqual(parseStreamEvent('cancel', 'null'), { type: 'cancel' });
  assert.deepEqual(parseStreamEvent('auth_revoked', '"token expirou"'), {
    type: 'auth_revoked',
  });
});

test('malformado/desconhecido vira null', () => {
  assert.equal(parseStreamEvent('put', 'não é json'), null);
  assert.equal(parseStreamEvent('put', '{"semPath":1}'), null);
  assert.equal(parseStreamEvent('evento_estranho', '{}'), null);
});

// ---- Auth (fetch mockado) ------------------------------------------------------

function mockFetch(rotas) {
  const chamadas = [];
  const fn = async (url, opts) => {
    chamadas.push({ url, opts });
    for (const [padrao, resposta] of rotas) {
      if (url.includes(padrao)) {
        return {
          ok: resposta.status === undefined || resposta.status < 400,
          status: resposta.status ?? 200,
          json: async () => resposta.body,
        };
      }
    }
    throw new Error('rota não mockada: ' + url);
  };
  fn.chamadas = chamadas;
  return fn;
}

test('signIn sem conta salva faz signUp anônimo e persiste', async () => {
  let salvo = null;
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => null,
    saveAuth: async (a) => {
      salvo = a;
    },
    fetchImpl: mockFetch([
      [
        'accounts:signUp',
        { body: { localId: 'uid1', idToken: 't1', refreshToken: 'r1', expiresIn: '3600' } },
      ],
    ]),
  });
  const uid = await fb.signIn();
  assert.equal(uid, 'uid1');
  assert.equal(fb.idToken, 't1');
  assert.deepEqual(salvo, { uid: 'uid1', refreshToken: 'r1' });
  fb.stop();
});

test('signIn com conta salva usa o refresh (não cria conta nova)', async () => {
  const fetchImpl = mockFetch([
    [
      '/v1/token',
      { body: { user_id: 'uid1', id_token: 't2', refresh_token: 'r2', expires_in: '3600' } },
    ],
  ]);
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => ({ uid: 'uid1', refreshToken: 'r1' }),
    saveAuth: async () => {},
    fetchImpl,
  });
  const uid = await fb.signIn();
  assert.equal(uid, 'uid1');
  assert.equal(fb.idToken, 't2');
  assert.ok(fetchImpl.chamadas.every((c) => !c.url.includes('signUp')));
  fb.stop();
});

test('refresh morto (conta apagada) cai para signUp novo', async () => {
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => ({ uid: 'morto', refreshToken: 'rip' }),
    saveAuth: async () => {},
    fetchImpl: mockFetch([
      ['/v1/token', { status: 400, body: { error: 'INVALID_REFRESH_TOKEN' } }],
      [
        'accounts:signUp',
        { body: { localId: 'novo', idToken: 't', refreshToken: 'r', expiresIn: '3600' } },
      ],
    ]),
  });
  assert.equal(await fb.signIn(), 'novo');
  fb.stop();
});

// ---- Volta da queda de energia: NUNCA abandonar a conta por erro transitório.
// meta/uid é first-write-wins nas rules: trocar de uid à toa = device com
// permission-denied para sempre.

test('refresh 5xx (rede meio viva) NÃO cria conta nova — lança e preserva o storage', async () => {
  let salvo = 'intocado';
  const fetchImpl = mockFetch([['/v1/token', { status: 503, body: null }]]);
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => ({ uid: 'uid1', refreshToken: 'r1' }),
    saveAuth: async (a) => {
      salvo = a;
    },
    fetchImpl,
  });
  await assert.rejects(() => fb.signIn(), /refresh_http_503/);
  assert.ok(fetchImpl.chamadas.every((c) => !c.url.includes('signUp')));
  assert.equal(salvo, 'intocado');
  fb.stop();
});

test('refresh 200 com lixo (portal cativo/DNS sequestrado) NÃO cria conta nova', async () => {
  let salvo = 'intocado';
  const fetchImpl = async (url) => {
    if (url.includes('/v1/token')) {
      // Portal devolve HTML com HTTP 200: json() explode.
      return { ok: true, status: 200, json: async () => JSON.parse('<html>') };
    }
    throw new Error('não deveria chegar aqui: ' + url);
  };
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => ({ uid: 'uid1', refreshToken: 'r1' }),
    saveAuth: async (a) => {
      salvo = a;
    },
    fetchImpl,
  });
  await assert.rejects(() => fb.signIn(), /refresh_resposta_invalida/);
  assert.equal(salvo, 'intocado');
  fb.stop();
});

test('refresh 400 no formato real da API ({error:{message}}) cai para signUp', async () => {
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => ({ uid: 'morto', refreshToken: 'rip' }),
    saveAuth: async () => {},
    fetchImpl: mockFetch([
      ['/v1/token', { status: 400, body: { error: { message: 'TOKEN_EXPIRED : detalhe' } } }],
      [
        'accounts:signUp',
        { body: { localId: 'novo', idToken: 't', refreshToken: 'r', expiresIn: '3600' } },
      ],
    ]),
  });
  assert.equal(await fb.signIn(), 'novo');
  fb.stop();
});

test('signUp com resposta inválida lança — nunca persiste undefined', async () => {
  let salvo = 'intocado';
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => null,
    saveAuth: async (a) => {
      salvo = a;
    },
    fetchImpl: mockFetch([['accounts:signUp', { body: { pagina: '<html>' } }]]),
  });
  await assert.rejects(() => fb.signIn(), /signup_resposta_invalida/);
  assert.equal(salvo, 'intocado');
  fb.stop();
});

test('REST 401 renova o token e retenta uma vez', async () => {
  let deu401 = false;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/v1/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user_id: 'uid1',
          id_token: 'tNovo',
          refresh_token: 'r',
          expires_in: '3600',
        }),
      };
    }
    if (!deu401) {
      deu401 = true;
      return { ok: false, status: 401, json: async () => null };
    }
    assert.ok(url.includes('auth=tNovo'), 'retry deve usar o token novo');
    return { ok: true, status: 200, json: async () => ({ valor: 42 }) };
  };
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => null,
    saveAuth: async () => {},
    fetchImpl,
  });
  fb.idToken = 'tVelho';
  fb._refreshToken = 'r';
  assert.deepEqual(await fb.get('/devices/d1/meta'), { valor: 42 });
  fb.stop();
});

test('push retorna o pushId do RTDB', async () => {
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => null,
    saveAuth: async () => {},
    fetchImpl: mockFetch([['/devices/', { body: { name: '-Nabc123' } }]]),
  });
  fb.idToken = 't';
  assert.equal(await fb.push('/devices/d1/ack', 'env'), '-Nabc123');
  fb.stop();
});
