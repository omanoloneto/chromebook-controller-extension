// Rules do Wi-Fi da escola (/school/wifi, protocolo §9). SÓ RODA sob o emulador
// (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//
// PC DA ESCOLA = conta anônima cujo /device_uids aponta para um PC de
// /school/devices e que é o dono do meta/uid desse PC. Só ele lê e grava;
// professor, membro e Firebase só veem envelope que não abrem.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, { email, emailVerified = true } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return (
    b64u({ alg: 'none', typ: 'JWT' }) +
    '.' +
    b64u({
      sub: uid,
      user_id: uid,
      ...(email ? { email, email_verified: emailVerified } : {}),
      iat: agora,
      exp: agora + 3600,
      auth_time: agora,
      aud: 'demo-test',
      iss: 'https://securetoken.google.com/demo-test',
      firebase: {
        identities: email ? { 'google.com': [uid], email: [email] } : {},
        sign_in_provider: email ? 'google.com' : 'anonymous',
      },
    }) +
    '.'
  );
}

const FUNDADOR = fakeToken('uid-prof', { email: 'fundador@gmail.com' });
const MEMBRO = fakeToken('uid-prof2', { email: 'colega@gmail.com' });
const ANON = fakeToken('uid-anon');
// d1 e d2 da escola; d3 de professor isolado; o uid-mentira aponta para d1 sem ser o dono.
const DEV1 = fakeToken('uid-dev1');
const DEV2 = fakeToken('uid-dev2');
const DEV3 = fakeToken('uid-dev3');
const MENTIRA = fakeToken('uid-mentira');
const ID = 'AbCdEfGhIjKlMnOpQr_-09';

async function req(method, path, { auth, body, admin, query = '' } = {}) {
  const q = admin ? '' : `&auth=${auth ?? ''}`;
  return fetch(`http://${HOST}${path}.json?ns=${NS}${q}${query}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const permitido = async (r) => assert.equal((await r).ok, true, 'esperava permissão');
const negado = async (r) => assert.equal((await r).ok, false, 'esperava negação');
const agora = { '.sv': 'timestamp' };

async function semear() {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/', {
    admin: true,
    body: {
      school: {
        meta: { schoolUid: 'uid-prof', criadoEm: 1 },
        members: { 'colega@gmail,com': true },
        devices: { d1: true, d2: true },
      },
      devices: {
        d1: { meta: { uid: 'uid-dev1', pub: 'PUB1', label: 'PC 1', v: 4 } },
        d2: { meta: { uid: 'uid-dev2', pub: 'PUB2', label: 'PC 2', v: 4 } },
        d3: { meta: { uid: 'uid-dev3', pub: 'PUB3', label: 'PC 3', v: 4 } },
      },
      device_uids: { 'uid-dev1': 'd1', 'uid-dev2': 'd2', 'uid-dev3': 'd3', 'uid-mentira': 'd1' },
    },
  });
}

test('wifi: só PC da escola lê; professor, membro, PC de fora e quem finge ser outro PC não', { skip }, async () => {
  await semear();
  await req('PUT', '/school/wifi/meta', { admin: true, body: { de: 'd1', ts: 1 } });
  await permitido(req('GET', '/school/wifi', { auth: DEV1 }));
  await permitido(req('GET', '/school/wifi/chaves', { auth: DEV2, query: '&shallow=true' }));
  for (const quem of [FUNDADOR, MEMBRO, DEV3, MENTIRA, ANON]) {
    await negado(req('GET', '/school/wifi', { auth: quem }));
  }
});

test('wifi: a chave da frota nasce uma vez só, por quem diz ser', { skip }, async () => {
  await semear();
  await negado(req('PUT', '/school/wifi/meta', { auth: DEV1, body: { de: 'd2', ts: agora } }));
  await negado(req('PUT', '/school/wifi/meta', { auth: DEV3, body: { de: 'd3', ts: agora } }));
  await permitido(req('PUT', '/school/wifi/meta', { auth: DEV1, body: { de: 'd1', ts: agora } }));
  await negado(req('PUT', '/school/wifi/meta', { auth: DEV2, body: { de: 'd2', ts: agora } }));
  await negado(req('DELETE', '/school/wifi/meta', { auth: DEV1 }));
  await negado(req('PUT', '/school/wifi/meta', { auth: DEV1, body: { de: 'd1', ts: agora, x: 1 } }));
});

test('wifi: cada PC publica só a própria pública, igual à do meta', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/school/wifi/pubs/d1', { auth: DEV1, body: 'PUB1' }));
  await negado(req('PUT', '/school/wifi/pubs/d1', { auth: DEV1, body: 'OUTRA' }));
  await negado(req('PUT', '/school/wifi/pubs/d2', { auth: DEV1, body: 'PUB2' }));
  await negado(req('PUT', '/school/wifi/pubs/d1', { auth: MENTIRA, body: 'PUB1' }));
  await negado(req('PUT', '/school/wifi/pubs/d3', { auth: DEV3, body: 'PUB3' }));
});

test('wifi: a chave selada vai só para PC da escola, assinada por quem entrega', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/school/wifi/chaves/d2', { auth: DEV1, body: { de: 'd1', env: 'selado' } }));
  await permitido(req('PUT', '/school/wifi/chaves/d1', { auth: DEV1, body: { de: 'd1', env: 'selado' } }));
  await negado(req('PUT', '/school/wifi/chaves/d3', { auth: DEV1, body: { de: 'd1', env: 'selado' } }));
  await negado(req('PUT', '/school/wifi/chaves/d2', { auth: DEV1, body: { de: 'd2', env: 'selado' } }));
  await negado(req('PUT', '/school/wifi/chaves/d2', { auth: DEV1, body: { de: 'd1', env: 'x'.repeat(1024) } }));
  await negado(req('PUT', '/school/wifi/chaves/d2', { auth: DEV1, body: { de: 'd1', env: 'selado', y: 1 } }));
  await negado(req('PUT', '/school/wifi/chaves/d2', { auth: DEV3, body: { de: 'd3', env: 'selado' } }));
});

test('wifi: redes são envelope com hora do servidor e id de 22 caracteres', { skip }, async () => {
  await semear();
  await permitido(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV2, body: { env: 'cifrado', ts: agora } }));
  await permitido(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV1, body: { env: 'outro', ts: agora } }));
  await negado(req('PUT', '/school/wifi/redes/curto', { auth: DEV1, body: { env: 'cifrado', ts: agora } }));
  await negado(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV1, body: { env: 'cifrado' } }));
  await negado(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV1, body: { env: 'cifrado', ts: 9999999999999 } }));
  await negado(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV1, body: { env: 'cifrado', ts: agora, senha: 'x' } }));
  await negado(req('PUT', `/school/wifi/redes/${ID}`, { auth: DEV3, body: { env: 'cifrado', ts: agora } }));
  await negado(req('PUT', `/school/wifi/redes/${ID}`, { auth: MEMBRO, body: { env: 'cifrado', ts: agora } }));
  await negado(req('PUT', '/school/wifi/outra', { auth: DEV1, body: { env: 'x', ts: agora } }));
});
