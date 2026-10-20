// Rules da última captura de um PC (/devices/{id}/snapshot: tela ou câmera,
// cifrada para o professor). SÓ RODA sob o emulador (pula sem
// FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//   (SERIAL obrigatório: arquivos de emulador compartilham o banco.)
//
// Quem grava é o agente do PC; o professor do vínculo e a escola só apagam
// (o "Excluir" da captura no app).
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
const MEMBRO_NV = fakeToken('uid-prof2', { email: 'colega@gmail.com', emailVerified: false });
const INTRUSO = fakeToken('uid-intruso', { email: 'intruso@gmail.com' });
const ISOLADO = fakeToken('uid-isolado');
const ANON = fakeToken('uid-anon');
const DEV1 = fakeToken('uid-dev1');
const DEV2 = fakeToken('uid-dev2');

async function req(method, path, { auth, body, admin } = {}) {
  const q = admin ? '' : `&auth=${auth ?? ''}`;
  return fetch(`http://${HOST}${path}.json?ns=${NS}${q}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const permitido = async (r) => assert.equal((await r).ok, true, 'esperava permissão');
const negado = async (r) => assert.equal((await r).ok, false, 'esperava negação');
const captura = () => ({ env: 'ciphertext', ts: 1790000000000 });

function device(uid, teacherUid) {
  return {
    meta: { uid, pub: 'PUB', label: 'PC', v: 4 },
    pairing: { token: 'tok' },
    bind: { teacherUid, teacherPub: 'TP', teacherName: 'T', token: 'tok', ts: 1 },
    snapshot: captura(),
  };
}

async function semear() {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/', {
    admin: true,
    body: {
      school: {
        meta: { schoolUid: 'uid-prof', criadoEm: 1 },
        keypair: { keys: 'PRIV:PUB', ts: 1 },
        members: { 'colega@gmail,com': true },
      },
      devices: {
        d1: device('uid-dev1', 'uid-prof'),
        d2: device('uid-dev2', 'uid-prof'),
        d3: device('uid-dev3', 'uid-isolado'),
      },
    },
  });
}

async function valor(path) {
  const r = await req('GET', path, { admin: true });
  return r.json();
}

test('snapshot: só o PC grava a própria captura', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/devices/d1/snapshot', { auth: DEV1, body: captura() }));
  await negado(req('PUT', '/devices/d1/snapshot', { auth: DEV2, body: captura() }));
  await negado(req('PUT', '/devices/d1/snapshot', { auth: MEMBRO, body: captura() }));
  await negado(req('PUT', '/devices/d1/snapshot', { auth: FUNDADOR, body: captura() }));
  await negado(req('PUT', '/devices/d1/snapshot/env', { auth: MEMBRO, body: 'outro' }));
});

test('snapshot: escola e professor do vínculo apagam; intruso, outro PC e anônimo não', { skip }, async () => {
  await semear();
  await negado(req('DELETE', '/devices/d1/snapshot', { auth: INTRUSO }));
  await negado(req('DELETE', '/devices/d1/snapshot', { auth: MEMBRO_NV }));
  await negado(req('DELETE', '/devices/d1/snapshot', { auth: ANON }));
  await negado(req('DELETE', '/devices/d1/snapshot', { auth: DEV2 }));
  assert.notEqual(await valor('/devices/d1/snapshot'), null);

  await permitido(req('DELETE', '/devices/d1/snapshot', { auth: MEMBRO }));
  assert.equal(await valor('/devices/d1/snapshot'), null);
  assert.notEqual(await valor('/devices/d1/meta'), null, 'o resto do PC fica');

  await permitido(req('DELETE', '/devices/d2/snapshot', { auth: FUNDADOR }));
  await permitido(req('DELETE', '/devices/d3/snapshot', { auth: ISOLADO }));
  await permitido(req('DELETE', '/devices/d2/snapshot', { auth: DEV2 }));
});
