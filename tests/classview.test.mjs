// Visão da turma (set_class_view): parser/sanitizador puro.
// Fixture espelhada com o app: test/class_view_test.dart usa a MESMA string
// JSON — mudou um lado, mude o outro.
//
// Rodar: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClassView,
  MAX_CLASSVIEW_PCS,
  MAX_CLASSVIEW_NOME,
  MAX_CLASSVIEW_TITULO,
} from '../src/lib/protocol.js';

// Exemplo normativo do docs/protocolo.md §3 (set_class_view).
const FIXTURE = `{
  "rev": 1767369600000,
  "aula": { "ativa": true, "turma": "8º B" },
  "pcs": [ { "nome": "PC 07", "aluno": "William", "online": true,
             "aba": { "titulo": "Khan Academy", "dominio": "pt.khanacademy.org" },
             "alerta": "youtube.com" },
           { "nome": "PC 03", "online": false } ]
}`;

test('parseClassView: fixture normativa passa intacta', () => {
  const s = parseClassView(JSON.parse(FIXTURE));
  assert.deepEqual(s, {
    rev: 1767369600000,
    aula: { ativa: true, turma: '8º B' },
    pcs: [
      {
        nome: 'PC 07',
        online: true,
        aluno: 'William',
        aba: { titulo: 'Khan Academy', dominio: 'pt.khanacademy.org' },
        alerta: 'youtube.com',
      },
      { nome: 'PC 03', online: false },
    ],
  });
});

test('fora de aula: ativa=false e sem turma', () => {
  const s = parseClassView({
    rev: 5,
    aula: { ativa: false, turma: 'não deveria vazar' },
    pcs: [{ nome: 'PC 01', online: true }],
  });
  assert.equal(s.aula.ativa, false);
  assert.equal('turma' in s.aula, false);
});

test('caps defensivos: 100 PCs viram 60; strings cortadas', () => {
  const pcs = Array.from({ length: 100 }, (_, i) => ({
    nome: 'N'.repeat(500) + i,
    online: true,
    aba: { titulo: 'T'.repeat(500), dominio: 'd.com' },
  }));
  const s = parseClassView({ rev: 1, aula: { ativa: false }, pcs });
  assert.equal(s.pcs.length, MAX_CLASSVIEW_PCS);
  assert.equal(s.pcs[0].nome.length, MAX_CLASSVIEW_NOME);
  assert.equal(s.pcs[0].aba.titulo.length, MAX_CLASSVIEW_TITULO);
});

test('inválidos viram null: sem rev, rev não-numérico, sem pcs, payload torto', () => {
  assert.equal(parseClassView(null), null);
  assert.equal(parseClassView('x'), null);
  assert.equal(parseClassView({ aula: {}, pcs: [] }), null);
  assert.equal(parseClassView({ rev: 'ontem', aula: {}, pcs: [] }), null);
  assert.equal(parseClassView({ rev: 0, aula: {}, pcs: [] }), null);
  assert.equal(parseClassView({ rev: 7, aula: {} }), null);
});

test('tolerante a campos faltando/tortos por PC', () => {
  const s = parseClassView({
    rev: 9,
    pcs: [
      { nome: 'ok', online: 'sim' }, // online não-bool -> false
      { online: true }, // sem nome -> descartado
      null, // -> descartado
      { nome: 'sem aba', online: true, aba: { titulo: 'sem domínio' } }, // aba sem dominio -> omitida
    ],
  });
  assert.equal(s.pcs.length, 2);
  assert.deepEqual(s.pcs[0], { nome: 'ok', online: false });
  assert.deepEqual(s.pcs[1], { nome: 'sem aba', online: true });
  assert.equal(s.aula.ativa, false); // aula ausente -> fora de aula
});
