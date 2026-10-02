// Testes do cliente Firebase mínimo (parsing SSE + auth com fetch mockado).
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamEvent, FirebaseSession, QUIET_REFRESH_MS } from '../src/lib/firebase.js';

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

// ---- Caminho lateral (escritas novas do PC: up, /thumbs) ----------------------
// Rules atrasadas respondem 401 a toda escrita nova. O caminho normal trataria
// isso como token vencido e reconectaria TODOS os streams (o de comandos
// inclusive) — a cada escrita. O lateral nunca reconecta e renova no máximo
// 1× a cada 10 min.

function sessaoLateral({ statusDados = 401, refreshOk = true } = {}) {
  const chamadas = { dados: [], refresh: 0 };
  const fetchImpl = async (url, opts) => {
    if (url.includes('/v1/token')) {
      chamadas.refresh++;
      if (!refreshOk) return { ok: false, status: 503, json: async () => null };
      return {
        ok: true,
        status: 200,
        json: async () => ({ user_id: 'uid1', id_token: `t${chamadas.refresh}`, refresh_token: 'r', expires_in: '3600' }),
      };
    }
    chamadas.dados.push({ url, method: opts.method });
    if (statusDados === 'rede') throw new Error('offline');
    return { ok: statusDados < 400, status: statusDados, json: async () => ({ name: '-Npush' }) };
  };
  const fb = new FirebaseSession({
    apiKey: 'k',
    databaseURL: 'https://x.firebaseio.com',
    loadAuth: async () => null,
    saveAuth: async () => {},
    fetchImpl,
  });
  fb.idToken = 't0';
  fb._refreshToken = 'r';
  const reconexoes = [];
  fb._streams.add({ _reconnect: (m) => reconexoes.push(m), close() {} });
  return { fb, chamadas, reconexoes };
}

test('putQuiet com 401: renova sem reconectar streams, retenta uma vez e não lança', async () => {
  const { fb, chamadas, reconexoes } = sessaoLateral();
  const r = await fb.putQuiet('/thumbs/d1', { env: 'x' });
  assert.equal(r.status, 401);
  assert.equal(chamadas.refresh, 1);
  assert.equal(chamadas.dados.length, 2); // original + 1 retry
  assert.ok(chamadas.dados[1].url.includes('auth=t1'), 'retry com o token novo');
  assert.deepEqual(reconexoes, [], 'nenhum stream reconectado');
  fb.stop();
});

test('caminho lateral: no máximo 1 renovação a cada 10 min (compartilhada entre os métodos)', async (t) => {
  const { fb, chamadas, reconexoes } = sessaoLateral({ statusDados: 403 });
  let agora = 1_000_000;
  t.mock.method(Date, 'now', () => agora);
  await fb.postQuiet('/devices/d1/up', 'env');
  await fb.putQuiet('/thumbs/d1', {});
  await fb.deleteQuiet('/thumbs/d1');
  await fb.getQuiet('/devices/d1/up', { shallow: true });
  assert.equal(chamadas.refresh, 1);
  agora += QUIET_REFRESH_MS - 1;
  await fb.putQuiet('/thumbs/d1', {});
  assert.equal(chamadas.refresh, 1);
  agora += 1;
  await fb.putQuiet('/thumbs/d1', {});
  assert.equal(chamadas.refresh, 2);
  assert.deepEqual(reconexoes, []);
  fb.stop();
});

test('caminho lateral: rede fora vira status 0; refresh que falha também não lança', async () => {
  const off = sessaoLateral({ statusDados: 'rede' });
  assert.deepEqual(await off.fb.postQuiet('/devices/d1/up', 'env'), { status: 0, body: null });
  off.fb.stop();
  const semRefresh = sessaoLateral({ refreshOk: false });
  const r = await semRefresh.fb.deleteQuiet('/thumbs/d1');
  assert.equal(r.status, 401);
  assert.equal(semRefresh.chamadas.dados.length, 1, 'sem retry quando a renovação falhou');
  assert.deepEqual(semRefresh.reconexoes, []);
  semRefresh.fb.stop();
});

test('getQuiet shallow e postQuiet devolvem o corpo', async () => {
  const { fb, chamadas } = sessaoLateral({ statusDados: 200 });
  const r = await fb.postQuiet('/devices/d1/up', 'env');
  assert.deepEqual(r, { status: 200, body: { name: '-Npush' } });
  await fb.getQuiet('/devices/d1/up', { shallow: true });
  assert.ok(chamadas.dados[1].url.endsWith('&shallow=true'));
  assert.equal(chamadas.refresh, 0);
  fb.stop();
});

test('caminho normal continua reconectando os streams no 401 (comportamento antigo)', async () => {
  const { fb, reconexoes } = sessaoLateral({ statusDados: 401 });
  await assert.rejects(() => fb.put('/devices/d1/report', {}), /rtdb_PUT_401/);
  assert.deepEqual(reconexoes, ['token_renovado']);
  fb.stop();
});
