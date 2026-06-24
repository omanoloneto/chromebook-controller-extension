// Protocolo de mensagens — ver docs/protocolo.md (compartilhado com o app).
//
// Este módulo concentra: versão do protocolo, criação de mensagens e ACKs,
// e o roteamento por "type". Mantenha em sincronia com o app Flutter.

export const PROTOCOL_VERSION = 1;

// Tipos de mensagem (espelham docs/protocolo.md).
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

// Monta um ACK para uma mensagem recebida.
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

// Roteia uma mensagem (string JSON) para o handler do seu "type".
// `reply(str)` envia uma resposta de volta pelo DataChannel.
export async function handleMessage(raw, reply) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // mensagem malformada: ignora
  }

  if (msg.v !== PROTOCOL_VERSION) {
    reply(makeAck(msg.id, false, 'versao_incompativel'));
    return;
  }

  switch (msg.type) {
    case MessageType.OPEN_URL:
      // TODO: validar URL (http/https) e chamar chrome.tabs.create/update.
      // reply(makeAck(msg.id, true));
      break;
    case MessageType.PING:
      // TODO: responder pong.
      break;
    default:
      reply(makeAck(msg.id, false, 'tipo_desconhecido'));
  }
}
