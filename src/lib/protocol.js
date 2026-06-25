// Protocolo de mensagens do DataChannel — ver docs/protocolo.md.
// Compartilhado em espírito com o app Flutter (lib/src/commands/command.dart).
// Aqui ficam só helpers puros (sem chrome.*); a execução dos comandos é feita
// pelo service worker.

export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  OPEN_URL: 'open_url',
  ACK: 'ack',
  PING: 'ping',
  PONG: 'pong',
  // Reservados (futuro):
  LOCK_SCREEN: 'lock_screen',
  UNLOCK_SCREEN: 'unlock_screen',
  SHOW_MESSAGE: 'show_message',
  CLOSE_TABS: 'close_tabs',
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
