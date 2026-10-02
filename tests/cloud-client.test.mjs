// CloudClient: trava, prova e grade ao vivo (state/lock|exam|monitor), canal
// `up` e confirmação positiva (`aplicado`). Firebase falso; envelopes
// selados de verdade (AES-GCM) como o app faria.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient } from '../src/lib/cloud-client.js';
import { seal, open, importKey } from '../src/lib/crypto.js';
import { MessageType, MONITOR_TETO_MS, TRAVA_TETO_MS } from '../src/lib/protocol.js';

const SERVIDOR = 1767369600000; // "agora" no relógio do servidor/professor
const MIN = 60000;

const tick = () => new Promise((r) => setImmediate(r));

function fbFalso({ statusLateral = 200, lastSeen = null } = {}) {
  const log = [];
  return {
    log,
    statusLateral,
    lastSeen,
    serverTimestamp: () => ({ '.sv': 'timestamp' }),
    async put(path, v) {
      log.push(['put', path, v]);
      if (path.endsWith('/presence')) return { lastSeen: this.lastSeen ?? undefined };
      return v;
    },
    async get() {
      return null;
    },
    async delete(path) {
      log.push(['delete', path]);
      return null;
    },
    async putQuiet(path, v) {
      log.push(['putQuiet', path, v]);
      return { status: this.statusLateral, body: null };
    },
    async postQuiet(path, v) {
      log.push(['postQuiet', path, v]);
      return { status: this.statusLateral, body: { name: '-Nx' } };
    },
    async deleteQuiet(path) {
      log.push(['deleteQuiet', path]);
      return { status: 200, body: null };
    },
    async getQuiet() {
      return { status: 200, body: {} };
    },
    stream() {
      return { close() {}, _lastEventAt: 0 };
    },
  };
}

/// Cliente rodando (run) com relógios falsos. `pcAtrasoMs`: o relógio de
/// parede do PC fica atrás do servidor.
async function montar({ fb = fbFalso(), pcAtrasoMs = 0, replay = {}, ack = { ok: true }, thumb } = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importKey(raw);
  const relogio = { agora: SERVIDOR - pcAtrasoMs, mono: 5000 };
  const comandos = [];
  let salvo = null;
  const capturas = [];
  const c = new CloudClient({
    fb,
    deviceId: 'd1',
    sessionKey: raw,
    teacher: { teacherUid: 'prof', teacherPub: 'pub' },
    onCommand: async (cmd) => {
      comandos.push(cmd);
      return ack;
    },
    getReport: async () => ({
      tabs: [],
      events: [],
      aplicado: { trava: { rev: 7, on: true }, prova: null },
    }),
    onState: () => {},
    loadReplay: async () => replay,
    saveReplay: async (r) => {
      salvo = r;
    },
    capturarThumb: async () => {
      capturas.push(relogio.mono);
      return thumb ?? { jpegB64: 'AAAA', w: 480, h: 270 };
    },
    agora: () => relogio.agora,
    agoraMono: () => relogio.mono,
  });
  const fim = c.run();
  await tick();
  await tick();
  let seq = 0;
  const env = (type, payload, ts = SERVIDOR) =>
    seal(key, { v: 1, sid: 1, seq: ++seq, ts, type, id: `e${seq}`, payload });
  const rotear = async (path, data, type = 'put') => {
    c._route(path, data, type);
    await c._chain;
    await tick();
  };
  return { c, fb, key, relogio, comandos, capturas, env, rotear, fim, salvo: () => salvo };
}

const daTrava = (comandos) => comandos.filter((x) => x.type === MessageType.SET_LOCK);

test('lock: mesmo rev REAPLICA (respawn na reentrega); rev menor é ignorado', async () => {
  const t = await montar();
  const e5 = await t.env(MessageType.SET_LOCK, { rev: 5, on: true, texto: 'Olhem aqui', ate: SERVIDOR + 20 * MIN });
  await t.rotear('/state/lock', e5);
  await t.rotear('/state/lock', e5);
  assert.equal(daTrava(t.comandos).length, 2);
  assert.equal(t.salvo().lockRev, 5);
  const e4 = await t.env(MessageType.SET_LOCK, { rev: 4, on: false });
  await t.rotear('/state/lock', e4);
  assert.equal(daTrava(t.comandos).length, 2);
  // reconexão: put completo em '/' com o mesmo estado reaplica também
  await t.rotear('/', { bind: { teacherPub: 'pub' }, state: { lock: e5 } });
  assert.equal(daTrava(t.comandos).length, 3);
  t.c.stop();
  assert.equal(await t.fim, 'stopped');
});

test('lock: nulo, ausente ou ilegível NÃO destrava', async () => {
  const t = await montar();
  await t.rotear('/state/lock', null);
  await t.rotear('/state', { rules: undefined });
  await t.rotear('/state/lock', 'bGl4byBxdWFscXVlciBkZSB0YW1hbmhvIGJvbQ==');
  const outraChave = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  await t.rotear(
    '/state/lock',
    await seal(outraChave, { v: 1, sid: 1, seq: 1, ts: SERVIDOR, type: MessageType.SET_LOCK, payload: { rev: 9, on: false } }),
  );
  assert.equal(daTrava(t.comandos).length, 0);
  t.c.stop();
});

test('lock: prazo local = agora + clamp(ate − env.ts, 0, 2 h), independente do relógio do PC', async () => {
  const t = await montar({ pcAtrasoMs: 3 * 3600000 }); // PC 3 h atrasado
  await t.rotear('/state/lock', await t.env(MessageType.SET_LOCK, { rev: 1, on: true, ate: SERVIDOR + 20 * MIN }));
  assert.equal(daTrava(t.comandos)[0].payload.prazo, t.relogio.agora + 20 * MIN);
  await t.rotear('/state/lock', await t.env(MessageType.SET_LOCK, { rev: 2, on: true, ate: SERVIDOR + 9 * 3600000 }));
  assert.equal(daTrava(t.comandos)[1].payload.prazo, t.relogio.agora + TRAVA_TETO_MS);
  t.c.stop();
});

test('lock/prova LIGADA em envelope de mais de 12 h não liga (re-pareamento com state velho)', async () => {
  const t = await montar();
  const velho = SERVIDOR - 13 * 3600000;
  await t.rotear('/state/lock', await t.env(MessageType.SET_LOCK, { rev: 3, on: true, ate: velho + 20 * MIN }, velho));
  assert.equal(daTrava(t.comandos)[0].payload.prazo, t.relogio.agora); // vencida já
  await t.rotear('/state/exam', await t.env(MessageType.SET_EXAM, { rev: 3, on: true, allow: [], ate: velho + 2 * 3600000 }, velho));
  const prova = t.comandos.find((x) => x.type === MessageType.SET_EXAM);
  assert.equal(prova.payload.prazo, t.relogio.agora);
  t.c.stop();
});

test('patch em "/" não é lido como nó inteiro (sem bind ≠ desvinculado) e aplica o filho', async () => {
  const t = await montar();
  const e = await t.env(MessageType.SET_LOCK, { rev: 1, on: false });
  await t.rotear('/', { state: { lock: e } }, 'patch');
  assert.equal(t.c.running, true);
  assert.equal(daTrava(t.comandos).length, 1);
  t.c.stop();
});

test('monitor: relógio do PC 10 min atrasado — aceita pelo relógio corrigido e para em 45 s', async () => {
  const fb = fbFalso({ lastSeen: SERVIDOR });
  const t = await montar({ fb, pcAtrasoMs: 10 * MIN });
  assert.ok(Math.abs(t.c.clockOffset - 10 * MIN) < 1000, 'desvio medido pela presença');
  // professor manda ate absurdo (1 h): o teto de 45 s vale
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 1, ate: SERVIDOR + 60 * MIN }));
  await t.c._thumbTick;
  const thumbs = () => fb.log.filter((l) => l[0] === 'putQuiet' && l[1] === '/thumbs/d1');
  assert.equal(thumbs().length, 1);
  const env = thumbs()[0][2].env;
  const snap = await open(t.key, env);
  assert.equal(snap.type, MessageType.THUMB_SNAPSHOT);
  assert.equal(snap.jpegB64, 'AAAA');
  t.relogio.mono += MONITOR_TETO_MS - 1;
  await t.c._monitorTick();
  assert.equal(thumbs().length, 2);
  t.relogio.mono += 1;
  await t.c._monitorTick();
  assert.equal(thumbs().length, 2, 'parou: não grava mais');
  assert.equal(fb.log.filter((l) => l[0] === 'deleteQuiet' && l[1] === '/thumbs/d1').length, 1);
  assert.equal(t.c._thumbTimer, null);
  t.c.stop();
});

test('monitor: envelope velho (fora de ±120 s), replay de rev e nulo', async () => {
  const fb = fbFalso({ lastSeen: SERVIDOR });
  const t = await montar({ fb, replay: { monitorRev: 10 } });
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 11, ate: SERVIDOR + 30000 }, SERVIDOR - 5 * MIN));
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 10, ate: SERVIDOR + 30000 }));
  assert.equal(t.capturas.length, 0, 'velho e rev repetido não capturam');
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 12, ate: SERVIDOR + 30000 }));
  await t.c._thumbTick;
  assert.equal(t.capturas.length, 1);
  assert.equal(t.salvo().monitorRev, 12);
  await t.rotear('/state/monitor', null); // professor fechou a grade
  assert.equal(t.c._thumbTimer, null);
  assert.equal(fb.log.filter((l) => l[0] === 'deleteQuiet').length, 1);
  await t.rotear('/state/monitor', null); // de novo: não apaga duas vezes
  assert.equal(fb.log.filter((l) => l[0] === 'deleteQuiet').length, 1);
  t.c.stop();
});

test('monitor: sem permissão grava o marcador uma vez só', async () => {
  const fb = fbFalso({ lastSeen: SERVIDOR });
  const t = await montar({ fb, thumb: { motivo: 'sem_permissao' } });
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 1, ate: SERVIDOR + 40000 }));
  await t.c._thumbTick;
  await t.c._monitorTick();
  await t.c._monitorTick();
  const puts = fb.log.filter((l) => l[0] === 'putQuiet');
  assert.equal(puts.length, 1);
  const m = await open(t.key, puts[0][2].env);
  assert.equal(m.motivo, 'sem_permissao');
  assert.equal(m.jpegB64, null);
  t.c.stop();
});

test('401 em /thumbs e em up: desliga o recurso, não reconecta nem derruba o cliente', async () => {
  const fb = fbFalso({ statusLateral: 401, lastSeen: SERVIDOR });
  const t = await montar({ fb });
  await t.rotear('/state/monitor', await t.env(MessageType.SET_MONITOR, { rev: 1, ate: SERVIDOR + 40000 }));
  await t.c._thumbTick;
  await t.c._monitorTick();
  assert.equal(fb.log.filter((l) => l[0] === 'putQuiet').length, 1, 'parou de tentar até o próximo rev');
  assert.equal(t.c.running, true);

  assert.deepEqual(await t.c.sendUp('chat', { texto: 'oi' }), { ok: false, erro: 'sem_permissao' });
  assert.deepEqual(await t.c.sendUp('chat', { texto: 'oi de novo' }), { ok: false, erro: 'sem_permissao' });
  assert.equal(fb.log.filter((l) => l[0] === 'postQuiet').length, 1, 'segundo envio nem tenta (10 min)');
  t.relogio.mono += 10 * MIN;
  fb.statusLateral = 200;
  const r = await t.c.sendUp('chat', { texto: 'voltou' });
  assert.equal(r.ok, true);
  assert.equal(t.c.running, true);
  t.c.stop();
});

test('sendUp: sela {type, mid, payload} limpo e grava em devices/{id}/up', async () => {
  const fb = fbFalso();
  const t = await montar({ fb });
  const r = await t.c.sendUp('unblock_request', {
    site: 'youtube.com',
    url: 'https://youtube.com/watch?v=1',
    motivo: '  pesquisa  ',
    bloqueio: 'prova',
    lixo: 1,
  }, 'AAAAAAAAAAAAAAAA');
  assert.deepEqual(r, { ok: true, mid: 'AAAAAAAAAAAAAAAA' });
  const post = fb.log.find((l) => l[0] === 'postQuiet');
  assert.equal(post[1], '/devices/d1/up');
  const m = await open(t.key, post[2]);
  assert.equal(m.type, 'unblock_request');
  assert.equal(m.mid, 'AAAAAAAAAAAAAAAA');
  assert.deepEqual(m.payload, { site: 'youtube.com', url: 'https://youtube.com/watch?v=1', motivo: 'pesquisa', bloqueio: 'prova' });
  assert.deepEqual(await t.c.sendUp('unblock_request', { site: 'com' }), { ok: false, erro: 'payload_invalido' });
  assert.deepEqual(await t.c.sendUp('tipo_novo', {}), { ok: false, erro: 'payload_invalido' });
  t.c.stop();
});

test('relatório leva aplicado {trava, prova, acks}', async () => {
  const fb = fbFalso();
  const t = await montar({ fb, ack: { ok: false, error: 'sem_sessao' } });
  t.c._registrarAck('cmd1', { ok: false, error: 'sem_sessao' });
  await t.c._maybeReport();
  const put = fb.log.filter((l) => l[0] === 'put' && l[1] === '/devices/d1/report').pop();
  const rep = await open(t.key, put[2].env);
  assert.deepEqual(rep.aplicado, {
    trava: { rev: 7, on: true },
    prova: { rev: 0, on: false },
    acks: [{ id: 'cmd1', ok: false, error: 'sem_sessao' }],
  });
  t.c.stop();
});
