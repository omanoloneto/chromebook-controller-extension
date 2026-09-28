// Rules do workspace da escola (/school/* + escola fechada por /school/members).
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

// Escola criada + colega liberado + device pareado com a escola (bind.teacherUid = schoolUid).
async function semearEscola() {
  await req('DELETE', '/', { admin: true });
  await req('PUT', '/school', {
    admin: true,
    body: {
      meta: { schoolUid: 'uid-prof', criadoEm: 1 },
      keypair: { keys: 'PRIV:PUB', ts: 1 },
      members: { [MEMBRO_G2]: true },
    },
  });
  await req('PUT', '/devices/d1', {
    admin: true,
    body: {
      meta: { uid: 'uid-device', pub: 'PUB_DEVICE', label: 'PC 1', v: 4 },
      pairing: { token: 'tok-atual' },
      bind: {
        teacherUid: 'uid-prof',
        teacherPub: 'PUB_ESCOLA',
        teacherName: 'Prof',
        token: 'tok-atual',
        ts: 1,
      },
    },
  });
}

test('school/meta+keypair: create-once pelo fundador; anônimo nem lê', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await permitido(
    req('PUT', '/school/meta', { auth: FUNDADOR, body: { schoolUid: 'uid-prof', criadoEm: 1 } }),
  );
  await permitido(
    req('PUT', '/school/keypair', { auth: FUNDADOR, body: { keys: 'PRIV:PUB', ts: 1 } }),
  );
  await permitido(req('PUT', `/school/members/${MEMBRO_G2}`, { auth: FUNDADOR, body: true }));
  // Sobrescrever a chave = negado p/ QUALQUER professor (troca só via console).
  await negado(req('PUT', '/school/keypair', { auth: PROF_G2, body: { keys: 'HACK', ts: 2 } }));
  await negado(req('PUT', '/school/meta', { auth: PROF_G2, body: { schoolUid: 'uid-prof2', criadoEm: 2 } }));
  // Leitura: professor liberado sim; anônimo/device não.
  await permitido(req('GET', '/school/keypair', { auth: PROF_G2 }));
  await negado(req('GET', '/school/keypair', { auth: DEV }));
  await negado(req('GET', '/school/keypair', { auth: ANON }));
});

test('devices da escola: qualquer professor liberado comanda; anônimo alheio não', { skip }, async () => {
  await semearEscola();
  // Professor novo (não é o dono do bind) lê, enfileira cmd e grava state.
  await permitido(req('GET', '/devices/d1', { auth: PROF_G2 }));
  await permitido(req('POST', '/devices/d1/cmd', { auth: PROF_G2, body: 'env' }));
  await permitido(req('PUT', '/devices/d1/state/rules', { auth: PROF_G2, body: 'env' }));
  // Fundador (sessão anonymous + email) continua funcionando — regressão crítica.
  await permitido(req('POST', '/devices/d1/cmd', { auth: FUNDADOR, body: 'env' }));
  // Anônimo sem email e sem bind: nada.
  await negado(req('GET', '/devices/d1', { auth: ANON }));
  await negado(req('POST', '/devices/d1/cmd', { auth: ANON, body: 'forja' }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: ANON, body: 'forja' }));
});

test('bind: professor liberado pareia PELA escola (teacherUid = schoolUid); token segue obrigatório', { skip }, async () => {
  await semearEscola();
  await req('PUT', '/devices/d2', {
    admin: true,
    body: { meta: { uid: 'uid-d2', pub: 'P2', label: 'PC 2', v: 4 }, pairing: { token: 'tok-2' } },
  });
  // PROF_G2 pareia d2 em nome da escola.
  await permitido(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'Colega', token: 'tok-2', ts: 2 },
    }),
  );
  // teacherUid arbitrário (nem o dele, nem o da escola) → negado.
  await req('PUT', '/devices/d2/pairing/token', { admin: true, body: 'tok-3' });
  await negado(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-x', teacherPub: 'X', teacherName: 'X', token: 'tok-3', ts: 3 },
    }),
  );
  // Sem o token atual → negado (mesmo liberado).
  await negado(
    req('PUT', '/devices/d2/bind', {
      auth: PROF_G2,
      body: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'C', token: 'tok-velho', ts: 4 },
    }),
  );
  // Professor liberado pode desfazer o bind (esquecer PC da escola).
  await permitido(req('DELETE', '/devices/d1/bind', { auth: PROF_G2 }));
});

test('school/stores: chaves válidas por professor liberado; inválida/anônimo negados', { skip }, async () => {
  await semearEscola();
  await permitido(
    req('PUT', '/school/stores/turmas', { auth: PROF_G2, body: { rev: 1, env: 'env' } }),
  );
  await permitido(
    req('PUT', '/school/stores/rules', { auth: FUNDADOR, body: { rev: 1, env: 'env' } }),
  );
  await negado(req('PUT', '/school/stores/outra', { auth: PROF_G2, body: { rev: 1, env: 'x' } }));
  await negado(req('PUT', '/school/stores/turmas', { auth: ANON, body: { rev: 2, env: 'forja' } }));
  await permitido(req('GET', '/school/stores', { auth: FUNDADOR }));
  await negado(req('GET', '/school/stores', { auth: DEV }));
});

test('school/aulas: trava é do dono; takeover só expirada (>15min)', { skip }, async () => {
  await semearEscola();
  const agora = Date.now();
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: FUNDADOR,
      body: { uid: 'uid-prof', ts: agora, env: 'env' },
    }),
  );
  // Outro professor: trava fresca → negado (update e delete).
  await negado(
    req('PUT', '/school/aulas/d1', { auth: PROF_G2, body: { uid: 'uid-prof2', ts: agora, env: 'e' } }),
  );
  await negado(req('DELETE', '/school/aulas/d1', { auth: PROF_G2 }));
  // Dono atualiza (heartbeat) e deleta.
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: FUNDADOR,
      body: { uid: 'uid-prof', ts: agora + 1, env: 'env' },
    }),
  );
  await permitido(req('DELETE', '/school/aulas/d1', { auth: FUNDADOR }));
  // Trava órfã (ts velho) → takeover permitido.
  await req('PUT', '/school/aulas/d1', {
    admin: true,
    body: { uid: 'uid-prof', ts: agora - 16 * 60000, env: 'env' },
  });
  await permitido(
    req('PUT', '/school/aulas/d1', {
      auth: PROF_G2,
      body: { uid: 'uid-prof2', ts: agora, env: 'env' },
    }),
  );
});

test('history e wallpapers da escola: qualquer professor liberado', { skip }, async () => {
  await semearEscola();
  await permitido(
    req('PUT', '/history/uid-prof/123/meta', { auth: PROF_G2, body: 'env' }),
  );
  await permitido(req('GET', '/history/uid-prof', { auth: PROF_G2 }));
  await negado(req('GET', '/history/uid-prof', { auth: ANON }));
  await permitido(
    req('PUT', '/wallpapers/uid-prof', {
      auth: PROF_G2,
      body: { hash: 'abc', jpeg: 'AAAA', ts: 1 },
    }),
  );
});

// A página inicial dos alunos (escolacelita.com/home) lê este nó sem login
// nenhum: é a única leitura pública do banco. Escrever continua sendo só da
// professor liberado da escola — senão qualquer anônimo trocaria os atalhos da turma.
test('página inicial: leitura pública, escrita só de professor liberado', { skip }, async () => {
  await semearEscola();
  const config = { rev: 1, cfg: '{"titulo":"Celita","atalhos":[]}' };

  await permitido(req('PUT', '/home/escola', { auth: PROF_G2, body: config }));
  await permitido(req('GET', '/home/escola', {}));
  await permitido(req('GET', '/home/escola', { auth: DEV }));

  await negado(req('PUT', '/home/escola', { auth: ANON, body: config }));
  await negado(req('PUT', '/home/escola', { body: config }));
  await negado(req('PUT', '/home/escola', { auth: DEV, body: config }));
});

test('página inicial: recusa campo estranho e configuração gigante', { skip }, async () => {
  await semearEscola();
  await negado(
    req('PUT', '/home/escola', {
      auth: PROF_G2,
      body: { rev: 1, cfg: '{}', script: 'x' },
    }),
  );
  await negado(
    req('PUT', '/home/escola', {
      auth: PROF_G2,
      body: { rev: 1, cfg: 'x'.repeat(9000) },
    }),
  );
  await negado(
    req('PUT', '/home/outra', { auth: PROF_G2, body: { rev: 1, cfg: '{}' } }),
  );
});

// Escola fechada: e-mail verificado fora de school/members é só uma conta
// qualquer. Cobre cada porteiro que antes aceitava `auth.token.email != null`.
test('escola fechada: membro comanda; conta Google fora da lista não', { skip }, async () => {
  await semearEscola();
  await req('PUT', '/archive/d1/nav/2026-09-28/k1', { admin: true, body: { env: 'env', ts: 1 } });
  await req('PUT', '/school/aulas/d1', { admin: true, body: { uid: 'uid-prof', ts: 1, env: 'env' } });

  await permitido(req('GET', '/school/keypair', { auth: PROF_G2 }));
  await permitido(req('PUT', '/devices/d1/state/rules', { auth: PROF_G2, body: 'env' }));
  await permitido(req('POST', '/devices/d1/cmd', { auth: PROF_G2, body: 'env' }));

  // O app distingue "não há escola" de "não liberado" lendo meta.
  await permitido(req('GET', '/school/meta', { auth: INTRUSO }));
  await negado(req('GET', '/school/keypair', { auth: INTRUSO }));
  await negado(req('GET', '/school/members', { auth: INTRUSO }));
  await negado(req('GET', '/devices/d1', { auth: INTRUSO }));
  await negado(req('GET', '/archive/d1', { auth: INTRUSO }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: INTRUSO, body: 'forja' }));
  await negado(req('POST', '/devices/d1/cmd', { auth: INTRUSO, body: 'forja' }));
  await negado(req('DELETE', '/devices/d1/bind', { auth: INTRUSO }));
  await negado(req('GET', '/school/devices', { auth: INTRUSO }));
  await negado(req('PUT', '/school/devices/d1', { auth: INTRUSO, body: true }));
  await negado(req('GET', '/school/stores', { auth: INTRUSO }));
  await negado(req('PUT', '/school/stores/rules', { auth: INTRUSO, body: { rev: 9, env: 'forja' } }));
  await negado(req('GET', '/school/aulas', { auth: INTRUSO }));
  await negado(
    req('PUT', '/school/aulas/d2', { auth: INTRUSO, body: { uid: 'uid-intruso', ts: 1, env: 'e' } }),
  );
  await negado(req('GET', '/history/uid-prof', { auth: INTRUSO }));
  await negado(req('PUT', '/history/uid-prof/1/meta', { auth: INTRUSO, body: 'forja' }));
  await negado(req('PUT', '/home/escola', { auth: INTRUSO, body: { rev: 1, cfg: '{}' } }));
  await negado(req('GET', '/wallpapers/uid-prof', { auth: INTRUSO }));
  await negado(
    req('PUT', '/wallpapers/uid-prof', { auth: INTRUSO, body: { hash: 'x', jpeg: 'A', ts: 1 } }),
  );

  // Pareia PELA escola com o token certo: continua exigindo ser membro.
  await req('PUT', '/devices/d2', {
    admin: true,
    body: { meta: { uid: 'uid-d2', pub: 'P2', label: 'PC 2', v: 4 }, pairing: { token: 'tok-2' } },
  });
  await negado(
    req('PUT', '/devices/d2/bind', {
      auth: INTRUSO,
      body: { teacherUid: 'uid-prof', teacherPub: 'PUB_ESCOLA', teacherName: 'I', token: 'tok-2', ts: 2 },
    }),
  );

  // O ack é apagado por quem comanda: membro sim, fora da lista não.
  await req('PUT', '/devices/d1/ack/a1', { admin: true, body: 'env' });
  await negado(req('DELETE', '/devices/d1/ack/a1', { auth: INTRUSO }));
  await permitido(req('DELETE', '/devices/d1/ack/a1', { auth: PROF_G2 }));
});

test('escola fechada: e-mail da lista sem email_verified é negado', { skip }, async () => {
  await semearEscola();
  await negado(req('GET', '/school/keypair', { auth: PROF_G2_NV }));
  await negado(req('GET', '/devices/d1', { auth: PROF_G2_NV }));
  await negado(req('PUT', '/devices/d1/state/rules', { auth: PROF_G2_NV, body: 'forja' }));
  await negado(req('POST', '/devices/d1/cmd', { auth: PROF_G2_NV, body: 'forja' }));
  await negado(req('GET', `/school/members/${MEMBRO_G2}`, { auth: PROF_G2_NV }));
});

test('escola fechada: fundador sem entrada em members mantém acesso', { skip }, async () => {
  await semearEscola();
  const r = await req('GET', '/school/members/fundador@gmail,com', { admin: true });
  assert.equal(await r.json(), null, 'fundador não está na lista');

  await permitido(req('GET', '/school/keypair', { auth: FUNDADOR }));
  await permitido(req('GET', '/school/members', { auth: FUNDADOR }));
  await permitido(req('GET', '/devices/d1', { auth: FUNDADOR }));
  await permitido(req('PUT', '/devices/d1/state/rules', { auth: FUNDADOR, body: 'env' }));
  await permitido(req('POST', '/devices/d1/cmd', { auth: FUNDADOR, body: 'env' }));
  await permitido(req('PUT', '/school/stores/names', { auth: FUNDADOR, body: { rev: 1, env: 'e' } }));
  await permitido(req('GET', '/archive/d1', { auth: FUNDADOR }));
});

test('escola do zero: fundador cria meta e keypair com members vazio', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await permitido(
    req('PUT', '/school/meta', { auth: FUNDADOR, body: { schoolUid: 'uid-prof', criadoEm: 1 } }),
  );
  await permitido(
    req('PUT', '/school/keypair', { auth: FUNDADOR, body: { keys: 'PRIV:PUB', ts: 1 } }),
  );
  // O agente (conta anônima) só precisa do schoolUid; o resto de meta não.
  await permitido(req('GET', '/school/meta/schoolUid', { auth: DEV }));
  await negado(req('GET', '/school/meta', { auth: DEV }));

  // Mesma criação num PATCH multi-caminho.
  await req('DELETE', '/', { admin: true });
  await permitido(
    req('PATCH', '/', {
      auth: FUNDADOR,
      body: {
        'school/meta': { schoolUid: 'uid-prof', criadoEm: 1 },
        'school/keypair': { keys: 'PRIV:PUB', ts: 1 },
      },
    }),
  );
  const r = await req('GET', '/school/keypair/keys', { admin: true });
  assert.equal(await r.json(), 'PRIV:PUB');

  // Criar escola exige e-mail verificado.
  await req('DELETE', '/', { admin: true });
  const naoVerificado = fakeToken('uid-prof', {
    email: 'fundador@gmail.com',
    provider: 'password',
    emailVerified: false,
  });
  await negado(
    req('PUT', '/school/meta', { auth: naoVerificado, body: { schoolUid: 'uid-prof', criadoEm: 1 } }),
  );
});

test('não membro não sequestra a escola: meta alheia e keypair replantada', { skip }, async () => {
  await req('DELETE', '/', { admin: true });
  await negado(
    req('PUT', '/school/meta', { auth: INTRUSO, body: { schoolUid: 'uid-prof', criadoEm: 1 } }),
  );
  await negado(
    req('PATCH', '/', {
      auth: INTRUSO,
      body: {
        'school/meta': { schoolUid: 'uid-prof', criadoEm: 1 },
        'school/keypair': { keys: 'HACK', ts: 1 },
      },
    }),
  );
  // Sem meta, ninguém planta a chave.
  await negado(req('PUT', '/school/keypair', { auth: INTRUSO, body: { keys: 'HACK', ts: 1 } }));

  // Keypair apagada pelo console: só o fundador repõe.
  await semearEscola();
  await req('DELETE', '/school/keypair', { admin: true });
  await negado(req('PUT', '/school/keypair', { auth: INTRUSO, body: { keys: 'HACK', ts: 2 } }));
  await negado(req('PUT', '/school/keypair', { auth: PROF_G2, body: { keys: 'HACK', ts: 2 } }));
  await negado(req('PUT', '/school/keypair', { auth: ANON, body: { keys: 'HACK', ts: 2 } }));
  await permitido(req('PUT', '/school/keypair', { auth: FUNDADOR, body: { keys: 'PRIV:PUB', ts: 3 } }));
});

test('school/members: só o fundador escreve; formato da chave validado', { skip }, async () => {
  await semearEscola();
  await permitido(req('PUT', '/school/members/novo@escola,com,br', { auth: FUNDADOR, body: true }));
  await permitido(req('DELETE', '/school/members/novo@escola,com,br', { auth: FUNDADOR }));
  await permitido(
    req('PATCH', '/school/members', {
      auth: FUNDADOR,
      body: { "o'neil+aula@escola,com": true, 'ana_b-c@x-y,com': true },
    }),
  );

  // Autoliberação e liberação por colega são negadas.
  await negado(req('PUT', '/school/members/intruso@gmail,com', { auth: INTRUSO, body: true }));
  await negado(req('PUT', '/school/members/amigo@gmail,com', { auth: PROF_G2, body: true }));
  await negado(req('DELETE', `/school/members/${MEMBRO_G2}`, { auth: PROF_G2 }));
  await negado(req('PUT', '/school/members/x@y,com', { auth: DEV, body: true }));

  // Valor só `true`; chave minúscula, com @, sem caracteres fora do padrão.
  await negado(req('PUT', '/school/members/novo@escola,com', { auth: FUNDADOR, body: 'sim' }));
  await negado(req('PUT', '/school/members/novo@escola,com', { auth: FUNDADOR, body: false }));
  await negado(req('PUT', '/school/members/Novo@escola,com', { auth: FUNDADOR, body: true }));
  await negado(req('PUT', '/school/members/semarroba,com', { auth: FUNDADOR, body: true }));
  await negado(req('PUT', '/school/members/a@b@c,com', { auth: FUNDADOR, body: true }));
  await negado(req('PUT', '/school/members/a%20b@c,com', { auth: FUNDADOR, body: true }));
});

test('school/members: cada um lê só a própria entrada; membro lê a lista', { skip }, async () => {
  await semearEscola();
  await permitido(req('GET', '/school/members/intruso@gmail,com', { auth: INTRUSO }));
  await negado(req('GET', `/school/members/${MEMBRO_G2}`, { auth: INTRUSO }));
  await negado(req('GET', '/school/members', { auth: INTRUSO }));
  await negado(req('GET', `/school/members/${MEMBRO_G2}`, { auth: DEV }));

  const propria = await req('GET', `/school/members/${MEMBRO_G2}`, { auth: PROF_G2 });
  assert.equal(propria.ok, true);
  assert.equal(await propria.json(), true);
  await permitido(req('GET', '/school/members', { auth: PROF_G2 }));
});

test('school/members: maiúsculas e pontos do e-mail casam com a chave', { skip }, async () => {
  await semearEscola();
  await req('PUT', '/school/members/ana,silva@escola,com,br', { admin: true, body: true });
  const ana = fakeToken('uid-ana', { email: 'Ana.Silva@Escola.COM.br', provider: 'google.com' });

  await permitido(req('GET', '/school/keypair', { auth: ana }));
  await permitido(req('POST', '/devices/d1/cmd', { auth: ana, body: 'env' }));
  await permitido(req('GET', '/school/members/ana,silva@escola,com,br', { auth: ana }));

  const parecida = fakeToken('uid-ana2', { email: 'Ana.Silva@Escola.com', provider: 'google.com' });
  await negado(req('GET', '/school/keypair', { auth: parecida }));
});
