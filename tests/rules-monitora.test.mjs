// Rules da monitora: school/monitores, school/monitorKey e o canal devices/{id}/mon.
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//   (SERIAL obrigatório: arquivos de emulador compartilham o banco.)
//
// IMPORTANTE: professor = fundador (uid de school/meta/schoolUid) OU e-mail
// verificado com entrada em school/members. Nunca `auth.provider === 'google'`:
// o fundador fez linkWithCredential sobre a conta anônima e a sessão dele emite
// sign_in_provider 'anonymous' + email.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, { email, provider = 'anonymous', emailVerified = true } = {}) {
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
        sign_in_provider: provider,
      },
    }) +
    '.'
  );
}

// Fundador: uid antigo (dono dos binds), sessão ainda 'anonymous' MAS com email.
const FUNDADOR = fakeToken('uid-prof', { email: 'fundador@gmail.com', provider: 'anonymous' });
// Professor novo: login Google puro, liberado pelo fundador em school/members.
const PROF_G2 = fakeToken('uid-prof2', { email: 'colega@gmail.com', provider: 'google.com' });
// Mesmo e-mail da lista, mas o provedor não verificou o endereço.
const PROF_G2_NV = fakeToken('uid-prof2', {
  email: 'colega@gmail.com',
  provider: 'password',
  emailVerified: false,
});
// Conta Google verificada que ninguém liberou.
const INTRUSO = fakeToken('uid-intruso', { email: 'intruso@gmail.com', provider: 'google.com' });
// Anônimos (sem email): device e um professor isolado alheio.
const DEV = fakeToken('uid-device');
const ANON = fakeToken('uid-anon');

const MEMBRO_G2 = 'colega@gmail,com';

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

const MONITORA = fakeToken('uid-mon', { email: 'monitora@gmail.com', provider: 'google.com' });
const MON_NV = fakeToken('uid-mon', { email: 'monitora@gmail.com', provider: 'password', emailVerified: false });
const MON_KEY = 'monitora@gmail,com';
const PUB_MON = 'A'.repeat(43);

async function semear() {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/school', {
    admin: true,
    body: {
      meta: { schoolUid: 'uid-prof', criadoEm: 1 },
      keypair: { keys: 'PRIV:PUB', ts: 1 },
      members: { [MEMBRO_G2]: true },
      monitores: { [MON_KEY]: true },
      monitorKey: { keys: 'MPRIV:MPUB', ts: 1 },
      devices: { d1: true },
    },
  });
  const pc = (uid, n) => ({
    meta: { uid, pub: 'PUB_DEVICE', label: `PC ${n}`, v: 4 },
    pairing: { token: 'tok' },
    bind: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'Prof', token: 'tok', ts: 1, numero: n },
    presence: { lastSeen: 1 },
    report: { env: 'abas', ts: 1 },
    snapshot: { env: 'camera', ts: 1 },
    mon: { pub: PUB_MON, ack: { a1: 'ack' }, snapshot: { env: 'tela', ts: 1 }, carga: { env: 'carga', ts: 1 } },
  });
  await req('PUT', '/devices/d1', { admin: true, body: pc('uid-device', 1) });
  // d9 existe no banco, mas não está no roster da escola.
  await req('PUT', '/devices/d9', { admin: true, body: pc('uid-d9', 9) });
  await req('PUT', '/midia/d1/aaaaaaaaaaaaaaaa', { admin: true, body: { env: 'foto', ts: 1 } });
  await req('PUT', '/archive/d1/nav/2026-11-16/k1', { admin: true, body: { env: 'nav', ts: 1 } });
}

test('monitora lê só o que a sala precisa', { skip }, async () => {
  await semear();
  await permitido(req('GET', '/school/devices', { auth: MONITORA }));
  await permitido(req('GET', '/school/monitorKey', { auth: MONITORA }));
  await permitido(req('GET', `/school/monitores/${MON_KEY}`, { auth: MONITORA }));
  for (const p of ['meta', 'presence', 'bind/numero', 'mon']) {
    await permitido(req('GET', `/devices/d1/${p}`, { auth: MONITORA }));
  }
  for (const p of ['/devices/d1', '/devices/d1/report', '/devices/d1/snapshot', '/devices/d1/bind',
                   '/devices/d1/state', '/midia/d1', '/archive/d1', '/school/keypair', '/school/stores',
                   '/school/members', '/school/monitores', '/history/uid-prof', '/thumbs/d1']) {
    await negado(req('GET', p, { auth: MONITORA }));
  }
  // PC fora do roster da escola: nada.
  await negado(req('GET', '/devices/d9/mon', { auth: MONITORA }));
});

test('monitora só comanda pelo canal dela', { skip }, async () => {
  await semear();
  await permitido(req('POST', '/devices/d1/mon/cmd', { auth: MONITORA, body: 'env' }));
  await permitido(req('DELETE', '/devices/d1/mon/ack/a1', { auth: MONITORA }));
  await permitido(req('DELETE', '/devices/d1/mon/snapshot', { auth: MONITORA }));
  await negado(req('POST', '/devices/d1/cmd', { auth: MONITORA, body: 'env' }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: MONITORA, body: 'env' }));
  await negado(req('PUT', '/devices/d1/mon/pub', { auth: MONITORA, body: 'B'.repeat(43) }));
  await negado(req('PUT', '/devices/d1/mon/carga', { auth: MONITORA, body: { env: 'x', ts: 2 } }));
  await negado(req('PUT', '/devices/d1/mon/snapshot', { auth: MONITORA, body: { env: 'x', ts: 2 } }));
  await negado(req('DELETE', '/devices/d1/bind', { auth: MONITORA }));
  await negado(req('POST', '/devices/d9/mon/cmd', { auth: MONITORA, body: 'env' }));
  await negado(req('PUT', '/school/monitorKey', { auth: MONITORA, body: { keys: 'x', ts: 2 } }));
  await negado(req('PUT', `/school/monitores/outra@gmail,com`, { auth: MONITORA, body: true }));
  await negado(req('PUT', `/school/members/${MON_KEY}`, { auth: MONITORA, body: true }));
});

test('e-mail não verificado e monitora removida perdem tudo', { skip }, async () => {
  await semear();
  await negado(req('GET', '/devices/d1/mon', { auth: MON_NV }));
  await negado(req('POST', '/devices/d1/mon/cmd', { auth: MON_NV, body: 'env' }));
  await permitido(req('DELETE', `/school/monitores/${MON_KEY}`, { auth: FUNDADOR }));
  await negado(req('GET', '/school/monitorKey', { auth: MONITORA }));
  await negado(req('GET', '/devices/d1/mon', { auth: MONITORA }));
  await negado(req('POST', '/devices/d1/mon/cmd', { auth: MONITORA, body: 'env' }));
});

test('fundador cuida das monitoras; professor publica a chave nos PCs', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/school/monitores/nova@gmail,com', { auth: FUNDADOR, body: true }));
  await negado(req('PUT', '/school/monitores/nova@gmail,com', { auth: PROF_G2, body: true }));
  await permitido(req('GET', '/school/monitores', { auth: PROF_G2 }));
  await permitido(req('PUT', '/school/monitorKey', { auth: FUNDADOR, body: { keys: 'NOVA', ts: 2 } }));
  await negado(req('PUT', '/school/monitorKey', { auth: PROF_G2, body: { keys: 'X', ts: 3 } }));
  await permitido(req('GET', '/school/monitorKey', { auth: PROF_G2 }));
  await permitido(req('PUT', '/devices/d1/mon/pub', { auth: PROF_G2, body: 'C'.repeat(43) }));
  await negado(req('PUT', '/devices/d1/mon/pub', { auth: PROF_G2, body: 'curta' }));
  await negado(req('GET', '/school/monitorKey', { auth: INTRUSO }));
  await negado(req('PUT', '/devices/d1/mon/pub', { auth: INTRUSO, body: 'D'.repeat(43) }));
});

test('o PC grava o canal da monitora e só apaga os comandos', { skip }, async () => {
  await semear();
  await req('PUT', '/devices/d1/mon/cmd/c1', { admin: true, body: 'env' });
  await negado(req('PUT', '/devices/d1/mon/cmd/c1', { auth: DEV, body: 'outro' }));
  await permitido(req('DELETE', '/devices/d1/mon/cmd/c1', { auth: DEV }));
  await permitido(req('PUT', '/devices/d1/mon/ack/c1', { auth: DEV, body: 'ack' }));
  await permitido(req('PUT', '/devices/d1/mon/snapshot', { auth: DEV, body: { env: 'tela', ts: 2 } }));
  await permitido(req('PUT', '/devices/d1/mon/carga', { auth: DEV, body: { env: 'carga', ts: 2 } }));
  await negado(req('PUT', '/devices/d1/mon/carga', { auth: DEV, body: { env: 'x'.repeat(9000), ts: 2 } }));
  await negado(req('PUT', '/devices/d1/mon/pub', { auth: DEV, body: 'E'.repeat(43) }));
  await negado(req('PUT', '/devices/d1/mon/outro', { auth: DEV, body: 1 }));
});
