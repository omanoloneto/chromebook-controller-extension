// Anti-replay por épocas de sessão (sid/seq) — ver docs/protocolo.md §3.
// Precisa casar EXATAMENTE com o app (lib/src/cloud/replay_guard.dart).
//
// `sid` = epoch-ms amostrado 1x no início do processo remetente;
// `seq` = contador monotônico dentro do sid. Aceita se sid > lastSid
// (época nova) OU (sid == lastSid E seq > lastSeq). Rejeição NUNCA
// altera o estado. Puro (sem chrome.*/fetch) — testável (tests/replay.test.mjs).

/// Folga p/ relógio adiantado do remetente (e janela padrão p/ o passado).
export const TS_SKEW_MS = 120000;

export class ReplayGuard {
  /// `maxAgeMs`: idade máxima aceita do `ts` (no passado). O futuro é sempre
  /// limitado a TS_SKEW_MS. Canal `cmd` usa 12h; `report`/`ack` usam o padrão.
  constructor({ maxAgeMs = TS_SKEW_MS, lastSid = 0, lastSeq = 0 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.lastSid = lastSid;
    this.lastSeq = lastSeq;
  }

  /// Aceita e registra (sid, seq), ou rejeita sem alterar o estado.
  accept({ sid, seq, ts, nowMs }) {
    if (!Number.isFinite(sid) || !Number.isFinite(seq) || !Number.isFinite(ts)) {
      return false;
    }
    if (ts < nowMs - this.maxAgeMs) return false; // velho demais
    if (ts > nowMs + TS_SKEW_MS) return false; // futuro demais
    if (sid > this.lastSid) {
      this.lastSid = sid;
      this.lastSeq = seq;
      return true;
    }
    if (sid === this.lastSid && seq > this.lastSeq) {
      this.lastSeq = seq;
      return true;
    }
    return false;
  }

  /// Estado p/ persistência (espelho de `toMap()` no Dart).
  toJSON() {
    return { sid: this.lastSid, seq: this.lastSeq };
  }

  static from(m, { maxAgeMs = TS_SKEW_MS } = {}) {
    return new ReplayGuard({
      maxAgeMs,
      lastSid: Number(m?.sid) || 0,
      lastSeq: Number(m?.seq) || 0,
    });
  }
}
