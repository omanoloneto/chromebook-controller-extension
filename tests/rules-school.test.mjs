// Rules do workspace da escola (/school/* + gate GOOGLE = auth.token.email).
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//   (SERIAL obrigatório: arquivos de emulador compartilham o banco.)
//
// IMPORTANTE: o gate de professor é `auth.token.email != null` — NÃO
// `auth.provider === 'google'`: o fundador fez linkWithCredential sobre a
// conta anônima e a sessão dele emite sign_in_provider 'anonymous' + email.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, { email, provider = 'anonymous' } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return (
    b64u({ alg: 'none', typ: 'JWT' }) +
    '.' +
    b64u({
      sub: uid,
      user_id: uid,
      ...(email ? { email, email_verified: true } : {}),
      iat: agora,
      exp: agora + 3600,
      auth_time: agora,
      aud: 'demo-test',
      iss: 'https://securetoken.google.com/demo-test',
      firebase: {
        identities: email ? { 'google.com': [uid], email: [email] } : {},
        sign_in_provider: provider,
      },
    }) +
    '.'
  );
}

// Fundador: uid antigo (dono dos binds), sessão ainda 'anonymous' MAS com email.
const FUNDADOR = fakeToken('uid-prof', { email: 'fundador@gmail.com', provider: 'anonymous' });
// Professor novo: login Google puro.
const PROF_G2 = fakeToken('uid-prof2', { email: 'colega@gmail.com', provider: 'google.com' });
// Anônimos (sem email): device e um professor isolado alheio.
const DEV = fakeToken('uid-device');
const ANON = fakeToken('uid-anon');

async function req(method, path, { auth, body, admin } = {}) {
  const q = admin ? '' : `&auth=${auth ?? ''}`;
  const res = await fetch(`http://${HOST}${path}.json?ns=${NS}${q}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}
const permitido = async (r) => assert.equal((await r).ok, true, 'esperava permissão');
const negado = async (r) => assert.equal((await r).ok, false, 'esperava negação');

// Escola criada + device pareado com a escola (bind.teacherUid = schoolUid).
async function semearEscola() {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/school', {
    admin: true,
    body: {
      meta: { schoolUid: 'uid-prof', criadoEm: 1 },
      keypair: { keys: 'PRIV:PUB', ts: 1 },
    },
  });
  await req('PUT', '/devices/d1', {
    admin: true,
    body: {
      meta: { uid: 'uid-device', pub: 'PUB_DEVICE', label: 'PC 1', v: 4 },
      pairing: { token: 'tok-atual' },
      bind: {
        teacherUid: 'uid-prof',
        teacherPub: 'PUB_ESCOLA',
        teacherName: 'Prof',
        token: 'tok-atual',
        ts: 1,
      },
    },
  });
}

test('school/meta+keypair: create-once por Google; anônimo nem lê', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await permitido(
    req('PUT', '/school/meta', { auth: FUNDADOR, body: { schoolUid: 'uid-prof', criadoEm: 1 } }),
  );
  await permitido(
    req('PUT', '/school/keypair', { auth: FUNDADOR, body: { keys: 'PRIV:PUB', ts: 1 } }),
  );
  // Sobrescrever a chave = negado p/ QUALQUER professor (troca só via console).
  await negado(req('PUT', '/school/keypair', { auth: PROF_G2, body: { keys: 'HACK', ts: 2 } }));
  await negado(req('PUT', '/school/meta', { auth: PROF_G2, body: { schoolUid: 'uid-prof2', criadoEm: 2 } }));
  // Leitura: professor Google sim; anônimo/device não.
  await permitido(req('GET', '/school/keypair', { auth: PROF_G2 }));
  await negado(req('GET', '/school/keypair', { auth: DEV }));
  await negado(req('GET', '/school/keypair', { auth: ANON }));
});

test('devices da escola: qualquer professor Google comanda; anônimo alheio não', { skip }, async () => {
  await semearEscola();
  // Professor novo (não é o dono do bind) lê, enfileira cmd e grava state.
  await permitido(req('GET', '/devices/d1', { auth: PROF_G2 }));
  await permitido(req('POST', '/devices/d1/cmd', { auth: PROF_G2, body: 'env' }));
  await permitido(req('PUT', '/devices/d1/state/rules', { auth: PROF_G2, body: 'env' }));
  // Fundador (sessão anonymous + email) continua funcionando — regressão crítica.
  await permitido(req('POST', '/devices/d1/cmd', { auth: FUNDADOR, body: 'env' }));
  // Anônimo sem email e sem bind: nada.
  await negado(req('GET', '/devices/d1', { auth: ANON }));
  await negado(req('POST', '/devices/d1/cmd', { auth: ANON, body: 'forja' }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: ANON, body: 'forja' }));
});

test('bind: professor Google pareia PELA escola (teacherUid = schoolUid); token segue obrigatório', { skip }, async () => {
  await semearEscola();
  await req('PUT', '/devices/d2', {
    admin: true,
    body: { meta: { uid: 'uid-d2', pub: 'P2', label: 'PC 2', v: 4 }, pairing: { token: 'tok-2' } },
  });
  // PROF_G2 pareia d2 em nome da escola.
  await permitido(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'Colega', token: 'tok-2', ts: 2 },
    }),
  );
  // teacherUid arbitrário (nem o dele, nem o da escola) → negado.
  await req('PUT', '/devices/d2/pairing/token', { admin: true, body: 'tok-3' });
  await negado(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-x', teacherPub: 'X', teacherName: 'X', token: 'tok-3', ts: 3 },
    }),
  );
  // Sem o token atual → negado (mesmo sendo Google).
  await negado(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'C', token: 'tok-velho', ts: 4 },
    }),
  );
  // Professor Google pode desfazer o bind (esquecer PC da escola).
  await permitido(req('DELETE', '/devices/d1/bind', { auth: PROF_G2 }));
});

test('school/stores: chaves válidas por Google; inválida/anônimo negados', { skip }, async () => {
  await semearEscola();
  await permitido(
    req('PUT', '/school/stores/turmas', { auth: PROF_G2, body: { rev: 1, env: 'env' } }),
  );
  await permitido(
    req('PUT', '/school/stores/rules', { auth: FUNDADOR, body: { rev: 1, env: 'env' } }),
  );
  await negado(req('PUT', '/school/stores/outra', { auth: PROF_G2, body: { rev: 1, env: 'x' } }));
  await negado(req('PUT', '/school/stores/turmas', { auth: ANON, body: { rev: 2, env: 'forja' } }));
  await permitido(req('GET', '/school/stores', { auth: FUNDADOR }));
  await negado(req('GET', '/school/stores', { auth: DEV }));
});

test('school/aulas: trava é do dono; takeover só expirada (>15min)', { skip }, async () => {
  await semearEscola();
  const agora = Date.now();
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: FUNDADOR,
      body: { uid: 'uid-prof', ts: agora, env: 'env' },
    }),
  );
  // Outro professor: trava fresca → negado (update e delete).
  await negado(
    req('PUT', '/school/aulas/d1', { auth: PROF_G2, body: { uid: 'uid-prof2', ts: agora, env: 'e' } }),
  );
  await negado(req('DELETE', '/school/aulas/d1', { auth: PROF_G2 }));
  // Dono atualiza (heartbeat) e deleta.
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: FUNDADOR,
      body: { uid: 'uid-prof', ts: agora + 1, env: 'env' },
    }),
  );
  await permitido(req('DELETE', '/school/aulas/d1', { auth: FUNDADOR }));
  // Trava órfã (ts velho) → takeover permitido.
  await req('PUT', '/school/aulas/d1', {
    admin: true,
    body: { uid: 'uid-prof', ts: agora - 16 * 60000, env: 'env' },
  });
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: PROF_G2,
      body: { uid: 'uid-prof2', ts: agora, env: 'env' },
    }),
  );
});

test('history e wallpapers da escola: qualquer professor Google', { skip }, async () => {
  await semearEscola();
  await permitido(
    req('PUT', '/history/uid-prof/123/meta', { auth: PROF_G2, body: 'env' }),
  );
  await permitido(req('GET', '/history/uid-prof', { auth: PROF_G2 }));
  await negado(req('GET', '/history/uid-prof', { auth: ANON }));
  await permitido(
    req('PUT', '/wallpapers/uid-prof', {
      auth: PROF_G2,
      body: { hash: 'abc', jpeg: 'AAAA', ts: 1 },
    }),
  );
});
