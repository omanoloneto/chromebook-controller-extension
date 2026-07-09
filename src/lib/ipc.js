// Mensagens internas da extensão (popup <-> service worker <-> offscreen).
// NÃO confundir com o protocolo cifrado do transporte (docs/protocolo.md).

export const IPC = Object.freeze({
  // popup -> service worker
  GET_STATE: 'state:get', // resp: { state, detail, teacher, label }
  GET_PAIRING: 'pairing:get', // resp: { deviceId, pub, token, label } (dados do QR)
  RESET_BIND: 'bind:reset', // desvincular professor (limpa RTDB + storage)
  SET_LABEL: 'label:set', // { label } nome deste PC (vai no meta/label)

  // service worker -> offscreen
  OFF_RESTART: 'off:restart', // (re)inicia o loop de conexão (ex.: label novo)
  OFF_UNBIND: 'off:unbind', // desfaz o vínculo no RTDB e rotaciona o token

  // offscreen -> service worker (proxy de storage; offscreen não tem chrome.storage)
  STORE_GET: 'store:get', // { key } -> { value }
  STORE_SET: 'store:set', // { key, value } -> { ok }

  // offscreen -> service worker (executar comando do professor)
  EXEC_OPEN_URL: 'exec:openUrl', // { url, newTab, focus }; resp { ok, error }
  EXEC_CLOSE_TABS: 'exec:closeTabs', // { domain?, url? }; resp { ok, error }
  EXEC_CLOSE_ALL_TABS: 'exec:closeAllTabs', // { closeWindows? }; resp { ok, error }
  EXEC_SET_RULES: 'exec:setRules', // { rev, rules }; resp { ok }
  EXEC_WALLPAPER: 'exec:wallpaper', // { jpegB64, hash }; resp { ok, error }

  // offscreen -> service worker (relatório de abas para o professor)
  TABS_REPORT: 'tabs:report', // resp { report } (ver makeTabReport)

  // offscreen -> broadcast (service worker e popup escutam)
  STATE_CHANGED: 'state:changed', // { state: 'connected'|'pairing'|'connecting', detail, teacher }
});

export const TARGET_OFFSCREEN = 'offscreen';
export const STORAGE_KEYPAIR = 'keypair'; // {privJwk, pub, deviceId, label}
export const STORAGE_BINDING = 'binding'; // {teacherUid, teacherPub, teacherName}
export const STORAGE_PAIRING = 'pairing'; // {token} (one-time, vai no QR)
export const STORAGE_AUTH = 'fbauth'; // {uid, refreshToken} (Auth anônima)
export const STORAGE_REPLAY = 'replay'; // {cmd:{sid,seq}, rulesRev, wallpaperHash}
export const STORAGE_NAVLOG = 'navlog'; // [{url, title, ts, tabId}] (log rolante)
export const STORAGE_RULES = 'rules'; // {rev, rules:[{pattern}]} (bloqueio)
