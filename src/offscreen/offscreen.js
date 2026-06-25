// Offscreen document — dono da RTCPeerConnection (papel "offerer").
// Roda fora do service worker porque WebRTC não existe em service workers (MV3).
// Conversa com o service worker / popup por mensagens (ver lib/ipc.js).

import { IPC, TARGET_OFFSCREEN } from '../lib/ipc.js';
import { makeOfferSignal, decodeSignal } from '../lib/signal.js';
import {
  parseMessage,
  makeAck,
  makePong,
  MessageType,
  PROTOCOL_VERSION,
} from '../lib/protocol.js';

// Sem servidor de sinalização. iceServers vazio => só host candidates (LAN).
const RTC_CONFIG = { iceServers: [] };
const ICE_TIMEOUT_MS = 3000; // se o gathering demorar, seguimos com o que houver
const DEVICE_NAME = 'Chromebook do professor';

let pc = null;
let channel = null;

function broadcastState(state) {
  chrome.runtime.sendMessage({ cmd: IPC.STATE_CHANGED, state }).catch(() => {});
}

function closeConnection() {
  try {
    channel?.close();
  } catch {}
  try {
    pc?.close();
  } catch {}
  channel = null;
  pc = null;
}

// Espera o ICE gathering terminar (ou estoura o timeout) — modo "non-trickle".
function waitIceComplete(peer) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === 'complete') return resolve();
    const done = () => {
      peer.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    peer.addEventListener('icegatheringstatechange', onChange);
    setTimeout(done, ICE_TIMEOUT_MS);
  });
}

function wireChannel(ch) {
  channel = ch;
  ch.onopen = () => broadcastState('connected');
  ch.onclose = () => broadcastState('disconnected');
  ch.onmessage = (ev) => handleChannelMessage(ev.data);
}

function wirePeer(peer) {
  peer.onconnectionstatechange = () => {
    const s = peer.connectionState;
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      broadcastState('disconnected');
    }
  };
}

async function createOffer() {
  closeConnection();
  broadcastState('connecting');
  pc = new RTCPeerConnection(RTC_CONFIG);
  wirePeer(pc);
  wireChannel(pc.createDataChannel('controle', { ordered: true }));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);

  return makeOfferSignal(pc.localDescription.sdp, DEVICE_NAME);
}

async function acceptAnswer(answerText) {
  if (!pc) throw new Error('sem_offer_ativo');
  const data = decodeSignal(answerText);
  if (data.role !== 'answer') throw new Error('qr_nao_e_answer');
  if (data.v !== PROTOCOL_VERSION) throw new Error('versao_incompativel');
  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

// Trata uma mensagem recebida do celular pelo DataChannel.
async function handleChannelMessage(raw) {
  const msg = parseMessage(raw);
  if (!msg) return;
  if (msg.v !== PROTOCOL_VERSION) {
    channel?.send(makeAck(msg.id, false, 'versao_incompativel'));
    return;
  }

  switch (msg.type) {
    case MessageType.PING:
      channel?.send(makePong(msg.id));
      break;

    case MessageType.OPEN_URL: {
      // A execução (chrome.tabs) é feita pelo service worker.
      const res = await chrome.runtime
        .sendMessage({ cmd: IPC.EXEC_OPEN_URL, ...msg.payload })
        .catch((e) => ({ ok: false, error: String(e) }));
      channel?.send(makeAck(msg.id, !!res?.ok, res?.error ?? null));
      break;
    }

    default:
      channel?.send(makeAck(msg.id, false, 'tipo_desconhecido'));
  }
}

// Mensagens vindas do service worker / popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET_OFFSCREEN) return false;

  (async () => {
    try {
      switch (msg.cmd) {
        case IPC.OFF_CREATE_OFFER:
          sendResponse({ ok: true, offer: await createOffer() });
          break;
        case IPC.OFF_ACCEPT_ANSWER:
          await acceptAnswer(msg.answer);
          sendResponse({ ok: true });
          break;
        case IPC.OFF_CLOSE:
          closeConnection();
          broadcastState('disconnected');
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'cmd_desconhecido' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();

  return true; // resposta assíncrona
});
