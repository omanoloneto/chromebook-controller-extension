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
  STORAGE_CLASSVIEW,
  STORAGE_VERSION,
} from '../lib/ipc.js';
import { firebaseConfig } from '../lib/firebase-config.js';
import { FirebaseSession, STREAM_WATCHDOG_MS } from '../lib/firebase.js';
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
import { deveAutoReconectar, AUTO_RECONNECT_MS } from '../lib/reconnect.js';

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

// Estado p/ a auto-reconexão: valor atual + QUANDO mudou (re-emissão do
// mesmo estado, ex.: 'connecting' a cada volta do mainLoop, não conta).
let ultimoEstado = 'connecting';
let estadoMudouEm = Date.now();
let ultimoAutoRestart = 0;

/// `detail` é só para o console (texto técnico nunca vai para a tela);
/// `motivo` é um código fixo que o popup traduz (hoje: 'vinculo_divergente').
function broadcast(state, detail, teacher, motivo = null) {
  if (detail) console.info('[CdA]', state, '-', detail);
  if (state !== ultimoEstado) {
    ultimoEstado = state;
    estadoMudouEm = Date.now();
  }
  chrome.runtime
    .sendMessage({ cmd: IPC.STATE_CHANGED, state, motivo, teacher: teacher ?? null })
    .catch(() => {});
}

/// Derruba a sessão Firebase inteira e deixa o mainLoop reconectar do zero
/// (mesma rotina do ↻ do popup e da auto-reconexão).
function reiniciarConexao() {
  fb?.stop();
  fb = null;
  bindWaitCancel?.();
  currentClient?.stop(); // faz o run() retornar -> o loop recomeça
}

// Auto-↻: preso em 'connecting' por 5s = reconecta sozinho (sem gate de rede).
setInterval(() => {
  const agora = Date.now();
  const decide = deveAutoReconectar({
    estado: ultimoEstado,
    presoMs: agora - estadoMudouEm,
    desdeUltimoRestartMs: agora - ultimoAutoRestart,
  });
  if (!decide) return;
  ultimoAutoRestart = agora;
  console.log('[CdA] auto-reconexão (preso em connecting)');
  reiniciarConexao();
}, AUTO_RECONNECT_MS);

// Rede voltou (troca de Wi-Fi/roaming, saiu do modo avião): reconecta na hora.
// Best-effort (navigator.onLine é pouco confiável no offscreen — a garantia é
// o heartbeat + o alarme do service worker).
globalThis.addEventListener('online', () => {
  if (ultimoEstado === 'connected') return;
  ultimoAutoRestart = Date.now();
  console.log('[CdA] rede voltou — reconectando');
  reiniciarConexao();
});

// Heartbeat p/ o service worker: prova de que o offscreen está VIVO e o stream
// recebendo eventos. Se parar de chegar (offscreen congelado no suspend, ou
// EventSource zumbi que não dispara onDown), o alarme do SW força OFF_RESTART —
// única recuperação que sobrevive a um offscreen travado (o alarme só recria
// offscreen AUSENTE; a auto-reconexão e o watchdog vivem DENTRO do offscreen).
const HEARTBEAT_MS = 20000;
setInterval(() => {
  const saudavel =
    ultimoEstado === 'connected' &&
    (currentClient?.streamAgeMs() ?? Infinity) < STREAM_WATCHDOG_MS;
  chrome.runtime.sendMessage({ cmd: IPC.HEARTBEAT, healthy: saudavel }).catch(() => {});
}, HEARTBEAT_MS);

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
  // Sessão que nunca autenticou (signIn lançou no meio): mata o timer de
  // refresh órfão antes de recriar — senão cada retry do mainLoop vaza um.
  fb?.stop();
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
  const meta = {
    uid: fb.uid,
    pub: pubToB64url(id.pubRaw),
    label: id.label,
    v: 4,
  };
  // Versão da extensão (o app mostra). chrome.runtime.getManifest() NÃO existe
  // no offscreen — o service worker grava a versão no storage; lemos daqui.
  const ver = await storeGet(STORAGE_VERSION);
  if (typeof ver === 'string' && ver) meta.ext = ver;
  await fb.patch(`/devices/${id.deviceId}/meta`, meta);
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
          // Número da unidade atribuído pelo app (app >= 0.13; ausente = null).
          numero: typeof data.numero === 'number' ? data.numero : null,
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
  await storeSet(STORAGE_CLASSVIEW, null); // deixa de ser telão junto com o vínculo
  // Trava, prova, chat, pedidos e limites eram deste vínculo.
  await chrome.runtime.sendMessage({ cmd: IPC.TURMA_LIMPAR }).catch(() => {});
  if (!fb?.idToken) return; // sem sessão Firebase, só limpa o local
  const base = `/devices/${id.deviceId}`;
  for (const sufixo of ['bind', 'report', 'ack', 'presence', 'snapshot']) {
    await fb.delete(`${base}/${sufixo}`).catch(() => {});
  }
  // Escritas novas (rules podem estar atrasadas): caminho lateral.
  await fb.deleteQuiet(`${base}/up`);
  await fb.deleteQuiet(`/thumbs/${id.deviceId}`);
  await rotateToken(id);
}

/// Professor mudou o número da unidade (set_unit): atualiza binding, label
/// do keypair e meta/label (o app ouve meta/label e sincroniza o nome).
async function aplicarNumeroUnidade(numero) {
  try {
    const binding = await storeGet(STORAGE_BINDING);
    if (binding) await storeSet(STORAGE_BINDING, { ...binding, numero });
    const label = `Unidade ${numero}`;
    const kp = await storeGet(STORAGE_KEYPAIR);
    if (kp) await storeSet(STORAGE_KEYPAIR, { ...kp, label });
    if (identity) identity.label = label;
    if (fb?.idToken && identity) {
      await fb.patch(`/devices/${identity.deviceId}/meta`, { label }).catch(() => {});
    }
    return { ok: true };
  } catch (e) {
    console.warn('[CdA] set_unit falhou:', e?.message ?? e);
    return { ok: false, error: 'executor_falhou' };
  }
}

/// Tira 1 foto da webcam do aluno e devolve o JPEG em base64 (o CloudClient
/// cifra e grava em /snapshot). getUserMedia SEM prompt exige a policy do admin
/// `VideoCaptureAllowedUrls` com a origem desta extensão — senão rejeita com
/// NotAllowedError (o offscreen não tem UI para pedir permissão). O LED da
/// câmera acende enquanto captura (hardware, não desligável) e apaga no stop().
async function capturarFotoCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (e) {
    return { ok: false, error: 'camera_' + (e?.name ?? 'erro') };
  }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Warmup: sensor precisa de alguns frames para expor/focar direito.
    await sleep(400);
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    video.srcObject = null;
    const jpegB64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
    return { ok: true, jpegB64 };
  } catch (e) {
    console.warn('[CdA] captura da câmera falhou:', e?.message ?? e);
    return { ok: false, error: 'camera_falhou' };
  } finally {
    for (const t of stream.getTracks()) t.stop(); // apaga o LED
  }
}

/// Mapeia um comando decifrado para o executor no service worker.
async function executarComando(cmd) {
  // `cmd`/`target` por ÚLTIMO: uma chave do payload nunca troca o executor
  // (ex.: payload {cmd:'store:set'} viraria escrita no storage pelo proxy).
  const exec = (ipcCmd, extras) =>
    chrome.runtime
      .sendMessage({ ...(extras ?? {}), target: undefined, cmd: ipcCmd })
      .catch((e) => {
        console.warn('[CdA] executor no SW falhou:', e?.message ?? e);
        return { ok: false, error: 'executor_falhou' };
      })
      .then((res) => res ?? { ok: false, error: 'sem_resposta' });

  switch (cmd.type) {
    case MessageType.OPEN_URL:
      return exec(IPC.EXEC_OPEN_URL, cmd.payload);
    case MessageType.CLOSE_TABS:
      return exec(IPC.EXEC_CLOSE_TABS, cmd.payload);
    case MessageType.CLOSE_ALL_TABS:
      return exec(IPC.EXEC_CLOSE_ALL_TABS, cmd.payload);
    case MessageType.SET_RULES:
      return exec(IPC.EXEC_SET_RULES, cmd.payload);
    case MessageType.SET_WALLPAPER:
      // O CloudClient já buscou o blob em /wallpapers/{teacherUid}.
      return exec(IPC.EXEC_WALLPAPER, {
        jpegB64: cmd.payload?.jpegB64,
        hash: cmd.payload?.hash,
      });
    case MessageType.SHOW_MESSAGE:
      return exec(IPC.EXEC_SHOW_MESSAGE, cmd.payload);
    case MessageType.SET_CLASS_VIEW:
      // payload.snapshot já validado pelo CloudClient (null = limpar).
      return exec(IPC.EXEC_SET_CLASSVIEW, cmd.payload);
    case MessageType.SET_UNIT:
      // Resolvido aqui mesmo (offscreen tem storage-proxy + fb; o SW não é
      // necessário): numero validado pelo CloudClient.
      return aplicarNumeroUnidade(cmd.payload?.numero);
    case MessageType.CAPTURE_CAMERA:
      // Captura precisa de DOM/getUserMedia — roda AQUI no offscreen, não no SW.
      return capturarFotoCamera();
    // Recursos de turma: quem tem janelas/abas/storage é o SW.
    case MessageType.CHAT_MESSAGE:
      // A hora do balão é a do envio pelo professor (PC que estava desligado).
      return exec(IPC.EXEC_CHAT_MESSAGE, { ...(cmd.payload ?? {}), ts: Number(cmd.ts) || null });
    case MessageType.UNBLOCK_RESULT:
      return exec(IPC.EXEC_UNBLOCK_RESULT, cmd.payload);
    case MessageType.SET_LOCK:
      // payload já limpo pelo CloudClient, com o prazo local calculado.
      return exec(IPC.EXEC_SET_LOCK, cmd.payload);
    case MessageType.SET_EXAM:
      return exec(IPC.EXEC_SET_EXAM, cmd.payload);
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

      broadcast('connecting', 'autenticando');
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

      // Unidade N vira o label do PC (o app mostra o mesmo nome por padrão).
      if (typeof binding.numero === 'number') {
        const label = `Unidade ${binding.numero}`;
        if (id.label !== label) {
          id.label = label;
          const kp = await storeGet(STORAGE_KEYPAIR);
          if (kp) await storeSet(STORAGE_KEYPAIR, { ...kp, label });
          await fb
            .patch(`/devices/${id.deviceId}/meta`, { label })
            .catch(() => {});
        }
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
        // Miniatura da grade ao vivo: captureVisibleTab só existe no SW.
        capturarThumb: async () =>
          (await chrome.runtime.sendMessage({ cmd: IPC.CAPTURE_THUMB }).catch(() => null)) ?? {
            motivo: 'falhou',
          },
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
        broadcast('connecting', 'vínculo divergente no servidor', null, 'vinculo_divergente');
        await sleep(5000);
      }
      // 'stopped' (OFF_RESTART/OFF_UNBIND): o loop segue e relê o estado.
    } catch (e) {
      broadcast('connecting', String(e?.message ?? e)); // só no console
      await sleep(4000);
    }
  }
}

// Tudo que chega ao offscreen vem do service worker (tellOffscreen e o `up`):
// nem página nem content script falam direto com ele — o SW decide o que
// sobe (rate-limit, pedido montado do registro do bloqueio) e quem desvincula.
const URL_DO_SW = chrome.runtime.getURL('background/service-worker.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== TARGET_OFFSCREEN) return false;
  if (sender?.id !== chrome.runtime.id || sender?.url !== URL_DO_SW) {
    sendResponse({ ok: false, erro: 'origem_invalida' });
    return false;
  }
  (async () => {
    if (msg.cmd === IPC.UP_SEND) {
      const cliente = currentClient;
      if (!cliente) {
        sendResponse({ ok: false, erro: 'sem_conexao' });
        return;
      }
      try {
        sendResponse(await cliente.sendUp(msg.tipo, msg.payload, msg.mid));
      } catch (e) {
        console.warn('[CdA] up falhou:', e?.message ?? e);
        sendResponse({ ok: false, erro: 'sem_conexao' });
      }
    } else if (msg.cmd === IPC.OFF_RESTART) {
      identity = null; // força reler o keypair (o timer de auto-↻ não precisa)
      reiniciarConexao();
      sendResponse({ ok: true });
    } else if (msg.cmd === IPC.OFF_UNBIND) {
      const id = await ensureIdentity();
      await desvincular(id);
      bindWaitCancel?.();
      broadcast('pairing', 'desvinculado pelo popup');
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'cmd_desconhecido' });
    }
  })();
  return true;
});

mainLoop();
