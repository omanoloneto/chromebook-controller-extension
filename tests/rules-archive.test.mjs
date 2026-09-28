// Rules do arquivo por unidade (/archive/{deviceId}: histórico e índice de fotos).
// SÓ RODA sob o emulador (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//   (SERIAL obrigatório: arquivos de emulador compartilham o banco.)
//
// Quem grava é o agente do PC (dono de meta/uid) e só com o PC vinculado à
// escola; quem lê é o dono ou membro da escola; membro só apaga.

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
const ANON = fakeToken('uid-anon');
// Agentes: d1 e d2 da escola, d3 de professor isolado, d4 sem vínculo.
const DEV1 = fakeToken('uid-dev1');
const DEV2 = fakeToken('uid-dev2');
const DEV3 = fakeToken('uid-dev3');
const DEV4 = fakeToken('uid-dev4');

const DIA = '2026-09-28';
const DIA_VELHO = '2026-09-01';
const TS13 = '1790000000000';
const R22 = 'AbCdEfGhIjKlMnOpQr_-09';

async function req(method, path, { auth, body, admin, query = '' } = {}) {
  const q = admin ? '' : `&auth=${auth ?? ''}`;
  const res = await fetch(`http://${HOST}${path}.json?ns=${NS}${q}${query}`, {
    method,
    headers: admin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}
const permitido = async (r) => assert.equal((await r).ok, true, 'esperava permissão');
const negado = async (r) => assert.equal((await r).ok, false, 'esperava negação');

const lote = () => ({ env: 'ciphertext', ts: { '.sv': 'timestamp' } });
const indice = (u) => ({ u, r: R22 });

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
      devices: {
        d1: device('uid-dev1', 'uid-prof'),
        d2: device('uid-dev2', 'uid-prof'),
        d3: device('uid-dev3', 'uid-isolado'),
        d4: device('uid-dev4', null),
      },
      archive: {
        d1: {
          nav: { [DIA_VELHO]: { k1: { env: 'e', ts: 1 } } },
          fotos: { [DIA_VELHO]: { [TS13]: indice('uid-dev1') } },
        },
        d2: {
          nav: { [DIA_VELHO]: { k1: { env: 'e', ts: 1 } } },
          fotos: { [DIA_VELHO]: { [TS13]: indice('uid-dev2') } },
        },
        d3: { nav: { [DIA_VELHO]: { k1: { env: 'e', ts: 1 } } } },
      },
    },
  });
}

async function valor(path) {
  const r = await req('GET', path, { admin: true });
  return r.json();
}

test('archive: dono do PC da escola grava nav e fotos do próprio id, não de outro', { skip }, async () => {
  await semear();
  await permitido(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: lote() }));
  await permitido(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev1') }));
  // Reenvio após timeout reescreve o mesmo índice.
  await permitido(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev1') }));

  await negado(req('POST', `/archive/d2/nav/${DIA}`, { auth: DEV1, body: lote() }));
  await negado(req('PUT', `/archive/d2/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev1') }));
  await negado(req('PUT', `/archive/d2/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev2') }));
  await negado(req('DELETE', `/archive/d2/nav/${DIA_VELHO}`, { auth: DEV1 }));
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: ANON, body: lote() }));
});

test('archive: PC de professor isolado, sem vínculo ou sem escola não grava', { skip }, async () => {
  await semear();
  await negado(req('POST', `/archive/d3/nav/${DIA}`, { auth: DEV3, body: lote() }));
  await negado(req('PUT', `/archive/d3/fotos/${DIA}/${TS13}`, { auth: DEV3, body: indice('uid-dev3') }));
  await negado(req('POST', `/archive/d4/nav/${DIA}`, { auth: DEV4, body: lote() }));
  await negado(req('PUT', `/archive/d4/fotos/${DIA}/${TS13}`, { auth: DEV4, body: indice('uid-dev4') }));
  // Dono sempre pode apagar o próprio arquivo (retenção de 15 dias).
  await permitido(req('DELETE', `/archive/d3/nav/${DIA_VELHO}`, { auth: DEV3 }));

  // Sem escola, vínculo ausente não pode "casar" com schoolUid ausente.
  await req('DELETE', '/school', { admin: true });
  await negado(req('POST', `/archive/d4/nav/${DIA}`, { auth: DEV4, body: lote() }));
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: lote() }));
});

test('archive: dono lê o shallow do próprio arquivo, não o de outro PC', { skip }, async () => {
  await semear();
  const raiz = await req('GET', '/archive/d1', { auth: DEV1, query: '&shallow=true' });
  assert.equal(raiz.ok, true);
  assert.deepEqual(await raiz.json(), { nav: true, fotos: true });
  const dias = await req('GET', '/archive/d1/nav', { auth: DEV1, query: '&shallow=true' });
  assert.deepEqual(await dias.json(), { [DIA_VELHO]: true });
  await permitido(req('GET', '/archive/d1/fotos', { auth: DEV1, query: '&shallow=true' }));

  await negado(req('GET', '/archive/d2', { auth: DEV1, query: '&shallow=true' }));
  await negado(req('GET', '/archive/d2/nav', { auth: DEV1, query: '&shallow=true' }));
  await negado(req('GET', '/archive/d1', { auth: ANON, query: '&shallow=true' }));
});

test('archive: membro e fundador leem; conta fora da lista e e-mail não verificado não', { skip }, async () => {
  await semear();
  await permitido(req('GET', '/archive/d1', { auth: MEMBRO }));
  await permitido(req('GET', `/archive/d2/fotos/${DIA_VELHO}`, { auth: MEMBRO }));
  await permitido(req('GET', '/archive/d1', { auth: FUNDADOR }));
  await negado(req('GET', '/archive/d1', { auth: INTRUSO }));
  await negado(req('GET', '/archive/d1', { auth: MEMBRO_NV }));
  await negado(req('DELETE', `/archive/d1/nav/${DIA_VELHO}`, { auth: INTRUSO }));
  await negado(req('DELETE', '/archive/d1', { auth: INTRUSO }));
});

test('archive: membro só apaga (dia inteiro e PATCH multi-caminho com null)', { skip }, async () => {
  await semear();
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: MEMBRO, body: lote() }));
  await negado(req('PUT', `/archive/d1/nav/${DIA_VELHO}/k1`, { auth: MEMBRO, body: { env: 'x', ts: 2 } }));
  await negado(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: MEMBRO, body: indice('uid-prof2') }));
  // PATCH que mistura apagar e gravar é recusado por inteiro.
  await negado(
    req('PATCH', '/archive/d1', {
      auth: MEMBRO,
      body: { [`nav/${DIA_VELHO}`]: null, [`nav/${DIA}/k9`]: { env: 'x', ts: 1 } },
    }),
  );
  assert.notEqual(await valor(`/archive/d1/nav/${DIA_VELHO}`), null);

  await permitido(req('DELETE', `/archive/d1/nav/${DIA_VELHO}`, { auth: MEMBRO }));
  assert.equal(await valor(`/archive/d1/nav/${DIA_VELHO}`), null);

  await permitido(
    req('PATCH', '/archive/d2', {
      auth: MEMBRO,
      body: { [`nav/${DIA_VELHO}`]: null, [`fotos/${DIA_VELHO}`]: null },
    }),
  );
  assert.equal(await valor('/archive/d2'), null);

  await permitido(req('DELETE', '/archive/d1', { auth: MEMBRO }));
  assert.equal(await valor('/archive/d1'), null);
});

test('archive: dono apaga dias velhos num PATCH multi-caminho (retenção)', { skip }, async () => {
  await semear();
  await permitido(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: lote() }));
  await permitido(
    req('PATCH', '/archive/d1', {
      auth: DEV1,
      body: { [`nav/${DIA_VELHO}`]: null, [`fotos/${DIA_VELHO}`]: null },
    }),
  );
  assert.equal(await valor(`/archive/d1/nav/${DIA_VELHO}`), null);
  assert.equal(await valor(`/archive/d1/fotos/${DIA_VELHO}`), null);
  assert.notEqual(await valor(`/archive/d1/nav/${DIA}`), null);
});

test('archive: $day, $ts, u, r, $k cru e campos estranhos são recusados', { skip }, async () => {
  await semear();
  for (const dia of ['2026-9-28', 'hoje', '2026-09-28x', '20260928']) {
    await negado(req('POST', `/archive/d1/nav/${dia}`, { auth: DEV1, body: lote() }));
    await negado(req('PUT', `/archive/d1/fotos/${dia}/${TS13}`, { auth: DEV1, body: indice('uid-dev1') }));
  }
  for (const ts of ['123', '17900000000000', '179000000000a', 'foto']) {
    await negado(req('PUT', `/archive/d1/fotos/${DIA}/${ts}`, { auth: DEV1, body: indice('uid-dev1') }));
  }
  await negado(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev2') }));
  for (const r of [R22.slice(1), `${R22}A`, `${R22.slice(1)}+`, `${R22.slice(1)}=`, 42]) {
    await negado(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: { u: 'uid-dev1', r } }));
  }
  await negado(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: { u: 'uid-dev1' } }));
  await negado(
    req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: { ...indice('uid-dev1'), x: 1 } }),
  );
  await negado(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: 'cru' }));

  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: 'envelope cru' }));
  await negado(req('PUT', `/archive/d1/nav/${DIA}/k1`, { auth: DEV1, body: 'envelope cru' }));
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: { env: 'x' } }));
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: { env: 'x', ts: 'ontem' } }));
  await negado(req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: { ...lote(), sid: 1 } }));
  await negado(
    req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: { env: 'x'.repeat(65536), ts: 1 } }),
  );
  await negado(req('PUT', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: 'cru' }));
  await negado(req('PUT', `/archive/d1/outra/${DIA}`, { auth: DEV1, body: lote() }));
  await negado(req('PUT', '/archive/d1/nav', { auth: DEV1, body: { [DIA]: { k1: lote() } } }));

  // Controle: o mesmo PC grava o formato certo.
  await permitido(
    req('POST', `/archive/d1/nav/${DIA}`, { auth: DEV1, body: { env: 'x'.repeat(65535), ts: 1 } }),
  );
  await permitido(req('PUT', `/archive/d1/fotos/${DIA}/${TS13}`, { auth: DEV1, body: indice('uid-dev1') }));
});
