// Storage Rules (firebase/storage.rules): fotos cifradas em fotos/{uid}/{dia}/{ts13}_{r}.bin.
// SÓ RODA sob o emulador do Storage (pula sem FIREBASE_STORAGE_EMULATOR_HOST):
//
//   cd firebase && firebase emulators:exec --only database,storage --project demo-test \
//     "cd .. && node --test --test-concurrency=1 tests/*.mjs"
//
// API REST v0 do Firebase Storage (a mesma que o agente do Celita usa), com
// `Authorization: Firebase <idToken>`. O emulador não verifica assinatura.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const BUCKET = 'demo-test.appspot.com';
const skip = HOST ? false : 'requer o emulador (FIREBASE_STORAGE_EMULATOR_HOST)';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeToken(uid, { email, emailVerified } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return (
    b64u({ alg: 'none', typ: 'JWT' }) +
    '.' +
    b64u({
      sub: uid,
      user_id: uid,
      ...(email ? { email } : {}),
      ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
      iat: agora,
      exp: agora + 3600,
      auth_time: agora,
      aud: 'demo-test',
      iss: 'https://securetoken.google.com/demo-test',
      firebase: { identities: {}, sign_in_provider: email ? 'google.com' : 'anonymous' },
    }) +
    '.'
  );
}

const DEV1 = fakeToken('uid-dev1');
const DEV2 = fakeToken('uid-dev2');
const PROF = fakeToken('uid-prof', { email: 'prof@gmail.com', emailVerified: true });
const PROF_NV = fakeToken('uid-prof', { email: 'prof@gmail.com', emailVerified: false });
const SEM_FLAG = fakeToken('uid-x', { email: 'x@gmail.com' });

const DIA = '2026-09-28';
const R22 = 'AbCdEfGhIjKlMnOpQr_-09';
const LIMITE = 400 * 1024;

const foto = (uid, ts13, { dia = DIA, arquivo = `${ts13}_${R22}.bin` } = {}) =>
  `fotos/${uid}/${dia}/${arquivo}`;
const cabecalho = (auth) => (auth ? { Authorization: `Firebase ${auth}` } : {});
const objeto = (nome) => `http://${HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(nome)}`;

function enviar(nome, auth, corpo = Buffer.from('nonce||ciphertext')) {
  return fetch(`http://${HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(nome)}`, {
    method: 'POST',
    headers: { ...cabecalho(auth), 'Content-Type': 'application/octet-stream' },
    body: corpo,
  });
}
const baixar = (nome, auth, sufixo = '?alt=media') =>
  fetch(`${objeto(nome)}${sufixo}`, { headers: cabecalho(auth) });
const apagar = (nome, auth) => fetch(objeto(nome), { method: 'DELETE', headers: cabecalho(auth) });

async function status(r, esperado) {
  const res = await r;
  if (res.status !== esperado) {
    assert.fail(`esperava ${esperado}, veio ${res.status}: ${await res.text()}`);
  }
  return res;
}
const permitido = async (r) => assert.equal((await r).ok, true, 'esperava permissão');
const negado = (r) => status(r, 403);

test('storage: dono cria e reenvia (update) a própria foto', { skip }, async () => {
  const nome = foto('uid-dev1', '1790000000001');
  await permitido(enviar(nome, DEV1, Buffer.from('v1')));
  await permitido(enviar(nome, DEV1, Buffer.from('v2')));
  const r = await status(baixar(nome, PROF), 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'v2');
  await permitido(enviar(foto('uid-dev1', '1790000000002'), DEV1, Buffer.alloc(LIMITE - 1)));
});

test('storage: uid, dia, nome e tamanho inválidos são negados', { skip }, async () => {
  const ts = '1790000000010';
  await negado(enviar(foto('uid-dev2', ts), DEV1));
  await negado(enviar(foto('uid-dev1', ts), undefined));
  await negado(enviar(foto('uid-dev1', ts), PROF));

  for (const dia of ['2026-9-28', 'hoje', '2026-09-28x']) {
    await negado(enviar(foto('uid-dev1', ts, { dia }), DEV1));
  }
  for (const arquivo of [
    `${ts}_${R22}.jpg`,
    `${ts}_${R22}`,
    `${ts}_${R22.slice(1)}.bin`,
    `${ts}_${R22}A.bin`,
    `${ts}_${R22.slice(1)}=.bin`,
    `179000000001_${R22}.bin`,
    `${ts}-${R22}.bin`,
    `${ts}_${R22}xbin`,
  ]) {
    await negado(enviar(foto('uid-dev1', ts, { arquivo }), DEV1));
  }

  await negado(enviar(foto('uid-dev1', '1790000000011'), DEV1, Buffer.alloc(LIMITE)));
  await negado(enviar(`fotos/uid-dev1/${ts}_${R22}.bin`, DEV1));
  await negado(enviar(`fotos/uid-dev1/${DIA}/sub/${ts}_${R22}.bin`, DEV1));
  await negado(enviar(`outra/uid-dev1/${DIA}/${ts}_${R22}.bin`, DEV1));
});

test('storage: ler exige email_verified; dono e anônimo não leem', { skip }, async () => {
  const nome = foto('uid-dev1', '1790000000020');
  await permitido(enviar(nome, DEV1));
  await status(baixar(nome, PROF), 200);
  await status(baixar(nome, PROF, ''), 200);

  await negado(baixar(nome, PROF_NV));
  await negado(baixar(nome, SEM_FLAG));
  await negado(baixar(nome, DEV1));
  await negado(baixar(nome, DEV2));
  await negado(baixar(nome, undefined));
});

test('storage: listar é negado para todos', { skip }, async () => {
  await permitido(enviar(foto('uid-dev1', '1790000000030'), DEV1));
  for (const prefixo of ['fotos/', 'fotos/uid-dev1/', `fotos/uid-dev1/${DIA}/`, '']) {
    for (const auth of [PROF, DEV1]) {
      await negado(
        fetch(`http://${HOST}/v0/b/${BUCKET}/o?prefix=${encodeURIComponent(prefixo)}`, {
          headers: cabecalho(auth),
        }),
      );
    }
  }
});

test('storage: apagar só o dono', { skip }, async () => {
  const nome = foto('uid-dev1', '1790000000040');
  await permitido(enviar(nome, DEV1));
  await negado(apagar(nome, DEV2));
  await negado(apagar(nome, PROF));
  await negado(apagar(nome, undefined));
  await status(apagar(nome, DEV1), 204);
  await status(baixar(nome, PROF), 404);
});
