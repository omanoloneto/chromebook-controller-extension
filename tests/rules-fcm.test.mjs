// Rules do /fcm/{uid}: o token do FCM de cada celular do professor, para o
// push dos recados (Cloud Function avisarRecado, no repositório do app). Só o
// dono lê e grava.
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, { email } = {}) {
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
        sign_in_provider: email ? 'google.com' : 'anonymous',
      },
    }) +
    '.'
  );
}

const PROF = fakeToken('uid-prof', { email: 'prof@gmail.com' });
const ANONIMO = fakeToken('uid-anon');
const OUTRO = fakeToken('uid-outro', { email: 'outro@gmail.com' });
const CHAVE = 'AbCdEfGhIjKlMnOpQr_-09';

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
const token = (extra = {}) => ({ t: 'dQw4w9WgXcQ:APA91bH-abc_def', ts: { '.sv': 'timestamp' }, ...extra });

test('fcm: o dono grava, lê e apaga o próprio token', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await permitido(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: token() }));
  await permitido(req('GET', '/fcm/uid-prof', { auth: PROF }));
  // Professor só com a conta anônima do app também recebe.
  await permitido(req('PUT', `/fcm/uid-anon/${CHAVE}`, { auth: ANONIMO, body: token() }));
  await permitido(req('DELETE', `/fcm/uid-prof/${CHAVE}`, { auth: PROF }));
});

test('fcm: ninguém mais lê nem grava', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await req('PUT', `/fcm/uid-prof/${CHAVE}`, { admin: true, body: { t: 'x', ts: 1 } });
  await negado(req('GET', '/fcm/uid-prof', { auth: OUTRO }));
  await negado(req('GET', '/fcm/uid-prof'));
  await negado(req('GET', '/fcm', { auth: PROF }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: OUTRO, body: token() }));
  await negado(req('DELETE', `/fcm/uid-prof/${CHAVE}`, { auth: OUTRO }));
});

test('fcm: só {t, ts} na chave de 22 caracteres', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await negado(req('PUT', '/fcm/uid-prof/curta', { auth: PROF, body: token() }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: token({ extra: 1 }) }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: token({ t: '' }) }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: token({ t: 'x'.repeat(4096) }) }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: token({ ts: 'agora' }) }));
  await negado(req('PUT', `/fcm/uid-prof/${CHAVE}`, { auth: PROF, body: { t: 'x' } }));
  await negado(req('PUT', '/fcm/uid-prof', { auth: PROF, body: 'cru' }));
});
