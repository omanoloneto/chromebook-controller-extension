// Vetores do anti-replay (sid/seq) — MESMA tabela do espelho Dart
// (chromebook-controller-app/test/replay_test.dart). Se quebrar,
// os dois lados divergiram na aceitação de envelopes — ver protocolo.md §3.
// Rodar: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayGuard } from '../src/lib/replay.js';

// Base de tempo fixa (epoch-ms) usada em todos os vetores.
const T0 = 1767369600000;
const HORA = 3600000;

// [sid, seq, ts, nowMs, esperado] — aplicados EM ORDEM no mesmo guard.
const VETORES_REPORT = [
  [1000, 1, T0, T0, true], // 1ª mensagem
  [1000, 2, T0, T0, true], // seq avança
  [1000, 2, T0, T0, false], // replay do mesmo seq
  [1000, 1, T0, T0, false], // replay de seq antigo
  [2000, 1, T0, T0, true], // época nova zera o contador
  [1000, 99, T0, T0, false], // época antiga rejeitada
  [2000, 3, T0 - 121000, T0, false], // ts velho demais (janela 120s)
  [2000, 3, T0 + 121000, T0, false], // ts futuro demais
  [2000, 3, T0 + 119000, T0, true], // folga de relógio ok (rejeições não mutaram)
  [2000, 4, T0 - 119000, T0, true], // dentro da janela p/ trás
];

// Canal cmd: janela de 12h p/ trás, folga padrão (120s) p/ frente.
const VETORES_CMD = [
  [1000, 1, T0 - 11 * HORA, T0, true], // comando de 11h atrás ainda vale
  [1000, 2, T0 - 13 * HORA, T0, false], // 13h atrás = velho demais
  [1000, 2, T0, T0, true], // seq continua de onde parou
];

test('vetores do canal report/ack (janela padrão ±120s)', () => {
  const g = new ReplayGuard();
  VETORES_REPORT.forEach(([sid, seq, ts, nowMs, esperado], i) => {
    assert.equal(g.accept({ sid, seq, ts, nowMs }), esperado, `vetor #${i + 1}`);
  });
});

test('vetores do canal cmd (janela 12h)', () => {
  const g = new ReplayGuard({ maxAgeMs: 12 * HORA });
  VETORES_CMD.forEach(([sid, seq, ts, nowMs, esperado], i) => {
    assert.equal(g.accept({ sid, seq, ts, nowMs }), esperado, `vetor #${i + 1}`);
  });
});

test('persistência: toJSON/from preservam o estado', () => {
  const g = new ReplayGuard({ maxAgeMs: 12 * HORA });
  assert.equal(g.accept({ sid: 5000, seq: 7, ts: T0, nowMs: T0 }), true);
  const restaurado = ReplayGuard.from(JSON.parse(JSON.stringify(g)), { maxAgeMs: 12 * HORA });
  // Replay do mesmo (sid, seq) rejeitado após restaurar.
  assert.equal(restaurado.accept({ sid: 5000, seq: 7, ts: T0, nowMs: T0 }), false);
  assert.equal(restaurado.accept({ sid: 5000, seq: 8, ts: T0, nowMs: T0 }), true);
});

test('from tolera nulo (estado inicial) e accept rejeita não-números', () => {
  const g = ReplayGuard.from(null);
  assert.equal(g.accept({ sid: 1, seq: 1, ts: T0, nowMs: T0 }), true);
  assert.equal(g.accept({ sid: 'x', seq: 2, ts: T0, nowMs: T0 }), false);
  assert.equal(g.accept({ sid: 2, seq: null, ts: T0, nowMs: T0 }), false);
});
