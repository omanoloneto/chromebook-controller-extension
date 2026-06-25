// Mensagens internas da extensão (IPC entre popup, service worker e offscreen).
// NÃO confundir com o protocolo cifrado do transporte (docs/protocolo.md).

export const IPC = Object.freeze({
  // pairing/popup -> service worker
  PAIR_SAVE: 'pair:save', // { ip, port, key, name }; resp: { ok }
  GET_STATE: 'state:get', // resp: { state }

  // service worker -> offscreen (sempre com target: 'offscreen')
  OFF_START_CLIENT: 'off:startClient', // (re)inicia o cliente a partir do storage
  OFF_STOP_CLIENT: 'off:stopClient',

  // offscreen -> service worker (executar comando do celular)
  EXEC_OPEN_URL: 'exec:openUrl', // { url, newTab, focus }; resp: { ok, error }

  // offscreen -> broadcast (service worker e popup escutam)
  STATE_CHANGED: 'state:changed', // { state: 'connected' | 'disconnected' }
});

export const TARGET_OFFSCREEN = 'offscreen';
export const STORAGE_KEY = 'pairing'; // chrome.storage.local
