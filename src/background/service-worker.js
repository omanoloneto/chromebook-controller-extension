// Service worker (Manifest V3) — orquestra o pareamento e executa comandos.
//
// Não roda WebRTC (impossível em service worker): isso fica no offscreen
// document. O service worker só: cria/garante o offscreen, encaminha mensagens
// do popup, executa comandos do navegador (chrome.tabs) e atualiza o ícone.

import { IPC, TARGET_OFFSCREEN } from '../lib/ipc.js';
import { isSafeHttpUrl } from '../lib/protocol.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let lastState = 'disconnected';
let creating = null;

chrome.runtime.onInstalled.addListener(() => {
  updateBadge('disconnected');
});

// ---- Offscreen document -----------------------------------------------------

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WEB_RTC'],
    justification: 'Manter a conexão WebRTC com o celular do professor.',
  });
  await creating;
  creating = null;
}

function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: TARGET_OFFSCREEN, ...payload });
}

// ---- Ícone / status ---------------------------------------------------------

function updateBadge(state) {
  lastState = state;
  const connected = state === 'connected';
  chrome.action.setBadgeText({ text: connected ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#00897b' : '#9e9e9e' });
  chrome.action.setTitle({
    title: connected ? 'Controle de Aula — conectado' : 'Controle de Aula',
  });
}

// ---- Execução de comandos vindos do celular ---------------------------------

async function execOpenUrl({ url, newTab = true, focus = true }) {
  if (!isSafeHttpUrl(url)) return { ok: false, error: 'url_invalida' };
  try {
    if (newTab) {
      await chrome.tabs.create({ url, active: !!focus });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await chrome.tabs.update(tab.id, { url, active: !!focus });
      else await chrome.tabs.create({ url, active: !!focus });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---- Roteamento de mensagens ------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Mensagens destinadas ao offscreen não são tratadas aqui.
  if (msg?.target === TARGET_OFFSCREEN) return false;

  switch (msg?.cmd) {
    case IPC.STATE_CHANGED:
      updateBadge(msg.state);
      return false;

    case IPC.GET_STATE:
      sendResponse({ state: lastState });
      return false;

    case IPC.PAIR_START:
      (async () => {
        try {
          await ensureOffscreen();
          const res = await sendToOffscreen({ cmd: IPC.OFF_CREATE_OFFER });
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message ?? e) });
        }
      })();
      return true;

    case IPC.PAIR_ANSWER:
      (async () => {
        try {
          await ensureOffscreen();
          const res = await sendToOffscreen({
            cmd: IPC.OFF_ACCEPT_ANSWER,
            answer: msg.answer,
          });
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message ?? e) });
        }
      })();
      return true;

    case IPC.PAIR_RESET:
      (async () => {
        try {
          await ensureOffscreen();
          await sendToOffscreen({ cmd: IPC.OFF_CLOSE });
        } catch {}
        updateBadge('disconnected');
        sendResponse({ ok: true });
      })();
      return true;

    case IPC.EXEC_OPEN_URL:
      execOpenUrl(msg).then(sendResponse);
      return true;

    default:
      return false;
  }
});
