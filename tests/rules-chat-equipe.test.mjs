// Rules do chat com escolha do professor: school/equipe, state/aluno e mon/up.
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
      members: { [MEMBRO_G2]: true },
      monitores: { [MON_KEY]: true },
      devices: { d1: true },
      equipe: { 'uid-prof2': { nome: 'Colega', papel: 'professor', ek: MEMBRO_G2, visto: 1 } },
    },
  });
  const pc = (uid) => ({
    meta: { uid, pub: 'PUB_DEVICE', label: 'Unidade 1', v: 4 },
    bind: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'Prof', token: 'tok', ts: 1 },
    mon: { pub: PUB_MON, up: { u1: 'env' } },
  });
  await req('PUT', '/devices/d1', { admin: true, body: pc('uid-device') });
  await req('PUT', '/devices/d9', { admin: true, body: pc('uid-d9') });
  await req('PUT', '/device_uids', { admin: true, body: { 'uid-device': 'd1', 'uid-d9': 'd9', 'uid-anon': 'd1' } });
}

const agora = () => Date.now();
const entrada = (papel, ek, extra = {}) => ({ nome: 'Fulana', papel, ek, visto: agora(), ...extra });

test('cada um grava a própria entrada na equipe, com o papel que tem', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/school/equipe/uid-prof2', { auth: PROF_G2, body: entrada('professor', MEMBRO_G2) }));
  await permitido(req('PUT', '/school/equipe/uid-mon', { auth: MONITORA, body: entrada('monitora', MON_KEY) }));
  await permitido(req('PUT', '/school/equipe/uid-prof', {
    auth: FUNDADOR, body: entrada('professor', 'fundador@gmail,com'),
  }));
  // Papel que a pessoa não tem, e-mail de outro, entrada de outro uid.
  await negado(req('PUT', '/school/equipe/uid-mon', { auth: MONITORA, body: entrada('professor', MON_KEY) }));
  await negado(req('PUT', '/school/equipe/uid-prof2', { auth: PROF_G2, body: entrada('professor', MON_KEY) }));
  await negado(req('PUT', '/school/equipe/uid-mon', { auth: PROF_G2, body: entrada('professor', MEMBRO_G2) }));
  await negado(req('PUT', '/school/equipe/uid-intruso', {
    auth: INTRUSO, body: entrada('professor', 'intruso@gmail,com'),
  }));
  await negado(req('PUT', '/school/equipe/uid-mon', { auth: MON_NV, body: entrada('monitora', MON_KEY) }));
  await negado(req('PUT', '/school/equipe/uid-prof2', {
    auth: PROF_G2, body: entrada('professor', MEMBRO_G2, { nome: 'x'.repeat(61) }),
  }));
  await negado(req('PUT', '/school/equipe/uid-prof2', {
    auth: PROF_G2, body: entrada('professor', MEMBRO_G2, { visto: agora() + 3600000 }),
  }));
  await negado(req('PUT', '/school/equipe/uid-prof2', {
    auth: PROF_G2, body: entrada('professor', MEMBRO_G2, { email: 'x' }),
  }));
});

test('a equipe é lida pela escola e pelos PCs dela, e o fundador apaga', { skip }, async () => {
  await semear();
  await permitido(req('GET', '/school/equipe', { auth: PROF_G2 }));
  await permitido(req('GET', '/school/equipe', { auth: MONITORA }));
  await permitido(req('GET', '/school/equipe', { auth: DEV }));
  // PC fora do roster, uid que só diz ser o d1, e quem não é da escola.
  await negado(req('GET', '/school/equipe', { auth: fakeToken('uid-d9') }));
  await negado(req('GET', '/school/equipe', { auth: ANON }));
  await negado(req('GET', '/school/equipe', { auth: INTRUSO }));
  await negado(req('DELETE', '/school/equipe/uid-prof2', { auth: MONITORA }));
  await permitido(req('DELETE', '/school/equipe/uid-prof2', { auth: PROF_G2 }));
  await req('PUT', '/school/equipe/uid-prof2', { admin: true, body: entrada('professor', MEMBRO_G2) });
  await permitido(req('DELETE', '/school/equipe/uid-prof2', { auth: FUNDADOR }));
});

test('aluno da chamada vai no state; a monitora não grava', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/devices/d1/state/aluno', { auth: PROF_G2, body: 'env' }));
  await negado(req('PUT', '/devices/d1/state/aluno', { auth: MONITORA, body: 'env' }));
  await negado(req('PUT', '/devices/d1/state/aluno', { auth: DEV, body: 'env' }));
});

test('mon/up: o PC grava, a monitora lê e só apaga', { skip }, async () => {
  await semear();
  await permitido(req('POST', '/devices/d1/mon/up', { auth: DEV, body: 'env' }));
  await negado(req('POST', '/devices/d1/mon/up', { auth: DEV, body: 'x'.repeat(5000) }));
  await negado(req('POST', '/devices/d1/mon/up', { auth: MONITORA, body: 'env' }));
  await permitido(req('GET', '/devices/d1/mon/up', { auth: MONITORA }));
  await negado(req('PUT', '/devices/d1/mon/up/u1', { auth: MONITORA, body: 'outro' }));
  await permitido(req('DELETE', '/devices/d1/mon/up/u1', { auth: MONITORA }));
  await negado(req('GET', '/devices/d9/mon/up', { auth: MONITORA }));
});
