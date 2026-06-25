// Service worker (MV3) — garante o offscreen (descoberta/conexão), executa
// chrome.tabs e mantém o ícone. A descoberta/long-poll vivem no offscreen.

import {
  IPC,
  TARGET_OFFSCREEN,
  STORAGE_BINDING,
  STORAGE_HINT,
} from '../lib/ipc.js';
import { isSafeHttpUrl } from '../lib/protocol.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const KEEPALIVE_ALARM = 'keepalive';
let lastState = 'searching';
let lastTeacher = null;
let creating = null;

chrome.runtime.onInstalled.addListener(() => {
  updateBadge('searching');
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  ensureOffscreen();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE_ALARM) ensureOffscreen();
});

// ---- Offscreen --------------------------------------------------------------

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
    justification: 'Descobrir o celular do professor e buscar comandos na rede local.',
  });
  await creating;
  creating = null;
}

const tellOffscreen = (payload) =>
  chrome.runtime.sendMessage({ target: TARGET_OFFSCREEN, ...payload });

// ---- Ícone ------------------------------------------------------------------

function updateBadge(state) {
  lastState = state;
  const connected = state === 'connected';
  chrome.action.setBadgeText({ text: connected ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#00897b' : '#9e9e9e' });
  chrome.action.setTitle({
    title: connected ? 'Controle de Aula — conectado' : 'Controle de Aula — procurando',
  });
}

// ---- Execução de comandos ---------------------------------------------------

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

// ---- Roteamento -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === TARGET_OFFSCREEN) return false;

  switch (msg?.cmd) {
    case IPC.STATE_CHANGED:
      lastTeacher = msg.teacher ?? lastTeacher;
      updateBadge(msg.state);
      return false;

    case IPC.GET_STATE:
      sendResponse({ state: lastState, teacher: lastTeacher });
      return false;

    case IPC.EXEC_OPEN_URL:
      execOpenUrl(msg).then(sendResponse);
      return true;

    case IPC.RESET_BIND:
      (async () => {
        await chrome.storage.local.remove(STORAGE_BINDING);
        await ensureOffscreen();
        await tellOffscreen({ cmd: IPC.OFF_RESTART }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    case IPC.SET_MANUAL_IP:
      (async () => {
        const hint = (await chrome.storage.local.get(STORAGE_HINT))[STORAGE_HINT] || {};
        hint.manual = msg.ip || null;
        await chrome.storage.local.set({ [STORAGE_HINT]: hint });
        await ensureOffscreen();
        await tellOffscreen({ cmd: IPC.OFF_RESTART }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    default:
      return false;
  }
});
