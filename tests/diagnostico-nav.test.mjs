// Diagnóstico de navegação do Celita (NavDiag): tempo de carregamento por
// host, só com o agente pedindo, em lotes pela ponte nativa. Relógio falso.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavDiag } from '../src/background/diagnostico-nav.js';
import { Native } from '../src/background/native.js';

const T0 = 1767369600000;

/// `avancar(ms)` dispara os timers vencidos.
function relogioFalso() {
  let agora = 0;
  let timers = [];
  return {
    agendar: (fn, ms) => {
      const timer = { fn, em: agora + ms };
      timers.push(timer);
      return timer;
    },
    cancelar: (timer) => {
      timers = timers.filter((t) => t !== timer);
    },
    avancar(ms) {
      agora += ms;
      for (const timer of timers.filter((t) => t.em <= agora)) {
        timers = timers.filter((t) => t !== timer);
        timer.fn();
      }
    },
  };
}

/// `r.ponteOk = false` simula a ponte fora (enviar devolve false).
function montar() {
  const relogio = relogioFalso();
  const r = { enviados: [], ponteOk: true, avancar: (ms) => relogio.avancar(ms) };
  r.diag = new NavDiag({
    enviar: (itens) => {
      if (!r.ponteOk) return false;
      r.enviados.push([...itens]);
      return true;
    },
    relogio,
  });
  return r;
}

const detalhes = (aba, url, extra = {}) => ({ tabId: aba, url, frameId: 0, documentLifecycle: 'active', ...extra });

/// Início em t0, commit em t0 + resp (null = sem commit) e fim em t0 + ms.
function navegar(diag, { aba = 1, url = 'https://escola.example/', t0 = T0, resp = 300, ms = 1200, ...extra } = {}) {
  const d = detalhes(aba, url, extra);
  const doc = `doc-${aba}`;
  diag.inicio({ ...d, timeStamp: t0 });
  if (resp !== null) diag.commit({ ...d, timeStamp: t0 + resp, documentId: doc });
  diag.fim({ ...d, timeStamp: t0 + ms, documentId: doc });
}

test('desligado por padrão: nada é medido nem enviado', () => {
  const r = montar();
  navegar(r.diag);
  const d = detalhes(2, 'https://sem-dns.example/');
  r.diag.inicio({ ...d, timeStamp: T0 });
  r.diag.erro({ ...d, timeStamp: T0 + 100, error: 'net::ERR_NAME_NOT_RESOLVED' });
  r.avancar(60000);
  assert.deepEqual(r.enviados, []);
  assert.equal(r.diag.abas.size, 0);
});

test('página principal completa: ms desde o início e resp até o commit', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { resp: 300, ms: 1200 });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'escola.example', ms: 1200, resp: 300 }]]);
  assert.equal(r.diag.abas.size, 0);
});

test('sem commit visto, o item sai sem resp', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { resp: null, ms: 800 });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'escola.example', ms: 800 }]]);
});

test('erro de rede sai com o código; ERR_ABORTED (parou ou saiu) é descartado', () => {
  const r = montar();
  r.diag.ligar(true);
  const semDns = detalhes(1, 'https://sem-dns.example/');
  r.diag.inicio({ ...semDns, timeStamp: T0 });
  r.diag.erro({ ...semDns, timeStamp: T0 + 2500, error: 'net::ERR_NAME_NOT_RESOLVED' });
  const parou = detalhes(2, 'https://parou.example/');
  r.diag.inicio({ ...parou, timeStamp: T0 });
  r.diag.erro({ ...parou, timeStamp: T0 + 100, error: 'net::ERR_ABORTED' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'sem-dns.example', ms: 2500, erro: 'net::ERR_NAME_NOT_RESOLVED' }]]);
  assert.equal(r.diag.abas.size, 0);
});

test('subframe e prerender não contam nem encerram a navegação principal', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { aba: 1, frameId: 4 });
  navegar(r.diag, { aba: 2, documentLifecycle: 'prerender' });
  const principal = detalhes(3, 'https://principal.example/');
  const anuncio = detalhes(3, 'https://anuncio.example/', { frameId: 9 });
  r.diag.inicio({ ...principal, timeStamp: T0 });
  r.diag.inicio({ ...anuncio, timeStamp: T0 + 10 });
  r.diag.erro({ ...anuncio, timeStamp: T0 + 20, error: 'net::ERR_BLOCKED_BY_CLIENT' });
  r.diag.commit({ ...principal, timeStamp: T0 + 300, documentId: 'doc-p' });
  r.diag.fim({ ...anuncio, timeStamp: T0 + 400, documentId: 'doc-x' });
  r.diag.fim({ ...principal, timeStamp: T0 + 1000, documentId: 'doc-p' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'principal.example', ms: 1000, resp: 300 }]]);
});

test('só http(s): outros esquemas não medem e encerram a navegação da aba', () => {
  const r = montar();
  r.diag.ligar(true);
  for (const url of ['chrome://newtab/', 'file:///home/aluno/prova.html', 'about:blank', 'data:text/html,oi']) {
    navegar(r.diag, { url });
  }
  // A página de bloqueio (chrome-extension://) entra no lugar do site.
  const site = detalhes(2, 'https://bloqueado.example/');
  r.diag.inicio({ ...site, timeStamp: T0 });
  r.diag.commit({ ...site, timeStamp: T0 + 100, documentId: 'doc-site' });
  navegar(r.diag, { aba: 2, url: 'chrome-extension://abc/blocked/blocked.html', t0: T0 + 150 });
  r.diag.fim({ ...site, timeStamp: T0 + 900, documentId: 'doc-site' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, []);
  assert.equal(r.diag.abas.size, 0);
});

test('só o host minúsculo: caminho, query, fragmento e porta nunca ficam nem saem', () => {
  const r = montar();
  r.diag.ligar(true);
  const d = detalhes(1, 'https://WWW.Exemplo.com.br:8443/aluno/joana/notas?cpf=12345678900&token=segredo#boletim');
  r.diag.inicio({ ...d, timeStamp: T0 });
  const guardado = JSON.stringify([...r.diag.abas.values()]);
  for (const pedaco of ['aluno', 'joana', 'notas', 'cpf', '12345678900', 'segredo', 'boletim', '8443']) {
    assert.ok(!guardado.includes(pedaco), pedaco);
  }
  r.diag.erro({ ...d, timeStamp: T0 + 3000, error: 'net::ERR_CONNECTION_TIMED_OUT' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'www.exemplo.com.br', ms: 3000, erro: 'net::ERR_CONNECTION_TIMED_OUT' }]]);
});

test('aba fechada esquece a navegação', () => {
  const r = montar();
  r.diag.ligar(true);
  const d = detalhes(1, 'https://escola.example/');
  r.diag.inicio({ ...d, timeStamp: T0 });
  r.diag.esquecer(1);
  r.diag.commit({ ...d, timeStamp: T0 + 200, documentId: 'doc-1' });
  r.diag.fim({ ...d, timeStamp: T0 + 500, documentId: 'doc-1' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, []);
  assert.equal(r.diag.abas.size, 0);
});

test('início novo na mesma aba substitui o anterior', () => {
  const r = montar();
  r.diag.ligar(true);
  r.diag.inicio({ ...detalhes(1, 'https://antiga.example/'), timeStamp: T0 });
  navegar(r.diag, { url: 'https://nova.example/', t0: T0 + 1000, resp: 200, ms: 500 });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'nova.example', ms: 500, resp: 200 }]]);
});

test('a página anterior terminando depois do novo início não conta para a nova', () => {
  const r = montar();
  r.diag.ligar(true);
  const lenta = detalhes(1, 'https://lenta.example/');
  r.diag.inicio({ ...lenta, timeStamp: T0 });
  r.diag.commit({ ...lenta, timeStamp: T0 + 200, documentId: 'doc-lenta' });
  const nova = detalhes(1, 'https://nova.example/');
  r.diag.inicio({ ...nova, timeStamp: T0 + 1000 });
  r.diag.fim({ ...lenta, timeStamp: T0 + 1100, documentId: 'doc-lenta' });
  r.diag.commit({ ...nova, timeStamp: T0 + 1800, documentId: 'doc-nova' });
  r.diag.fim({ ...nova, timeStamp: T0 + 2500, documentId: 'doc-nova' });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [[{ host: 'nova.example', ms: 1500, resp: 800 }]]);
});

test('ms inteiro e limitado a 0..600000', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { aba: 1, resp: 0.4, ms: 700000 });
  navegar(r.diag, { aba: 2, resp: -50, ms: -10 }); // relógio de parede voltou
  navegar(r.diag, { aba: 3, resp: 299.5, ms: 1234.5 });
  r.avancar(5000);
  assert.deepEqual(r.enviados, [
    [
      { host: 'escola.example', ms: 600000, resp: 0 },
      { host: 'escola.example', ms: 0, resp: 0 },
      { host: 'escola.example', ms: 1235, resp: 300 },
    ],
  ]);
});

test('lote: 10 itens saem na hora, sem esperar o timer', () => {
  const r = montar();
  r.diag.ligar(true);
  for (let aba = 1; aba <= 9; aba++) navegar(r.diag, { aba });
  assert.equal(r.enviados.length, 0);
  navegar(r.diag, { aba: 10 });
  assert.equal(r.enviados.length, 1);
  assert.equal(r.enviados[0].length, 10);
  r.avancar(5000);
  assert.equal(r.enviados.length, 1, 'o timer do lote foi cancelado');
});

test('lote: o que estiver pendente sai 5 s depois do primeiro item', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { aba: 1, ms: 700 });
  r.avancar(3000);
  navegar(r.diag, { aba: 2, ms: 900 });
  r.avancar(1999);
  assert.equal(r.enviados.length, 0);
  r.avancar(1);
  assert.deepEqual(r.enviados, [
    [
      { host: 'escola.example', ms: 700, resp: 300 },
      { host: 'escola.example', ms: 900, resp: 300 },
    ],
  ]);
  r.avancar(60000);
  assert.equal(r.enviados.length, 1);
});

test('teto de 50 pendentes com a ponte fora: os mais antigos saem e o resto vai na volta', () => {
  const r = montar();
  r.diag.ligar(true);
  r.ponteOk = false;
  for (let i = 0; i < 60; i++) navegar(r.diag, { aba: i + 1, ms: 1000 + i });
  assert.equal(r.enviados.length, 0);
  assert.equal(r.diag.pendentes.length, 50);
  r.ponteOk = true;
  r.avancar(5000);
  assert.equal(r.enviados.length, 1);
  assert.deepEqual(
    r.enviados[0].map((item) => item.ms),
    Array.from({ length: 50 }, (_, i) => 1010 + i),
  );
});

test('desligar descarta os pendentes e as navegações em curso', () => {
  const r = montar();
  r.diag.ligar(true);
  navegar(r.diag, { aba: 1 });
  const emCurso = detalhes(2, 'https://escola.example/');
  r.diag.inicio({ ...emCurso, timeStamp: T0 });
  r.diag.ligar(false);
  r.avancar(10000);
  r.diag.ligar(true);
  r.diag.fim({ ...emCurso, timeStamp: T0 + 800, documentId: 'doc-2' });
  r.avancar(10000);
  assert.deepEqual(r.enviados, []);
});

// ---- Ponte nativa (chrome.runtime.connectNative falso) ----

function portaFalsa() {
  const ouvintes = { mensagem: [], queda: [] };
  return {
    enviadas: [],
    onMessage: { addListener: (fn) => ouvintes.mensagem.push(fn) },
    onDisconnect: { addListener: (fn) => ouvintes.queda.push(fn) },
    postMessage(msg) {
      this.enviadas.push(msg);
    },
    receber: (msg) => Promise.all(ouvintes.mensagem.map((fn) => fn(msg))),
    cair: () => ouvintes.queda.forEach((fn) => fn()),
  };
}

function conectar(t, opcoes) {
  const porta = portaFalsa();
  globalThis.chrome = { runtime: { connectNative: () => porta, getManifest: () => ({ version: '0.8.0' }) } };
  t.after(() => {
    delete globalThis.chrome;
  });
  const native = new Native(opcoes);
  native.conectar();
  return { native, porta };
}

test('ponte: diag liga só com ativo === true e a queda da conexão desliga', async (t) => {
  const pedidos = [];
  const { porta } = conectar(t, { onDiag: (ativo) => pedidos.push(ativo) });
  await porta.receber({ t: 'diag', ativo: true });
  await porta.receber({ t: 'diag', ativo: 'true' });
  await porta.receber({ t: 'diag', ativo: true });
  porta.cair();
  assert.deepEqual(pedidos, [true, false, true, false]);
});

test('ponte: com o diagnóstico ligado, os itens sobem como {t: "nav", itens}', async (t) => {
  const relogio = relogioFalso();
  let navDiag = null;
  const { native, porta } = conectar(t, { onDiag: (ativo) => navDiag.ligar(ativo) });
  navDiag = new NavDiag({ enviar: (itens) => native.enviar({ t: 'nav', itens }), relogio });
  const navs = () => porta.enviadas.filter((msg) => msg.t === 'nav');
  navegar(navDiag);
  relogio.avancar(5000);
  assert.deepEqual(navs(), [], 'sem diag do agente, nada sobe');
  await porta.receber({ t: 'diag', ativo: true });
  navegar(navDiag, { ms: 900 });
  relogio.avancar(5000);
  assert.deepEqual(navs(), [{ t: 'nav', itens: [{ host: 'escola.example', ms: 900, resp: 300 }] }]);
});
