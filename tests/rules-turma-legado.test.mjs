// Rules ANTIGAS (antes dos recursos de turma) no emulador: insumo da falha
// macia (docs/protocolo.md §3, "Escritas do PC fora do canal de comandos").
// O console pode ficar atrás do repositório; então toda escrita nova precisa
// ser NEGADA de forma previsível (401), sem quebrar o que já existia.
//
// Só roda com RULES_LEGADO=1 e as rules de 834a6ac carregadas no emulador:
//
//   git show 834a6ac:firebase/database.rules.json > /tmp/rules-antigas.json
//   node -e "fetch('http://127.0.0.1:9124/.settings/rules.json?ns=demo-test-default-rtdb',{method:'PUT',headers:{Authorization:'Bearer owner'},body:require('fs').readFileSync('/tmp/rules-antigas.json','utf8')}).then(r=>console.log(r.status))"
//   RULES_LEGADO=1 FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9124 node --test tests/rules-turma-legado.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = !HOST
  ? 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)'
  : !process.env.RULES_LEGADO
    ? 'só com as rules antigas carregadas (RULES_LEGADO=1)'
    : false;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, email) {
  const agora = Math.floor(Date.now() / 1000);
  const p = {
    sub: uid,
    user_id: uid,
    iat: agora,
    exp: agora + 3600,
    auth_time: agora,
    aud: 'demo-test',
    iss: 'https://securetoken.google.com/demo-test',
    firebase: { identities: {}, sign_in_provider: email ? 'google.com' : 'anonymous' },
  };
  if (email) {
    p.email = email;
    p.email_verified = true;
  }
  return b64u({ alg: 'none', typ: 'JWT' }) + '.' + b64u(p) + '.';
}

const DEV = fakeToken('uid-device');
const MEMBRO = fakeToken('uid-ana', 'ana@escola.com');

async function status(method, path, { auth, body, admin } = {}) {
  const q = admin ? '' : auth ? `&auth=${auth}` : '';
  const res = await fetch(`http://${HOST}${path}.json?ns=${NS}${q}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

async function semear() {
  await status('DELETE', '/', { admin: true });
  assert.equal(
    await status('PUT', '/', {
      admin: true,
      body: {
        devices: {
          d1: {
            meta: { uid: 'uid-device', pub: 'P1', label: 'Unidade 1', v: 4 },
            bind: { teacherUid: 'uid-fund', teacherPub: 'TP', teacherName: 'Prof', token: 't', ts: 1 },
          },
        },
        school: { meta: { schoolUid: 'uid-fund', criadoEm: 1 }, members: { 'ana@escola,com': true } },
      },
    }),
    200,
  );
}

test('legado: o que já existia continua passando', { skip }, async () => {
  await semear();
  assert.equal(await status('PUT', '/home/escola', { auth: MEMBRO, body: { rev: 1, cfg: '{}' } }), 200);
  assert.equal(await status('PUT', '/devices/d1/state/rules', { auth: MEMBRO, body: 'env' }), 200);
  assert.equal(await status('PUT', '/devices/d1/ack/k1', { auth: DEV, body: 'env' }), 200);
});

test('legado: escritas novas são negadas com 401 (falha macia no cliente)', { skip }, async () => {
  await semear();
  assert.equal(await status('POST', '/devices/d1/up', { auth: DEV, body: 'env' }), 401);
  assert.equal(await status('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'e', ts: 1 } }), 401);
  assert.equal(await status('DELETE', '/thumbs/d1', { auth: DEV }), 401);
  assert.equal(await status('PUT', '/devices/d1/state/lock', { auth: MEMBRO, body: 'env' }), 401);
  assert.equal(await status('PUT', '/devices/d1/state/exam', { auth: MEMBRO, body: 'env' }), 401);
  assert.equal(await status('PUT', '/devices/d1/state/monitor', { auth: MEMBRO, body: 'env' }), 401);
  assert.equal(await status('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 1, ids: ['x.desktop'] } }), 401);
  assert.equal(await status('PUT', '/school/stores/prova', { auth: MEMBRO, body: { rev: 1, env: 'e' } }), 401);
});
