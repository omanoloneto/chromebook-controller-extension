// Modo prova (set_exam): semântica normativa de docs/protocolo.md ("`set_exam`").
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motivoProva, provaAtiva } from '../src/lib/prova.js';
import { FILTROS_PADRAO } from '../src/lib/filtros.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const prova = {
  on: true,
  allow: [{ pattern: 'youtube.com' }, { pattern: 'docs.google.com/forms' }],
  inicio: 'https://escola.exemplo.br/portal/inicio',
};
const filtros = { ...FILTROS_PADRAO, canais: [] };
const m = (url, p = prova) => motivoProva(p, filtros, url, EXT);

test('prova desligada devolve undefined (vale o bloqueio de sempre)', () => {
  assert.equal(motivoProva(null, filtros, 'https://x.com', EXT), undefined);
  assert.equal(motivoProva({ ...prova, on: false }, filtros, 'https://x.com', EXT), undefined);
});

test('1: página da extensão, nova aba, chrome-search e about:blank liberam', () => {
  assert.equal(m(`chrome-extension://${EXT}/blocked/blocked.html?m=prova`), null);
  assert.equal(m('chrome://newtab/'), null);
  assert.equal(m('chrome://new-tab-page/'), null);
  assert.equal(m('chrome-search://local-ntp/local-ntp.html'), null);
  assert.equal(m('about:blank'), null);
});

test('2: esquema não http(s) bloqueia (data, javascript, view-source, file, chrome://settings, outra extensão)', () => {
  assert.equal(m('data:text/html,<h1>cola</h1>'), 'prova');
  assert.equal(m('javascript:alert(1)'), 'prova');
  assert.equal(m('view-source:https://youtube.com/'), 'prova');
  assert.equal(m('file:///home/aluno/cola.txt'), 'prova');
  assert.equal(m('chrome://settings/'), 'prova');
  assert.equal(m('chrome-extension://outraextensaoqualquerxxxxxxxxxxxx/x.html'), 'prova');
  assert.equal(m('about:config'), 'prova');
});

test('3: página inicial da escola libera por host + prefixo do caminho', () => {
  assert.equal(m('https://escola.exemplo.br/portal/inicio'), null);
  assert.equal(m('https://escola.exemplo.br/portal/inicio/aula-3?x=1'), null);
  assert.equal(m('https://ESCOLA.exemplo.br/portal/inicio'), null);
  assert.equal(m('https://escola.exemplo.br/outra-coisa'), 'prova');
  assert.equal(m('https://sub.escola.exemplo.br/portal/inicio'), 'prova');
  // sem inicio, só a lista allow
  assert.equal(m('https://escola.exemplo.br/portal/inicio', { ...prova, inicio: null }), 'prova');
});

test('4: allow + filtros — Shorts continua bloqueado, o resto do YouTube abre', () => {
  assert.equal(m('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(m('https://m.youtube.com/shorts/xyz'), 'shorts');
  assert.equal(m('https://docs.google.com/forms/d/123/viewform'), null);
  assert.equal(m('https://docs.google.com/document/d/1'), 'prova');
});

test('5: o resto bloqueia; regras de bloqueio do professor não valem em prova', () => {
  assert.equal(m('https://wikipedia.org/'), 'prova');
  // O motivo devolvido é só da prova/filtro: as `rules` nem entram na função —
  // um site em allow abre mesmo que uma regra de bloqueio o cite.
  const comRegra = { ...prova, allow: [{ pattern: 'g1.globo.com' }] };
  assert.equal(motivoProva(comRegra, filtros, 'https://g1.globo.com/', EXT), null);
});

test('URL ilegível não redireciona (null)', () => {
  assert.equal(m('não é url'), null);
});

test('provaAtiva respeita o prazo local (ausente = sem prazo, ponte do Celita)', () => {
  assert.equal(provaAtiva({ on: true, prazo: 2000 }, 1000), true);
  assert.equal(provaAtiva({ on: true, prazo: 2000 }, 2000), false);
  assert.equal(provaAtiva({ on: true }, 1e15), true);
  assert.equal(provaAtiva({ on: false, prazo: 5000 }, 1000), false);
  assert.equal(provaAtiva(null, 1000), false);
});
