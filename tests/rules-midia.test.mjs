// Rules das fotos e vídeos da Câmera do Celita: índice /midia/{deviceId},
// progresso /envios/{deviceId} e as partes midia/{uid}/{mid}/{r}_{n}.bin.
// SÓ RODA sob os emuladores (pula sem FIREBASE_DATABASE_EMULATOR_HOST e
// FIREBASE_STORAGE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//
// Quem grava é o agente do PC (dono de meta/uid) e só com o PC vinculado à
// escola; quem lê é o dono ou membro da escola; membro só apaga.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const STORAGE = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const BUCKET = 'demo-test.appspot.com';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';
const skipStorage = STORAGE ? false : 'requer o emulador (FIREBASE_STORAGE_EMULATOR_HOST)';

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

const MEMBRO = fakeToken('uid-prof2', { email: 'colega@gmail.com' });
const INTRUSO = fakeToken('uid-intruso', { email: 'intruso@gmail.com' });
const NAO_VERIFICADO = fakeToken('uid-nv', { email: 'nv@gmail.com', emailVerified: false });
const DEV1 = fakeToken('uid-dev1');
const DEV3 = fakeToken('uid-dev3');

const MID = 'AbCdEfGhIjKlMnOp';
const R22 = 'AbCdEfGhIjKlMnOpQr_-09';

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

function device(uid, teacherUid) {
  return {
    meta: { uid, pub: 'PUB', label: 'PC', v: 4 },
    pairing: { token: 'tok' },
    ...(teacherUid
      ? { bind: { teacherUid, teacherPub: 'TP', teacherName: 'T', token: 'tok', ts: 1 } }
      : {}),
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
      devices: { d1: device('uid-dev1', 'uid-prof'), d3: device('uid-dev3', 'uid-isolado') },
      midia: { d1: { [MID]: { env: 'e', ts: 1 } } },
    },
  });
}

const item = () => ({ env: 'ciphertext', ts: { '.sv': 'timestamp' } });
const envio = (u, extra = {}) => ({ u, r: R22, partes: 3, prontas: 0, bytes: 10, ts: 1, ...extra });

test('midia: PC da escola publica o índice; formato e id conferidos', { skip }, async () => {
  await semear();
  await permitido(req('PUT', `/midia/d1/${MID}`, { auth: DEV1, body: item() }));
  await negado(req('PUT', '/midia/d1/curto', { auth: DEV1, body: item() }));
  await negado(req('PUT', `/midia/d1/${MID}`, { auth: DEV1, body: { env: 'x', ts: 1, extra: 1 } }));
  await negado(req('PUT', `/midia/d1/${MID}`, { auth: DEV1, body: { env: 'x'.repeat(70000), ts: 1 } }));
  // Outro PC, PC fora da escola e professor não escrevem.
  await negado(req('PUT', `/midia/d1/${MID}`, { auth: DEV3, body: item() }));
  await negado(req('PUT', `/midia/d3/${MID}`, { auth: DEV3, body: item() }));
  await negado(req('PUT', `/midia/d1/${MID}`, { auth: MEMBRO, body: item() }));
});

test('midia: membro e dono leem e apagam; intruso não', { skip }, async () => {
  await semear();
  await permitido(req('GET', '/midia/d1', { auth: MEMBRO }));
  await permitido(req('GET', '/midia/d1', { auth: DEV1 }));
  await negado(req('GET', '/midia/d1', { auth: INTRUSO }));
  await negado(req('GET', '/midia/d1', { auth: NAO_VERIFICADO }));
  await negado(req('DELETE', `/midia/d1/${MID}`, { auth: INTRUSO }));
  await permitido(req('DELETE', `/midia/d1/${MID}`, { auth: MEMBRO }));
});

test('envios: o PC escreve o progresso com o próprio uid; membro só lê e apaga', { skip }, async () => {
  await semear();
  await permitido(req('PUT', `/envios/d1/${MID}`, { auth: DEV1, body: envio('uid-dev1') }));
  await permitido(req('PATCH', `/envios/d1/${MID}`, { auth: DEV1, body: { prontas: 3 } }));
  await negado(req('PATCH', `/envios/d1/${MID}`, { auth: DEV1, body: { prontas: 4 } }));
  await permitido(req('PATCH', `/envios/d1/${MID}`, { auth: DEV1, body: { erro: 'falhou' } }));
  await negado(req('PUT', `/envios/d1/${MID}`, { auth: DEV1, body: envio('uid-outro') }));
  await negado(req('PUT', `/envios/d1/${MID}`, { auth: DEV1, body: envio('uid-dev1', { r: 'curto' }) }));
  await negado(req('PUT', `/envios/d1/${MID}`, { auth: MEMBRO, body: envio('uid-prof2') }));
  await negado(req('PUT', `/envios/d3/${MID}`, { auth: DEV3, body: envio('uid-dev3') }));
  await permitido(req('GET', `/envios/d1/${MID}`, { auth: MEMBRO }));
  await negado(req('GET', `/envios/d1/${MID}`, { auth: INTRUSO }));
  await permitido(req('DELETE', `/envios/d1/${MID}`, { auth: MEMBRO }));
});

async function storage(method, nome, { auth, body } = {}) {
  const base = `http://${STORAGE}/v0/b/${BUCKET}/o`;
  const url = method === 'POST'
    ? `${base}?name=${encodeURIComponent(nome)}`
    : `${base}/${encodeURIComponent(nome)}${method === 'GET' ? '?alt=media' : ''}`;
  return fetch(url, {
    method,
    headers: { ...(auth ? { Authorization: `Firebase ${auth}` } : {}), 'Content-Type': 'application/octet-stream' },
    body,
  });
}

test('storage midia/: só o PC sobe a própria parte; professor verificado baixa e apaga', { skip: skipStorage }, async () => {
  const parte = `midia/uid-dev1/${MID}/${R22}_0.bin`;
  await permitido(storage('POST', parte, { auth: DEV1, body: new Uint8Array(1024) }));
  await negado(storage('POST', `midia/uid-dev1/${MID}/${R22}_1.bin`, { auth: DEV3, body: new Uint8Array(8) }));
  await negado(storage('POST', `midia/uid-dev1/${MID}/../x.bin`, { auth: DEV1, body: new Uint8Array(8) }));
  await negado(storage('POST', `midia/uid-dev1/${MID}/${R22}_2.bin`, {
    auth: DEV1, body: new Uint8Array(4 * 1024 * 1024 + 65),
  }));
  await negado(storage('GET', parte, { auth: NAO_VERIFICADO }));
  await permitido(storage('GET', parte, { auth: MEMBRO }));
  await negado(storage('DELETE', parte, { auth: NAO_VERIFICADO }));
  await permitido(storage('DELETE', parte, { auth: MEMBRO }));
});
