// Service worker (Manifest V3) — orquestra o pareamento e executa comandos.
//
// Não faz o long-poll (o SW hiberna): isso vive no offscreen document. O SW só:
// garante o offscreen, salva o pareamento, executa chrome.tabs e mantém o ícone.

import { IPC, TARGET_OFFSCREEN, STORAGE_KEY } from '../lib/ipc.js';
import { isSafeHttpUrl } from '../lib/protocol.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const KEEPALIVE_ALARM = 'keepalive';
let lastState = 'disconnected';
let creating = null;

chrome.runtime.onInstalled.addListener(() => {
  updateBadge('disconnected');
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  bootstrap();
});

// O alarme reanima o SW e garante que o offscreen (e o cliente) estão vivos.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE_ALARM) bootstrap();
});

// Se já houver pareamento salvo, sobe o offscreen e (re)inicia o cliente.
async function bootstrap() {
  const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!data?.ip) return;
  await ensureOffscreen();
  await sendToOffscreen({ cmd: IPC.OFF_START_CLIENT }).catch(() => {});
}

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
    reasons: ['WORKERS'],
    justification: 'Manter o cliente que busca comandos do celular na rede local.',
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
  if (msg?.target === TARGET_OFFSCREEN) return false; // é para o offscreen

  switch (msg?.cmd) {
    case IPC.STATE_CHANGED:
      updateBadge(msg.state);
      return false;

    case IPC.GET_STATE:
      sendResponse({ state: lastState });
      return false;

    case IPC.PAIR_SAVE:
      (async () => {
        try {
          await chrome.storage.local.set({
            [STORAGE_KEY]: {
              ip: msg.ip,
              port: msg.port,
              key: msg.key,
              name: msg.name ?? 'Celular',
            },
          });
          await ensureOffscreen();
          await sendToOffscreen({ cmd: IPC.OFF_START_CLIENT });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message ?? e) });
        }
      })();
      return true;

    case IPC.EXEC_OPEN_URL:
      execOpenUrl(msg).then(sendResponse);
      return true;

    default:
      return false;
  }
});
