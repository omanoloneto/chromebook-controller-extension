// Rules do Wi-Fi da escola (/school/wifi, protocolo §9). SÓ RODA sob o emulador
// (pula sem FIREBASE_DATABASE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//
// PC DA ESCOLA = conta anônima cujo /device_uids aponta para um PC de
// /school/devices e que é o dono do meta/uid desse PC. Só ele lê tudo e grava
// meta, pubs, chaves e redes. O celular do professor (guardião) lê meta, pubs,
// entregas e o próprio nó, e grava só a própria pública e as entregas.

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

test('wifi: entrada velha no roster, sem /devices/{id}/meta, não vira PC da escola de ninguém', { skip }, async () => {
  await semear();
  await req('PUT', '/school/wifi/meta', { admin: true, body: { de: 'd1', ts: 1 } });
  // /devices/dVelho apagado no console, e o roster ficou para trás.
  await req('PUT', '/school/devices/dVelho', { admin: true, body: true });
  for (const [quem, uid] of [[ANON, 'uid-anon'], [MEMBRO, 'uid-prof2']]) {
    const meta = { uid, pub: 'PUBV', label: 'PC', v: 4 };
    await negado(req('PUT', '/devices/dVelho/meta', { auth: quem, body: meta }));
    await negado(req('PATCH', '/devices/dVelho/meta', { auth: quem, body: meta }));
    await permitido(req('PUT', `/device_uids/${uid}`, { auth: quem, body: 'dVelho' }));
    await negado(req('GET', '/school/wifi', { auth: quem }));
    await negado(req('PUT', '/school/wifi/pubs/dVelho', { auth: quem, body: 'PUBV' }));
  }
  assert.equal(await (await req('GET', '/devices/dVelho', { admin: true })).json(), null);

  // O pareamento cria a meta antes de o app pôr o PC no roster; depois o PC segue gravando a dele.
  const DEV5 = fakeToken('uid-dev5');
  await permitido(req('PATCH', '/devices/d5/meta', { auth: DEV5, body: { uid: 'uid-dev5', pub: 'PUB5', label: 'PC 5', v: 4 } }));
  await permitido(req('PUT', '/device_uids/uid-dev5', { auth: DEV5, body: 'd5' }));
  await permitido(req('PUT', '/school/devices/d5', { auth: MEMBRO, body: true }));
  await permitido(req('PATCH', '/devices/d5/meta', { auth: DEV5, body: { uid: 'uid-dev5', label: 'Unidade 5', os: '1.31.0' } }));
  await permitido(req('GET', '/school/wifi', { auth: DEV5 }));
});

// ---- Guardiões (celular do professor) e kcv -----------------------------------
const G43 = 'Z03jzVY4eGibMJbdDlyaM-hjbo7agkCE7LSiORqfChM';
const E43 = 'JS-rAkqU_z8Q6eeqM32bnG47qUM0a2Iuatbgo_-24GQ';
const KCV = 'A7Sy0VYvsKfBTSAvvBn0C3DgdXRqmvGR3nlnwlOA_GU';
const FORA = fakeToken('uid-fora', { email: 'fora@gmail.com' });
const NAO_VERIFICADO = fakeToken('uid-nv', { email: 'colega@gmail.com', emailVerified: false });
const valor = async (caminho) => (await req('GET', caminho, { admin: true })).json();

async function semearWifi() {
  await semear();
  await req('PUT', '/school/devices/d4', { admin: true, body: true });
  await req('PUT', '/school/wifi', {
    admin: true,
    body: { meta: { de: 'd1', ts: 1 }, pubs: { d1: 'PUB1', d2: 'PUB2' }, redes: { [ID]: { env: 'cifrado', ts: 1 } },
            chaves: { d2: { de: 'd1', env: 'selado' } } },
  });
}

test('guardião: membro lê meta, pubs, entregas e o próprio nó; nunca redes nem chaves', { skip }, async () => {
  await semearWifi();
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: { pub: G43, ts: agora } }));
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof', { auth: FUNDADOR, body: { pub: G43, ts: agora } }));
  for (const quem of [MEMBRO, FUNDADOR]) {
    for (const caminho of ['/school/wifi/meta', '/school/wifi/pubs', '/school/wifi/entregas']) {
      await permitido(req('GET', caminho, { auth: quem }));
    }
    for (const caminho of ['/school/wifi', '/school/wifi/redes', `/school/wifi/redes/${ID}`, '/school/wifi/chaves',
      '/school/wifi/guardioes']) {
      await negado(req('GET', caminho, { auth: quem }));
    }
  }
  await permitido(req('GET', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO }));
  await negado(req('GET', '/school/wifi/guardioes/uid-prof', { auth: MEMBRO }));
  for (const quem of [ANON, FORA, NAO_VERIFICADO, DEV3, MENTIRA]) {
    await negado(req('GET', '/school/wifi/meta', { auth: quem }));
    await negado(req('GET', '/school/wifi/entregas', { auth: quem }));
  }
  await permitido(req('GET', '/school/wifi/guardioes', { auth: DEV1 }));
});

test('guardião: kcv nasce com a meta ou, na meta antiga, só pelo PC que criou a chave', { skip }, async () => {
  await semearWifi();
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV2, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: MENTIRA, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: MEMBRO, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: FUNDADOR, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: 'curto' }));
  await permitido(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: E43 }));
  await negado(req('DELETE', '/school/wifi/meta/kcv', { auth: DEV1 }));
  await negado(req('DELETE', '/school/wifi/meta', { auth: DEV1 }));
  await req('DELETE', '/school/wifi', { admin: true });
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: KCV }));
  await negado(req('PUT', '/school/wifi/meta', { auth: DEV2, body: { de: 'd2', ts: agora, kcv: 'x' } }));
  await permitido(req('PUT', '/school/wifi/meta', { auth: DEV2, body: { de: 'd2', ts: agora, kcv: KCV } }));
});

test('guardião: grava só a própria pública; só PC da escola sela para ele', { skip }, async () => {
  await semearWifi();
  const chave = { de: 'd1', env: 'selado' };
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: { pub: G43, ts: agora } }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof', { auth: MEMBRO, body: { pub: G43, ts: agora } }));
  for (const [quem, uid] of [[FORA, 'uid-fora'], [NAO_VERIFICADO, 'uid-nv'], [ANON, 'uid-anon'], [DEV1, 'uid-dev1']]) {
    await negado(req('PUT', `/school/wifi/guardioes/${uid}`, { auth: quem, body: { pub: G43, ts: agora } }));
  }
  for (const torto of [{ pub: 'curta', ts: agora }, { pub: G43 }, { pub: G43, ts: 9999999999999 },
    { pub: G43, ts: agora, x: 1 }, { pub: G43, ts: agora, chave }]) {
    await negado(req('PUT', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: torto }));
  }
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: chave }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: { de: 'd2', env: 'selado' } }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: { ...chave, x: 1 } }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: { de: 'd1', env: 'x'.repeat(1024) } }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV3, body: { de: 'd3', env: 'selado' } }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: MENTIRA, body: chave }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: MEMBRO, body: chave }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-ninguem/chave', { auth: DEV1, body: chave }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/pub', { auth: DEV1, body: E43 }));
  await permitido(req('DELETE', '/school/wifi/guardioes/uid-prof2/chave', { auth: MEMBRO }));
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: chave }));
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: { pub: E43, ts: agora } }));
  const depois = await (await req('GET', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO })).json();
  assert.equal(depois.chave, undefined, 'pública nova apaga a entrega antiga');
});

test('guardião: entrega vai para PC da escola que publicou a pública, na vaga de quem entrega', { skip }, async () => {
  await semearWifi();
  const entrega = { pub: E43, env: 'selado', kcv: KCV };
  await permitido(req('PUT', '/school/wifi/entregas/d2/uid-prof2', { auth: MEMBRO, body: entrega }));
  await permitido(req('PUT', '/school/wifi/entregas/d2/uid-prof', { auth: FUNDADOR, body: entrega }));
  await permitido(req('PUT', '/school/wifi/entregas/d2/uid-prof2', { auth: MEMBRO, body: { ...entrega, env: 'outro' } }));
  await negado(req('PUT', '/school/wifi/entregas/d2/uid-prof', { auth: MEMBRO, body: entrega }));
  await negado(req('PUT', '/school/wifi/entregas/d3/uid-prof2', { auth: MEMBRO, body: entrega }));
  await negado(req('PUT', '/school/wifi/entregas/d4/uid-prof2', { auth: MEMBRO, body: entrega }));
  await negado(req('PUT', '/school/wifi/entregas/d2/uid-dev1', { auth: DEV1, body: entrega }));
  for (const [quem, uid] of [[ANON, 'uid-anon'], [FORA, 'uid-fora'], [NAO_VERIFICADO, 'uid-nv']]) {
    await negado(req('PUT', `/school/wifi/entregas/d2/${uid}`, { auth: quem, body: entrega }));
  }
  for (const torto of [{ pub: 'curta', env: 'selado', kcv: KCV }, { pub: E43, kcv: KCV }, { pub: E43, env: 'selado' },
    { ...entrega, env: 'x'.repeat(1024) }, { ...entrega, kcv: KCV.slice(1) }, { ...entrega, kcv: `${KCV.slice(1)}=` },
    { ...entrega, kcv: 43 }, { ...entrega, de: 'd1' }]) {
    await negado(req('PUT', '/school/wifi/entregas/d2/uid-prof2', { auth: MEMBRO, body: torto }));
  }
  const lida = await (await req('GET', '/school/wifi/entregas/d2', { auth: DEV2 })).json();
  assert.deepEqual(Object.keys(lida).sort(), ['uid-prof', 'uid-prof2']);
  await negado(req('PUT', '/school/wifi/outra/d2', { auth: MEMBRO, body: entrega }));
});

test('guardião: membro nunca lê redes, chaves nem o nó de outro guardião', { skip }, async () => {
  await semearWifi();
  await req('PUT', '/school/wifi/guardioes', {
    admin: true,
    body: {
      'uid-prof': { pub: G43, ts: 1, chave: { de: 'd1', env: 'selado' } },
      'uid-prof2': { pub: E43, ts: 1, chave: { de: 'd1', env: 'selado' } },
    },
  });
  // Nem com o próprio /device_uids (cada conta grava o seu) apontando para um PC da escola.
  await permitido(req('PUT', '/device_uids/uid-prof2', { auth: MEMBRO, body: 'd1' }));
  for (const [quem, outro] of [[MEMBRO, 'uid-prof'], [FUNDADOR, 'uid-prof2']]) {
    for (const caminho of [`/school/wifi/guardioes/${outro}`, `/school/wifi/guardioes/${outro}/chave`,
      `/school/wifi/guardioes/${outro}/pub`, '/school/wifi/chaves/d2', `/school/wifi/redes/${ID}/env`]) {
      await negado(req('GET', caminho, { auth: quem }));
    }
    for (const caminho of ['/school/wifi', '/school/wifi/redes', '/school/wifi/chaves', '/school/wifi/guardioes']) {
      await negado(req('GET', caminho, { auth: quem, query: '&shallow=true' }));
    }
  }
  await negado(req('GET', '/school/wifi/guardioes', { auth: MEMBRO, query: '&orderBy="$key"&equalTo="uid-prof2"' }));
  await permitido(req('GET', '/school/wifi/guardioes/uid-prof2/chave', { auth: MEMBRO }));
  for (const [quem, uid] of [[FORA, 'uid-fora'], [NAO_VERIFICADO, 'uid-nv'], [ANON, 'uid-anon']]) {
    await negado(req('GET', '/school/wifi/pubs', { auth: quem }));
    await negado(req('GET', `/school/wifi/guardioes/${uid}`, { auth: quem }));
  }
});

test('guardião: kcv só em base64url de 43, e o gravado não se troca nem se apaga', { skip }, async () => {
  await semearWifi();
  for (const torto of [KCV.slice(1), `${KCV}A`, `${KCV.slice(1)}=`, `${KCV.slice(1)}+`, 43]) {
    await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: torto }));
  }
  await permitido(req('PUT', '/school/wifi/meta/kcv', { auth: DEV1, body: KCV }));
  for (const quem of [DEV1, DEV2, MEMBRO, FUNDADOR]) {
    await negado(req('PUT', '/school/wifi/meta/kcv', { auth: quem, body: E43 }));
    await negado(req('PUT', '/school/wifi/meta/kcv', { auth: quem, body: null }));
    await negado(req('DELETE', '/school/wifi/meta/kcv', { auth: quem }));
    await negado(req('PATCH', '/school/wifi/meta', { auth: quem, body: { kcv: E43 } }));
    await negado(req('PUT', '/school/wifi/meta', { auth: quem, body: { de: 'd1', ts: agora, kcv: E43 } }));
  }
  assert.equal(await valor('/school/wifi/meta/kcv'), KCV);

  // O que nasce junto com a meta, numa escola nova, também fica.
  await req('DELETE', '/school/wifi', { admin: true });
  await permitido(req('PUT', '/school/wifi/meta', { auth: DEV2, body: { de: 'd2', ts: agora, kcv: KCV } }));
  await negado(req('PUT', '/school/wifi/meta/kcv', { auth: DEV2, body: E43 }));
  await negado(req('DELETE', '/school/wifi/meta/kcv', { auth: DEV2 }));
  assert.equal(await valor('/school/wifi/meta/kcv'), KCV);
});

test('guardião: entrega só na própria vaga, e só para PC do roster que publicou a pública', { skip }, async () => {
  await semearWifi();
  await req('PUT', '/school/devices/d5', { admin: true, body: false });
  await req('PATCH', '/school/wifi/pubs', { admin: true, body: { d3: 'PUB3', d5: 'PUB5' } });
  await req('PUT', '/school/wifi/entregas/d2/uid-prof', { admin: true, body: { pub: G43, env: 'do fundador', kcv: KCV } });
  const entrega = { pub: E43, env: 'selado', kcv: KCV };
  // d3 publicou mas não é da escola; d5 saiu do roster; d4 é da escola e não publicou.
  for (const pc of ['d3', 'd4', 'd5', 'd9']) {
    await negado(req('PUT', `/school/wifi/entregas/${pc}/uid-prof2`, { auth: MEMBRO, body: entrega }));
  }
  await negado(req('DELETE', '/school/wifi/entregas/d2/uid-prof', { auth: MEMBRO }));
  await negado(req('PATCH', '/school/wifi/entregas/d2', { auth: MEMBRO, body: { 'uid-prof': entrega } }));
  await negado(req('PUT', '/school/wifi/entregas/d2', { auth: MEMBRO, body: { 'uid-prof2': entrega } }));
  await negado(req('DELETE', '/school/wifi/entregas', { auth: FUNDADOR }));
  assert.equal((await valor('/school/wifi/entregas/d2/uid-prof')).env, 'do fundador');

  await permitido(req('PUT', '/school/wifi/entregas/d2/uid-prof2', { auth: MEMBRO, body: entrega }));
  await permitido(req('PUT', '/school/devices/d2', { auth: FUNDADOR, body: false }));
  await negado(req('PUT', '/school/wifi/entregas/d2/uid-prof2', { auth: MEMBRO, body: { ...entrega, env: 'outro' } }));
});

test('guardião: não grava a chave no próprio nó, nem apontando o /device_uids para o PC de outro', { skip }, async () => {
  await semearWifi();
  const chave = { de: 'd1', env: 'selado' };
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: { pub: G43, ts: agora } }));
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof', { auth: FUNDADOR, body: { pub: G43, ts: agora } }));
  await permitido(req('PUT', '/device_uids/uid-prof2', { auth: MEMBRO, body: 'd1' }));
  for (const [quem, uid] of [[MEMBRO, 'uid-prof2'], [FUNDADOR, 'uid-prof']]) {
    const no = `/school/wifi/guardioes/${uid}`;
    await negado(req('PUT', `${no}/chave`, { auth: quem, body: chave }));
    await negado(req('PATCH', no, { auth: quem, body: { chave } }));
    await negado(req('PUT', no, { auth: quem, body: { pub: G43, ts: agora, chave } }));
  }
  assert.equal(await valor('/school/wifi/guardioes/uid-prof2/chave'), null);

  // A selada por um PC: o dono não mexe nela; só apaga, ou troca a pública com set no nó inteiro.
  await permitido(req('PUT', '/school/wifi/guardioes/uid-prof2/chave', { auth: DEV1, body: chave }));
  await negado(req('PUT', '/school/wifi/guardioes/uid-prof2/chave/env', { auth: MEMBRO, body: 'outro' }));
  await negado(req('PATCH', '/school/wifi/guardioes/uid-prof2', { auth: MEMBRO, body: { pub: E43 } }));
  assert.equal((await valor('/school/wifi/guardioes/uid-prof2/chave')).env, 'selado');
  await permitido(req('DELETE', '/school/wifi/guardioes/uid-prof2/chave', { auth: MEMBRO }));
});
