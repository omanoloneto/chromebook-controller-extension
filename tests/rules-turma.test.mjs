// Rules dos recursos de turma (ext 0.7.0 / app 0.20.0 / Celita 0.13.0) no
// emulador do RTDB: fila `up` do aluno, state/lock|exam|monitor, /thumbs,
// /home/menu e o store `prova` da escola. Ver docs/protocolo.md §4.
//
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST) e com as
// rules DESTE repositório carregadas. Com RULES_LEGADO=1 (rules antigas, ver
// rules-turma-legado.test.mjs) este arquivo pula.
//
//   java -jar ~/.cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar --host 127.0.0.1 --port 9124 &
//   node -e "fetch('http://127.0.0.1:9124/.settings/rules.json?ns=demo-test-default-rtdb',{method:'PUT',headers:{Authorization:'Bearer owner'},body:require('fs').readFileSync('firebase/database.rules.json','utf8')}).then(r=>console.log(r.status))"
//   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9124 node --test --test-concurrency=1 tests/rules-*.test.mjs
//
// O emulador NÃO verifica assinatura de JWT — tokens fake (alg:none) bastam.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const NS = 'demo-test-default-rtdb';
const skip = !HOST
  ? 'requer o emulador (FIREBASE_DATABASE_EMULATOR_HOST)'
  : process.env.RULES_LEGADO
    ? 'rules antigas carregadas (RULES_LEGADO)'
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

const DEV = fakeToken('uid-device'); // conta anônima do Chromebook d1
const DEV2 = fakeToken('uid-device2'); // outro Chromebook (d2)
const ISOLADO = fakeToken('uid-isolado'); // professor isolado vinculado a d2
const FUNDADOR = fakeToken('uid-fund', 'fundador@escola.com'); // dono do bind de d1
const MEMBRO = fakeToken('uid-ana', 'ana.silva@escola.com');
const ESTRANHO = fakeToken('uid-x', 'x@fora.com');

async function req(method, path, { auth, body, admin } = {}) {
  const q = admin ? '' : auth ? `&auth=${auth}` : '';
  const res = await fetch(`http://${HOST}${path}.json?ns=${NS}${q}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}
const permitido = async (r, msg) => assert.equal((await r).ok, true, msg ?? 'esperava permissão');
const negado = async (r, msg) => assert.equal((await r).ok, false, msg ?? 'esperava negação');

async function semear() {
  await req('DELETE', '/', { admin: true });
  const r = await req('PUT', '/', {
    admin: true,
    body: {
      devices: {
        d1: {
          meta: { uid: 'uid-device', pub: 'P1', label: 'Unidade 1', v: 4 },
          bind: { teacherUid: 'uid-fund', teacherPub: 'TP', teacherName: 'Prof', token: 't', ts: 1 },
        },
        d2: {
          meta: { uid: 'uid-device2', pub: 'P2', label: 'Unidade 2', v: 4 },
          bind: { teacherUid: 'uid-isolado', teacherPub: 'TI', teacherName: 'Iso', token: 't', ts: 1 },
        },
      },
      school: { meta: { schoolUid: 'uid-fund', criadoEm: 1 }, members: { 'ana,silva@escola,com': true } },
    },
  });
  assert.equal(r.status, 200);
}

test('up: o device faz POST; string pura e filho >= 4096 são negados', { skip }, async () => {
  await semear();
  await permitido(req('POST', '/devices/d1/up', { auth: DEV, body: 'envelope' }));
  await permitido(req('POST', '/devices/d1/up', { auth: DEV, body: 'x'.repeat(4095) }));
  await negado(req('POST', '/devices/d1/up', { auth: DEV, body: 'x'.repeat(4096) }));
  await negado(req('PUT', '/devices/d1/up', { auth: DEV, body: 'string-pura' }));
  await negado(req('POST', '/devices/d1/up', { auth: DEV, body: { nao: 'string' } }));
  // Outro device não escreve na fila de d1.
  await negado(req('POST', '/devices/d1/up', { auth: DEV2, body: 'forjado' }));
});

test('up: MEMBRO e professor vinculado só apagam filhos; estranho não lê nem apaga', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/devices/d1/up/k1', { auth: DEV, body: 'env' }));
  await negado(req('PUT', '/devices/d1/up/k1', { auth: MEMBRO, body: 'forjado' }));
  await negado(req('POST', '/devices/d1/up', { auth: MEMBRO, body: 'forjado' }));
  await negado(req('POST', '/devices/d1/up', { auth: FUNDADOR, body: 'forjado' }));
  await negado(req('DELETE', '/devices/d1/up/k1', { auth: ESTRANHO }));
  await negado(req('GET', '/devices/d1/up', { auth: ESTRANHO }));
  await permitido(req('GET', '/devices/d1/up', { auth: MEMBRO }));
  await permitido(req('DELETE', '/devices/d1/up/k1', { auth: MEMBRO }));
  await permitido(req('PUT', '/devices/d1/up/k2', { auth: DEV, body: 'env' }));
  await permitido(req('DELETE', '/devices/d1/up/k2', { auth: FUNDADOR }));
  // Professor isolado (sem e-mail) apaga só na fila do PC dele.
  await permitido(req('PUT', '/devices/d2/up/k3', { auth: DEV2, body: 'env' }));
  await permitido(req('PUT', '/devices/d1/up/k4', { auth: DEV, body: 'env' }));
  await negado(req('DELETE', '/devices/d1/up/k4', { auth: ISOLADO }));
  await permitido(req('DELETE', '/devices/d2/up/k3', { auth: ISOLADO }));
  // A poda do próprio device (apagar a fila inteira ou um filho) passa.
  await permitido(req('DELETE', '/devices/d1/up/k4', { auth: DEV }));
  await permitido(req('DELETE', '/devices/d1/up', { auth: DEV }));
});

test('state: MEMBRO grava lock/exam/monitor; o device não', { skip }, async () => {
  await semear();
  for (const k of ['lock', 'exam', 'monitor']) {
    await permitido(req('PUT', `/devices/d1/state/${k}`, { auth: MEMBRO, body: 'env' }), k);
    await negado(req('PUT', `/devices/d1/state/${k}`, { auth: DEV, body: 'forjado' }), k);
    await negado(req('PUT', `/devices/d1/state/${k}`, { auth: ESTRANHO, body: 'forjado' }), k);
  }
  await permitido(req('DELETE', '/devices/d1/state/monitor', { auth: MEMBRO }));
  await negado(req('PUT', '/devices/d1/state/outra', { auth: MEMBRO, body: 'env' }));
});

test('thumbs: o device grava {env, ts}; falta de ts ou chave extra é negada', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'e', ts: { '.sv': 'timestamp' } } }));
  await negado(req('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'e' } }));
  await negado(req('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'e', ts: 1, x: 1 } }));
  await negado(req('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'x'.repeat(262144), ts: 1 } }));
  // Só o próprio id.
  await negado(req('PUT', '/thumbs/d2', { auth: DEV, body: { env: 'e', ts: 1 } }));
  await permitido(req('DELETE', '/thumbs/d1', { auth: DEV }));
});

test('thumbs: MEMBRO/professor lê e apaga mas não grava; estranho não lê; /thumbs inteiro fechado', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/thumbs/d1', { auth: DEV, body: { env: 'e', ts: 1 } }));
  await permitido(req('GET', '/thumbs/d1', { auth: MEMBRO }));
  await permitido(req('GET', '/thumbs/d1', { auth: FUNDADOR }));
  await permitido(req('GET', '/thumbs/d1', { auth: DEV }));
  await negado(req('GET', '/thumbs/d1', { auth: ESTRANHO }));
  await negado(req('GET', '/thumbs/d1', { auth: ISOLADO }));
  await negado(req('GET', '/thumbs', { auth: MEMBRO }));
  await negado(req('PUT', '/thumbs/d1', { auth: MEMBRO, body: { env: 'forjado', ts: 1 } }));
  await negado(req('DELETE', '/thumbs/d1', { auth: ESTRANHO }));
  await permitido(req('DELETE', '/thumbs/d1', { auth: MEMBRO }));
  // Professor isolado lê e apaga a do PC dele.
  await permitido(req('PUT', '/thumbs/d2', { auth: DEV2, body: { env: 'e', ts: 1 } }));
  await permitido(req('GET', '/thumbs/d2', { auth: ISOLADO }));
  await negado(req('PUT', '/thumbs/d2', { auth: ISOLADO, body: { env: 'forjado', ts: 1 } }));
  await permitido(req('DELETE', '/thumbs/d2', { auth: ISOLADO }));
});

test('home/menu: leitura pública; MEMBRO grava até 24 ids válidos', { skip }, async () => {
  await semear();
  const ids = Array.from({ length: 24 }, (_, i) => `app-${i}.desktop`);
  await permitido(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 1, ids } }));
  const r = await req('GET', '/home/menu');
  assert.equal(r.ok, true, 'leitura pública');
  assert.equal((await r.json()).ids.length, 24);
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: [...ids, 'x.desktop'] } }), '25º');
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: ['../x.desktop'] } }));
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: ['firefox'] } }));
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: ['a'.repeat(57) + '.desktop'] } }));
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: { a: 'x.desktop' } } }), 'chave não numérica');
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { ids: ['x.desktop'] } }), 'sem rev');
  await negado(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 2, ids: ['x.desktop'], outra: 1 } }));
  await permitido(req('PUT', '/home/menu', { auth: MEMBRO, body: { rev: 3 } }), 'lista vazia');
  await negado(req('PUT', '/home/menu', { auth: ESTRANHO, body: { rev: 4, ids: ['x.desktop'] } }));
  await negado(req('PUT', '/home/menu', { auth: DEV, body: { rev: 4, ids: ['x.desktop'] } }));
  // /home/escola continua aceitando o formato de sempre.
  await permitido(req('PUT', '/home/escola', { auth: MEMBRO, body: { rev: 1, cfg: '{}' } }));
});

test('school/stores: aceita o store prova', { skip }, async () => {
  await semear();
  await permitido(req('PUT', '/school/stores/prova', { auth: MEMBRO, body: { rev: 1, env: 'e' } }));
  await negado(req('PUT', '/school/stores/outra', { auth: MEMBRO, body: { rev: 1, env: 'e' } }));
  await negado(req('PUT', '/school/stores/prova', { auth: ESTRANHO, body: { rev: 2, env: 'e' } }));
});
