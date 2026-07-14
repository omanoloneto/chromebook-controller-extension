// Testes das Security Rules (firebase/database.rules.json) no emulador do RTDB.
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database --project demo-test \
//     "cd .. && node --test tests/rules-security.test.mjs"
//
// O emulador NÃO verifica assinatura de JWT — tokens fake (alg:none) bastam.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = HOST ? false : 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid) {
  const agora = Math.floor(Date.now() / 1000);
  return (
    b64u({ alg: 'none', typ: 'JWT' }) +
    '.' +
    b64u({
      sub: uid,
      user_id: uid,
      iat: agora,
      exp: agora + 3600,
      auth_time: agora,
      aud: 'demo-test',
      iss: 'https://securetoken.google.com/demo-test',
      firebase: { identities: {}, sign_in_provider: 'anonymous' },
    }) +
    '.'
  );
}

const DEV = fakeToken('uid-device');
const PROF = fakeToken('uid-prof');
const PROF2 = fakeToken('uid-prof2');

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

// Estado-base de um device registrado (gravado como admin p/ isolar cada teste).
async function semear({ comBind = false } = {}) {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/devices/d1', {
    admin: true,
    body: {
      meta: { uid: 'uid-device', pub: 'PUB_DEVICE', label: 'PC 1', v: 4 },
      pairing: { token: 'tok-atual' },
      ...(comBind
        ? {
            bind: {
              teacherUid: 'uid-prof',
              teacherPub: 'PUB_PROF',
              teacherName: 'Prof',
              token: 'tok-atual',
              ts: 1,
            },
          }
        : {}),
    },
  });
  await req('PUT', '/device_uids/uid-device', { admin: true, body: 'd1' });
}

test('meta: primeiro write fixa o uid; outro auth não rouba', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await permitido(
    req('PUT', '/devices/d1/meta', {
      auth: DEV,
      body: { uid: 'uid-device', pub: 'P', label: 'PC', v: 4 },
    }),
  );
  await negado(
    req('PUT', '/devices/d1/meta', {
      auth: PROF,
      body: { uid: 'uid-prof', pub: 'X', label: 'roubo', v: 4 },
    }),
  );
});

test('pairing: só o device grava; professor não lê', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/devices/d1/pairing/token', { auth: DEV, body: 'tok-novo' }));
  await negado(req('PUT', '/devices/d1/pairing/token', { auth: PROF, body: 'hack' }));
  // Leitura direta do pairing negada até p/ quem lê o device (sem .read no filho
  // não há grant extra; o professor só lê o nó via .read do device — mas o
  // pairing não pode vazar via GET direto sem bind).
  const r = await req('GET', '/devices/d1/pairing', { auth: PROF });
  assert.equal(r.ok, false, 'professor sem bind não lê pairing');
});

test('bind: exige token atual; TOFU bloqueia 2º professor', { skip }, async () => {
  await semear();
  // Token errado → negado.
  await negado(
    req('PUT', '/devices/d1/bind', {
      auth: PROF,
      body: { teacherUid: 'uid-prof', teacherPub: 'PP', teacherName: 'P', token: 'errado', ts: 1 },
    }),
  );
  // Token certo → permitido.
  await permitido(
    req('PUT', '/devices/d1/bind', {
      auth: PROF,
      body: { teacherUid: 'uid-prof', teacherPub: 'PP', teacherName: 'P', token: 'tok-atual', ts: 1 },
    }),
  );
  // 2º professor, mesmo com o token certo → negado (TOFU).
  await negado(
    req('PUT', '/devices/d1/bind', {
      auth: PROF2,
      body: { teacherUid: 'uid-prof2', teacherPub: 'X', teacherName: 'R', token: 'tok-atual', ts: 2 },
    }),
  );
  // Re-bind do MESMO professor → permitido.
  await permitido(
    req('PUT', '/devices/d1/bind', {
      auth: PROF,
      body: { teacherUid: 'uid-prof', teacherPub: 'PP', teacherName: 'P', token: 'tok-atual', ts: 3 },
    }),
  );
  // Device pode desfazer (unbind).
  await permitido(req('DELETE', '/devices/d1/bind', { auth: DEV }));
});

test('cmd: professor enfileira; device só deleta', { skip }, async () => {
  await semear({ comBind: true });
  await permitido(req('POST', '/devices/d1/cmd', { auth: PROF, body: 'envelope' }));
  await negado(req('PUT', '/devices/d1/cmd/x1', { auth: DEV, body: 'forjado' }));
  await permitido(req('PUT', '/devices/d1/cmd/x1', { auth: PROF, body: 'env' }));
  await permitido(req('DELETE', '/devices/d1/cmd/x1', { auth: DEV }));
  await negado(req('POST', '/devices/d1/cmd', { auth: PROF2, body: 'invasor' }));
});

test('report/presence: só o device escreve; professor vinculado lê', { skip }, async () => {
  await semear({ comBind: true });
  await permitido(
    req('PUT', '/devices/d1/report', { auth: DEV, body: { env: 'ciphertext', ts: { '.sv': 'timestamp' } } }),
  );
  await negado(req('PUT', '/devices/d1/report', { auth: PROF, body: { env: 'forja', ts: 1 } }));
  await permitido(
    req('PUT', '/devices/d1/presence', { auth: DEV, body: { lastSeen: { '.sv': 'timestamp' } } }),
  );
  await permitido(req('GET', '/devices/d1', { auth: PROF }));
  await negado(req('GET', '/devices/d1', { auth: PROF2 }));
});

test('ack: device escreve; professor só deleta', { skip }, async () => {
  await semear({ comBind: true });
  await permitido(req('PUT', '/devices/d1/ack/x1', { auth: DEV, body: 'env' }));
  await negado(req('PUT', '/devices/d1/ack/x2', { auth: PROF, body: 'forja' }));
  await permitido(req('DELETE', '/devices/d1/ack/x1', { auth: PROF }));
});

test('state: só o professor vinculado; chaves limitadas', { skip }, async () => {
  await semear({ comBind: true });
  await permitido(req('PUT', '/devices/d1/state/rules', { auth: PROF, body: 'env' }));
  await permitido(req('PUT', '/devices/d1/state/wallpaper', { auth: PROF, body: 'env' }));
  await permitido(req('PUT', '/devices/d1/state/classview', { auth: PROF, body: 'env' }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: DEV, body: 'forja' }));
  await negado(req('PUT', '/devices/d1/state/classview', { auth: DEV, body: 'forja' }));
  await negado(req('PUT', '/devices/d1/state/classview', { auth: PROF2, body: 'forja' }));
  // "Escrever null" = DELETE: caminho usado ao desmarcar o PC do professor.
  await permitido(req('DELETE', '/devices/d1/state/classview', { auth: PROF }));
  await negado(req('PUT', '/devices/d1/state/outra', { auth: PROF, body: 'x' }));
});

test('wallpaper: dono escreve; device vinculado lê; sem vínculo não lê', { skip }, async () => {
  await semear({ comBind: true });
  await permitido(
    req('PUT', '/wallpapers/uid-prof', { auth: PROF, body: { hash: 'abc', jpeg: 'AAAA', ts: 1 } }),
  );
  await negado(
    req('PUT', '/wallpapers/uid-prof', { auth: DEV, body: { hash: 'x', jpeg: 'B', ts: 1 } }),
  );
  await permitido(req('GET', '/wallpapers/uid-prof', { auth: DEV }));
  // Device de outro professor (sem bind com uid-prof) não lê.
  await req('PUT', '/devices/d2', {
    admin: true,
    body: { meta: { uid: 'uid-dev2', pub: 'P2', label: 'PC 2', v: 4 }, pairing: { token: 't' } },
  });
  await req('PUT', '/device_uids/uid-dev2', { admin: true, body: 'd2' });
  await negado(req('GET', '/wallpapers/uid-prof', { auth: fakeToken('uid-dev2') }));
});

test('histórico: só o dono lê/escreve', { skip }, async () => {
  await semear();
  await permitido(
    req('PUT', '/history/uid-prof/1767369600000/meta', { auth: PROF, body: 'envelope' }),
  );
  await permitido(
    req('POST', '/history/uid-prof/1767369600000/ev', { auth: PROF, body: 'envelope' }),
  );
  await negado(req('GET', '/history/uid-prof', { auth: PROF2 }));
  await negado(req('GET', '/history/uid-prof', { auth: DEV }));
  await negado(
    req('PUT', '/history/uid-prof/1767369600000/meta', { auth: PROF2, body: 'x' }),
  );
  // Estrutura restrita: chave fora de meta/ev é rejeitada.
  await negado(
    req('PUT', '/history/uid-prof/1767369600000/outra', { auth: PROF, body: 'x' }),
  );
  await permitido(req('DELETE', '/history/uid-prof/1767369600000', { auth: PROF }));
});

test('backup: só o dono; estrutura restrita', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/backup/uid-prof/keypair', { auth: PROF, body: 'blob' }));
  await permitido(req('PUT', '/backup/uid-prof/stores', { auth: PROF, body: 'env' }));
  await negado(req('GET', '/backup/uid-prof', { auth: PROF2 }));
  await negado(req('GET', '/backup/uid-prof', { auth: DEV }));
  await negado(req('PUT', '/backup/uid-prof/keypair', { auth: PROF2, body: 'x' }));
  await negado(req('PUT', '/backup/uid-prof/outra', { auth: PROF, body: 'x' }));
});

test('roster do professor: só o dono', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/teachers/uid-prof/devices/d1', { auth: PROF, body: true }));
  await negado(req('PUT', '/teachers/uid-prof/devices/d1', { auth: PROF2, body: true }));
  await negado(req('GET', '/teachers/uid-prof', { auth: DEV }));
});
