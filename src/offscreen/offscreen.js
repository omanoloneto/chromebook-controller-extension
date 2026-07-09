// Offscreen document — orquestra Auth anônima + registro no RTDB + pareamento
// (QR/TOFU) + cliente de comandos. Vive fora do service worker (que hiberna).
// Ver docs/protocolo.md (v4 — Firebase).

import {
  IPC,
  TARGET_OFFSCREEN,
  STORAGE_KEYPAIR,
  STORAGE_BINDING,
  STORAGE_PAIRING,
  STORAGE_AUTH,
  STORAGE_REPLAY,
} from '../lib/ipc.js';
import { firebaseConfig } from '../lib/firebase-config.js';
import { FirebaseSession } from '../lib/firebase.js';
import { CloudClient } from '../lib/cloud-client.js';
import {
  generateKeyPair,
  exportPrivateJwk,
  importPrivateJwk,
  exportPublicRaw,
  importPublicRaw,
  pubToB64url,
  pubFromB64url,
  deriveSessionKey,
} from '../lib/keypair.js';
import { MessageType } from '../lib/protocol.js';

let identity = null; // { privKey, pubRaw, deviceId, label }
let fb = null; // FirebaseSession (vive o offscreen inteiro)
let currentClient = null;
let bindWatch = null; // stream do modo pareamento
let bindWaitCancel = null; // cancela o waitForBind (OFF_RESTART/OFF_UNBIND)
let looping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O offscreen NÃO tem chrome.storage; usa o service worker como proxy.
const storeGet = async (key) =>
  (await chrome.runtime.sendMessage({ cmd: IPC.STORE_GET, key }))?.value ?? null;
const storeSet = (key, value) =>
  chrome.runtime.sendMessage({ cmd: IPC.STORE_SET, key, value });

function broadcast(state, detail, teacher) {
  if (detail) console.log('[CdA]', state, '-', detail);
  chrome.runtime
    .sendMessage({ cmd: IPC.STATE_CHANGED, state, detail: detail ?? null, teacher: teacher ?? null })
    .catch(() => {});
}

async function ensureIdentity() {
  if (identity) return identity;
  const saved = await storeGet(STORAGE_KEYPAIR);
  if (saved?.privJwk) {
    identity = {
      privKey: await importPrivateJwk(saved.privJwk),
      pubRaw: pubFromB64url(saved.pub),
      deviceId: saved.deviceId,
      label: saved.label,
    };
    return identity;
  }
  const kp = await generateKeyPair();
  const pubRaw = await exportPublicRaw(kp);
  const deviceId = crypto.randomUUID();
  const label = 'Chromebook-' + deviceId.slice(0, 4);
  await storeSet(STORAGE_KEYPAIR, {
    privJwk: await exportPrivateJwk(kp),
    pub: pubToB64url(pubRaw),
    deviceId,
    label,
  });
  identity = { privKey: kp.privateKey, pubRaw, deviceId, label };
  return identity;
}

function novoToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return pubToB64url(bytes);
}

async function ensurePairToken() {
  const saved = await storeGet(STORAGE_PAIRING);
  if (saved?.token) return saved.token;
  const token = novoToken();
  await storeSet(STORAGE_PAIRING, { token });
  return token;
}

/// Rotaciona o token one-time (mata QRs já escaneados/fotografados).
async function rotateToken(id) {
  const token = novoToken();
  await storeSet(STORAGE_PAIRING, { token });
  await fb.put(`/devices/${id.deviceId}/pairing/token`, token).catch(() => {});
  return token;
}

async function ensureFirebase() {
  if (fb?.idToken) return fb;
  fb = new FirebaseSession({
    apiKey: firebaseConfig.apiKey,
    databaseURL: firebaseConfig.databaseURL,
    loadAuth: () => storeGet(STORAGE_AUTH),
    saveAuth: (a) => storeSet(STORAGE_AUTH, a),
  });
  await fb.signIn();
  return fb;
}

/// Registra/atualiza a identidade pública do PC no banco.
async function registrar(id, token) {
  await fb.patch(`/devices/${id.deviceId}/meta`, {
    uid: fb.uid,
    pub: pubToB64url(id.pubRaw),
    label: id.label,
    v: 4,
  });
  await fb.put(`/devices/${id.deviceId}/pairing/token`, token);
  await fb.put(`/device_uids/${fb.uid}`, id.deviceId);
}

/// Espera o professor escanear o QR (aparecer um bind com o NOSSO token).
/// Resolve com null se cancelado (OFF_RESTART/OFF_UNBIND).
function waitForBind(id, token) {
  return new Promise((resolve) => {
    const done = (valor) => {
      bindWatch?.close();
      bindWatch = null;
      bindWaitCancel = null;
      resolve(valor);
    };
    bindWaitCancel = () => done(null);
    bindWatch = fb.stream(`/devices/${id.deviceId}/bind`, {
      onEvent: ({ path, data }) => {
        if (path !== '/' || !data) return;
        if (data.token !== token) {
          console.warn('[CdA] bind com token divergente — ignorando (QR velho?)');
          return;
        }
        done({
          teacherUid: data.teacherUid,
          teacherPub: data.teacherPub,
          teacherName: data.teacherName ?? 'Professor',
        });
      },
      onDown: () => {},
    });
  });
}

/// Limpeza de privacidade + volta ao pareamento (unbind local e no banco).
async function desvincular(id) {
  currentClient?.stop();
  await storeSet(STORAGE_BINDING, null);
  await storeSet(STORAGE_REPLAY, null);
  if (!fb?.idToken) return; // sem sessão Firebase, só limpa o local
  const base = `/devices/${id.deviceId}`;
  for (const sufixo of ['bind', 'report', 'ack', 'presence']) {
    await fb.delete(`${base}/${sufixo}`).catch(() => {});
  }
  await rotateToken(id);
}

/// Mapeia um comando decifrado para o executor no service worker.
async function executarComando(cmd) {
  const exec = (ipcCmd, extras) =>
    chrome.runtime
      .sendMessage({ cmd: ipcCmd, ...(extras ?? {}) })
      .catch((e) => ({ ok: false, error: String(e) }))
      .then((res) => res ?? { ok: false, error: 'sem_resposta' });

  switch (cmd.type) {
    case MessageType.OPEN_URL:
      return exec(IPC.EXEC_OPEN_URL, cmd.payload);
    case MessageType.CLOSE_TABS:
      return exec(IPC.EXEC_CLOSE_TABS, cmd.payload);
    case MessageType.SET_RULES:
      return exec(IPC.EXEC_SET_RULES, cmd.payload);
    case MessageType.SET_WALLPAPER:
      // O CloudClient já buscou o blob em /wallpapers/{teacherUid}.
      return exec(IPC.EXEC_WALLPAPER, {
        jpegB64: cmd.payload?.jpegB64,
        hash: cmd.payload?.hash,
      });
    default:
      return { ok: false, error: 'tipo_desconhecido' };
  }
}

async function mainLoop() {
  if (looping) return;
  looping = true;
  while (true) {
    try {
      // Reler a cada volta: OFF_RESTART zera o cache (ex.: label renomeado).
      const id = await ensureIdentity();
      const token = await ensurePairToken();

      broadcast('connecting', 'autenticando no Firebase…');
      await ensureFirebase();
      await registrar(id, token);

      let binding = await storeGet(STORAGE_BINDING);
      if (!binding?.teacherPub) {
        broadcast('pairing', 'aguardando o professor escanear o QR…');
        binding = await waitForBind(id, token);
        if (!binding) continue; // cancelado (restart/unbind) — relê o estado
        await storeSet(STORAGE_BINDING, binding);
        await rotateToken(id); // QR escaneado morre aqui
        console.log('[CdA] pareado com', binding.teacherName);
      }

      const teacherPubKey = await importPublicRaw(pubFromB64url(binding.teacherPub));
      const sessionKey = await deriveSessionKey(id.privKey, teacherPubKey);

      broadcast('connected', null, binding.teacherName);
      currentClient = new CloudClient({
        fb,
        deviceId: id.deviceId,
        sessionKey,
        teacher: binding,
        onCommand: executarComando,
        onState: (ok, d) => broadcast(ok ? 'connected' : 'connecting', d, binding.teacherName),
        // O snapshot de abas vive no SW (offscreen não tem chrome.tabs).
        getReport: async () =>
          (await chrome.runtime.sendMessage({ cmd: IPC.TABS_REPORT }).catch(() => null))
            ?.report ?? null,
        loadReplay: () => storeGet(STORAGE_REPLAY),
        saveReplay: (r) => storeSet(STORAGE_REPLAY, r),
      });
      const motivo = await currentClient.run();
      currentClient = null;

      if (motivo === 'unbound') {
        // Professor desfez o vínculo ("esquecer PC") ou o nó sumiu.
        await desvincular(id);
        broadcast('pairing', 'professor desvinculou este PC');
      } else if (motivo === 'foreign_bind') {
        // bind no banco não bate com o professor pinado (TOFU) — não obedece.
        broadcast('connecting', 'vínculo divergente no servidor — desvincule pelo popup');
        await sleep(5000);
      }
      // 'stopped' (OFF_RESTART/OFF_UNBIND): o loop segue e relê o estado.
    } catch (e) {
      broadcast('connecting', String(e?.message ?? e));
      await sleep(4000);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET_OFFSCREEN) return false;
  (async () => {
    if (msg.cmd === IPC.OFF_RESTART) {
      identity = null; // força reler o keypair (ex.: label renomeado)
      bindWaitCancel?.();
      currentClient?.stop(); // faz o run() retornar -> o loop recomeça
      sendResponse({ ok: true });
    } else if (msg.cmd === IPC.OFF_UNBIND) {
      const id = await ensureIdentity();
      await desvincular(id);
      bindWaitCancel?.();
      broadcast('pairing', 'desvinculado — escaneie o QR para parear de novo');
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'cmd_desconhecido' });
    }
  })();
  return true;
});

mainLoop();
