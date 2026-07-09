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
  // Reservados (futuro):
  LOCK_SCREEN: 'lock_screen',
  UNLOCK_SCREEN: 'unlock_screen',
  SHOW_MESSAGE: 'show_message',
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
