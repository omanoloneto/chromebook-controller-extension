// Mensagens internas da extensão (popup <-> service worker <-> offscreen).
// NÃO confundir com o protocolo cifrado do transporte (docs/protocolo.md).

export const IPC = Object.freeze({
  // popup -> service worker
  GET_STATE: 'state:get', // resp: { state, detail, teacher }
  RESET_BIND: 'bind:reset', // esquece o professor vinculado
  SET_MANUAL_IP: 'ip:set', // { ip } guarda um IP do celular (fallback)

  // service worker -> offscreen
  OFF_RESTART: 'off:restart', // (re)inicia o loop de descoberta/conexão

  // offscreen -> service worker (executar comando do celular)
  EXEC_OPEN_URL: 'exec:openUrl', // { url, newTab, focus }; resp { ok, error }

  // offscreen -> broadcast (service worker e popup escutam)
  STATE_CHANGED: 'state:changed', // { state, detail, teacher }
});

export const TARGET_OFFSCREEN = 'offscreen';
export const STORAGE_KEYPAIR = 'keypair'; // {privJwk, pub, deviceId, label}
export const STORAGE_BINDING = 'binding'; // {teacherPub}
export const STORAGE_HINT = 'iphint'; // {manual, last}
