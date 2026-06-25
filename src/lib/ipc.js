// Mensagens internas da extensão (IPC entre popup, service worker e offscreen).
// NÃO confundir com o protocolo do DataChannel (docs/protocolo.md), que é o que
// trafega entre celular e Chromebook.

export const IPC = Object.freeze({
  // popup -> service worker
  PAIR_START: 'pair:start',   // inicia o pareamento; resp: { ok, offer }
  PAIR_ANSWER: 'pair:answer', // envia o answer lido do QR; resp: { ok }
  PAIR_RESET: 'pair:reset',   // encerra a conexão atual
  GET_STATE: 'state:get',     // resp: { state }

  // service worker -> offscreen (sempre com target: 'offscreen')
  OFF_CREATE_OFFER: 'off:createOffer',
  OFF_ACCEPT_ANSWER: 'off:acceptAnswer',
  OFF_CLOSE: 'off:close',

  // offscreen -> service worker (executar comando que chegou pelo DataChannel)
  EXEC_OPEN_URL: 'exec:openUrl', // { url, newTab, focus }; resp: { ok, error }

  // offscreen -> broadcast (service worker e popup escutam)
  STATE_CHANGED: 'state:changed', // { state: 'connected' | 'disconnected' | 'connecting' }
});

export const TARGET_OFFSCREEN = 'offscreen';
