// Mensagens internas da extensão (popup <-> service worker <-> offscreen).
// NÃO confundir com o protocolo cifrado do transporte (docs/protocolo.md).

export const IPC = Object.freeze({
  // popup -> service worker
  GET_STATE: 'state:get', // resp: { state, motivo, teacher, label, numero, version, modo, maoAte? }
  GET_PAIRING: 'pairing:get', // resp: { deviceId, pub, token, label } (dados do QR)
  RESET_BIND: 'bind:reset', // desvincular professor (limpa RTDB + storage)
  RECONNECT: 'conn:reconnect', // botão ↻: derruba e refaz a conexão Firebase

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
  EXEC_SHOW_MESSAGE: 'exec:showMessage', // { title, body }; resp { ok, error }
  EXEC_SET_CLASSVIEW: 'exec:setClassView', // { snapshot|null } persiste/limpa a visão da turma; resp { ok }

  // offscreen -> service worker (relatório de abas para o professor)
  TABS_REPORT: 'tabs:report', // resp { report } (ver makeTabReport)

  // offscreen -> broadcast (service worker e popup escutam)
  STATE_CHANGED: 'state:changed', // { state: 'connected'|'pairing'|'connecting', motivo, teacher } (sem texto cru)

  // ---- Recursos de turma (ext >= 0.7.0) ----
  // service worker -> offscreen: sela e grava um item na fila `up` (o offscreen
  // só aceita vindo do service worker). { tipo, payload, mid }; resp { ok, erro? }
  UP_SEND: 'up:send',
  // offscreen -> service worker: captura a miniatura da aba ativa (grade ao vivo).
  // resp { jpegB64, w, h } | { motivo: 'sem_permissao'|'aba_protegida'|'falhou' }
  CAPTURE_THUMB: 'thumb:capture',
  EXEC_CHAT_MESSAGE: 'exec:chatMessage', // { texto, de, mid, ts }; resp { ok, error }
  EXEC_UNBLOCK_RESULT: 'exec:unblockResult', // { mid, site, approved, motivo?, rulesRev?, examRev? }
  EXEC_SET_LOCK: 'exec:setLock', // { rev, envTs, on, texto, mute, prazo }; resp { ok }
  EXEC_SET_EXAM: 'exec:setExam', // { rev, envTs, on, allow, inicio, prazo }; resp { ok }
  TURMA_LIMPAR: 'turma:limpar', // desvincular: some chat, pedidos, limites, trava e prova

  // janela de chat / popup -> service worker
  CHAT_HISTORICO: 'chat:historico', // resp { de, itens, naoLidas, maoAte, conectado, travada }
  CHAT_ENVIAR: 'chat:enviar', // { id, texto }; resp { ok, aviso? }
  CHAT_REENVIAR: 'chat:reenviar', // { id }; resp { ok, aviso? }
  CHAT_MAO: 'chat:mao', // levantar a mão; resp { ok, maoAte, aviso? }
  CHAT_LIDAS: 'chat:lidas', // janela visível: zera as não lidas
  CHAT_ABRIR: 'chat:abrir', // popup "Falar com o professor"
  // service worker -> janela de chat (broadcast)
  CHAT_EVENTO: 'chat:evento', // { tipo: 'mao', maoAte }

  // offscreen -> service worker: prova de vida ({ healthy: stream recebendo
  // eventos }). O SW usa p/ detectar offscreen TRAVADO (congelado no suspend /
  // EventSource zumbi) e forçar OFF_RESTART — recuperação que sobrevive a um
  // offscreen que parou de reconectar sozinho.
  HEARTBEAT: 'hb',
});

export const TARGET_OFFSCREEN = 'offscreen';
export const STORAGE_KEYPAIR = 'keypair'; // {privJwk, pub, deviceId, label}
export const STORAGE_BINDING = 'binding'; // {teacherUid, teacherPub, teacherName, numero?}
export const STORAGE_PAIRING = 'pairing'; // {token} (one-time, vai no QR)
export const STORAGE_AUTH = 'fbauth'; // {uid, refreshToken} (Auth anônima)
export const STORAGE_REPLAY = 'replay'; // {cmd:{sid,seq}, rulesRev, wallpaperHash, classviewRev, unitRev, lockRev, examRev, monitorRev}
export const STORAGE_NAVLOG = 'navlog'; // [{url, title, ts, tabId}] (log rolante)
export const STORAGE_RULES = 'rules'; // {rev, rules:[{pattern}]} (bloqueio)
export const STORAGE_FILTROS = 'filtros'; // {shorts, reels, tiktok, ias, canais[]} já efetivos (content scripts leem)
export const STORAGE_CLASSVIEW = 'classview'; // {rev, aula, pcs, recebidoEm} (presente = este PC é o telão)
export const STORAGE_VERSION = 'extVersion'; // versão da extensão (SW grava; offscreen lê — getManifest não existe no offscreen)
export const STORAGE_SCHOOL_ORIGINS = 'schoolOrigins'; // string[] origins a preservar na limpeza de sessão (ausente = DEFAULT_SCHOOL_ORIGINS)
export const STORAGE_WIPE_PENDING = 'wipePending'; // true enquanto uma limpeza de sessão não concluiu (retry no próximo onStartup)
export const STORAGE_TRAVA = 'trava'; // {rev, envTs, on, texto, mute, prazo, mutadas[], janela, encerrada?} ("Olhos em mim", cópia local)
export const STORAGE_PROVA = 'prova'; // {rev, envTs, on, allow[], inicio, prazo?, encerrada?} (modo prova, cópia local)
export const STORAGE_LIMITES = 'limites'; // rate-limit do `up` (src/lib/limites.js)

// chrome.storage.session (some ao fechar o navegador; sobrevive à morte do SW/offscreen)
export const SESSAO_BLOQUEIOS = 'bloqueios'; // {tabId: {url, host, motivo, ts}} (≤ 50)
export const SESSAO_PEDIDOS = 'pedidos'; // {host: {mid, ts, estado:'enviado'|'aprovado'|'recusado', motivoRecusa?}}
export const SESSAO_CHAT = 'chat'; // {de, itens:[{id, autor, de?, texto, ts, estado?}], naoLidas, maoAte}
export const SESSAO_CHAT_JANELA = 'chatJanela'; // windowId da janela de chat
