// Protocolo de mensagens — ver docs/protocolo.md (v4, Firebase).
// Compartilhado em espírito com o app Flutter (lib/src/commands/command.dart).
// Aqui ficam só helpers puros (sem chrome.*); a execução dos comandos é feita
// pelo service worker.

export const PROTOCOL_VERSION = 1;

// ---- Pareamento por QR (v4) ---------------------------------------------------

/// Monta o conteúdo do QR de pareamento (o app escaneia e valida `v === 4`).
export function makeQrPayload({ deviceId, pub, token, label }) {
  return JSON.stringify({ v: 4, id: deviceId, pub, tok: token, label: label ?? '' });
}

export const MessageType = Object.freeze({
  OPEN_URL: 'open_url',
  ACK: 'ack',
  PING: 'ping',
  PONG: 'pong',
  TAB_REPORT: 'tab_report',
  CLOSE_TABS: 'close_tabs',
  CLOSE_ALL_TABS: 'close_all_tabs',
  SET_RULES: 'set_rules',
  SET_WALLPAPER: 'set_wallpaper',
  SHOW_MESSAGE: 'show_message',
  SET_CLASS_VIEW: 'set_class_view',
  SET_UNIT: 'set_unit',
  CAPTURE_CAMERA: 'capture_camera', // app -> ext: tira 1 foto da webcam do aluno
  CAMERA_SNAPSHOT: 'camera_snapshot', // ext -> app: foto cifrada em /snapshot
  // Reservados (futuro):
  LOCK_SCREEN: 'lock_screen',
  UNLOCK_SCREEN: 'unlock_screen',
  FOCUS_MODE: 'focus_mode',
});

let seq = 0;
function nextId() {
  seq = (seq + 1) % 1e9;
  return `e${seq}`;
}

export function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function makeAck(id, ok, error = null) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: MessageType.ACK,
    id,
    ts: Date.now(),
    ok,
    error,
  });
}

export function makePong(id) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: MessageType.PONG,
    id,
    ts: Date.now(),
  });
}

export function makePing() {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: MessageType.PING,
    id: nextId(),
    ts: Date.now(),
  });
}

/// Valida uma URL antes de abrir (apenas http/https).
export function isSafeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- Relatório de abas (tab_report) -----------------------------------------
// Sobe cifrado (envelope) em /devices/{id}/report, sobrescrevendo o anterior.

export const MAX_REPORT_TABS = 30;
export const MAX_REPORT_EVENTS = 20;
export const MAX_REPORT_URL = 300;
export const MAX_REPORT_TITLE = 120;

const cortar = (s, max) => String(s ?? '').slice(0, max);

/// Monta o objeto `report` (retorna objeto, não string — é embutido no poll).
export function makeTabReport(tabs, events) {
  return {
    v: PROTOCOL_VERSION,
    type: MessageType.TAB_REPORT,
    tabs: (tabs ?? [])
      .filter((t) => isSafeHttpUrl(t?.url))
      .slice(0, MAX_REPORT_TABS)
      .map((t) => ({
        url: cortar(t.url, MAX_REPORT_URL),
        title: cortar(t.title, MAX_REPORT_TITLE),
        active: t.active === true,
      })),
    events: (events ?? [])
      .filter((e) => isSafeHttpUrl(e?.url))
      .slice(-MAX_REPORT_EVENTS)
      .map((e) => ({
        url: cortar(e.url, MAX_REPORT_URL),
        title: cortar(e.title, MAX_REPORT_TITLE),
        ts: typeof e.ts === 'number' ? e.ts : 0,
      })),
  };
}

// ---- Visão da turma (set_class_view, v0.4.3+) --------------------------------
// Snapshot agregado pelo APP e re-cifrado só para o PC do professor (telão).
// Caps espelhados com lib/src/commands/class_view.dart (paridade por fixture:
// tests/classview.test.mjs <-> test/class_view_test.dart).

export const MAX_CLASSVIEW_PCS = 60;
export const MAX_CLASSVIEW_NOME = 40;
export const MAX_CLASSVIEW_ALUNO = 60;
export const MAX_CLASSVIEW_TURMA = 60;
export const MAX_CLASSVIEW_TITULO = 120;
export const MAX_CLASSVIEW_DOMINIO = 100;

/// Valida/sanitiza o payload de um set_class_view. Retorna o snapshot limpo
/// `{rev, aula:{ativa, turma?}, pcs:[{nome, aluno?, online, aba?, alerta?}]}`
/// ou `null` se o payload for inválido (o chamador trata como "sem snapshot").
export function parseClassView(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rev = payload.rev;
  if (typeof rev !== 'number' || !Number.isFinite(rev) || rev <= 0) return null;
  if (!Array.isArray(payload.pcs)) return null;

  const aula = { ativa: payload.aula?.ativa === true };
  if (aula.ativa && typeof payload.aula?.turma === 'string') {
    aula.turma = cortar(payload.aula.turma, MAX_CLASSVIEW_TURMA);
  }

  const pcs = payload.pcs
    .filter((p) => p && typeof p === 'object' && typeof p.nome === 'string')
    .slice(0, MAX_CLASSVIEW_PCS)
    .map((p) => {
      const pc = {
        nome: cortar(p.nome, MAX_CLASSVIEW_NOME),
        online: p.online === true,
      };
      if (typeof p.aluno === 'string') pc.aluno = cortar(p.aluno, MAX_CLASSVIEW_ALUNO);
      if (p.aba && typeof p.aba.dominio === 'string') {
        pc.aba = {
          titulo: cortar(p.aba.titulo, MAX_CLASSVIEW_TITULO),
          dominio: cortar(p.aba.dominio, MAX_CLASSVIEW_DOMINIO),
        };
      }
      if (typeof p.alerta === 'string') pc.alerta = cortar(p.alerta, MAX_CLASSVIEW_DOMINIO);
      return pc;
    });

  return { rev, aula, pcs };
}
