// Service worker (MV3) — garante o offscreen (conexão Firebase), executa
// chrome.tabs e mantém o ícone. O cliente RTDB (SSE/auth) vive no offscreen.

import {
  IPC,
  TARGET_OFFSCREEN,
  STORAGE_KEYPAIR,
  STORAGE_BINDING,
  STORAGE_PAIRING,
  STORAGE_NAVLOG,
  STORAGE_RULES,
  STORAGE_CLASSVIEW,
} from '../lib/ipc.js';
import { isSafeHttpUrl, makeTabReport, MAX_REPORT_EVENTS } from '../lib/protocol.js';
import { hostCasa, acharRegra, MAX_RULES, MAX_RULE_PATTERN } from '../lib/rules.js';

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
    justification: 'Manter a conexão com o Firebase e receber comandos do professor.',
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
    title: connected
      ? 'Controle de Aula — conectado'
      : state === 'pairing'
        ? 'Controle de Aula — aguardando pareamento (QR no popup)'
        : 'Controle de Aula — conectando',
  });
}

// ---- Execução de comandos ---------------------------------------------------

async function execOpenUrl({ url, newTab = true, focus = true }) {
  if (!isSafeHttpUrl(url)) return { ok: false, error: 'url_invalida' };
  try {
    // Navegador fechado (pós "encerrar aula"): sem janela, chrome.tabs.create
    // falha — reabre o Chrome com uma janela nova já na URL. A extensão segue
    // viva sem janelas no ChromeOS (offscreen/SW não dependem delas).
    const janelas = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (janelas.length === 0) {
      await chrome.windows.create({ url, focused: !!focus, state: 'maximized' });
      return { ok: true };
    }
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

// Fecha abas por domínio (hostCasa) ou URL exata. Fechar 0 abas ainda é ok.
async function execFecharAbas({ domain, url }) {
  if (!domain && !url) return { ok: false, error: 'payload_invalido' };
  try {
    const todas = await chrome.tabs.query({});
    const alvo = todas.filter((t) => {
      if (!isSafeHttpUrl(t.url)) return false;
      if (url) return t.url === url;
      try {
        return hostCasa(new URL(t.url).hostname.toLowerCase(), domain);
      } catch {
        return false;
      }
    });
    if (alvo.length > 0) {
      // Fechar a última aba fecharia a janela — abre uma vazia antes.
      if (alvo.length === todas.length) await chrome.tabs.create({});
      await chrome.tabs.remove(alvo.map((t) => t.id));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Fecha TUDO (fim de aula/limpar abas). closeWindows=true derruba as janelas
// inteiras (aluno cai na área de trabalho; a extensão sobrevive — o offscreen
// não é janela). closeWindows=false fecha as abas deixando 1 vazia.
async function execFecharTudo({ closeWindows = false } = {}) {
  try {
    if (closeWindows) {
      const janelas = await chrome.windows.getAll();
      for (const j of janelas) {
        await chrome.windows.remove(j.id).catch(() => {});
      }
      return { ok: true };
    }
    const todas = await chrome.tabs.query({});
    if (todas.length > 0) {
      // Fechar a última aba fecharia a janela — abre uma vazia antes.
      await chrome.tabs.create({});
      await chrome.tabs.remove(todas.map((t) => t.id));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// show_message: com popup:true (app >= 0.15.2, ext >= 0.4.8) abre a página
// "Mensagem do professor" em aba nova; sem popup, notificação do sistema
// (avisos do telão). Som = padrão do sistema para prioridade alta.
async function execMostrarMensagem({ title, body, popup, de }) {
  const corpo = String(body ?? '').slice(0, 500);
  if (popup === true) {
    try {
      const json = unescape(
        encodeURIComponent(JSON.stringify({ de: String(de ?? '').slice(0, 60), corpo })),
      );
      const m = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`mensagem/mensagem.html?m=${m}`),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
  if (chrome.notifications === undefined) {
    return { ok: false, error: 'sem_notifications' };
  }
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: String(title ?? 'Controle de Aula').slice(0, 100),
      message: corpo,
      priority: 2,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Persiste (ou limpa, com snapshot null) a visão da turma — presença deste
// dado no storage é o que faz este PC se considerar o "PC do professor".
// `recebidoEm` usa o relógio LOCAL do Chromebook: a página turma mede
// staleness sem depender de skew com o relógio do celular.
async function execAtualizarClassView({ snapshot }) {
  try {
    if (!snapshot) {
      await chrome.storage.local.remove(STORAGE_CLASSVIEW);
    } else {
      await chrome.storage.local.set({
        [STORAGE_CLASSVIEW]: { ...snapshot, recebidoEm: Date.now() },
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Aplica o snapshot de regras de bloqueio e varre as abas já abertas.
async function execAplicarRegras({ rev, rules }) {
  const limpas = (Array.isArray(rules) ? rules : [])
    .filter((r) => typeof r?.pattern === 'string' && r.pattern.length > 0)
    .slice(0, MAX_RULES)
    .map((r) => ({ pattern: r.pattern.slice(0, MAX_RULE_PATTERN) }));
  regrasCache = limpas;
  await chrome.storage.local.set({
    [STORAGE_RULES]: { rev: typeof rev === 'number' ? rev : 0, rules: limpas },
  });
  try {
    const todas = await chrome.tabs.query({});
    for (const t of todas) {
      if (isSafeHttpUrl(t.url) && acharRegra(limpas, t.url)) bloquearAba(t.id, t.url);
    }
  } catch {
    // varredura é best-effort
  }
  return { ok: true };
}

// Troca o papel de parede do ChromeOS com o blob (base64) vindo do RTDB —
// o offscreen busca /wallpapers/{teacherUid} (dono do token) e passa por IPC.
async function execTrocarPapelDeParede({ jpegB64, hash }) {
  if (chrome.wallpaper === undefined) return { ok: false, error: 'so_chromeos' };
  if (typeof jpegB64 !== 'string' || !jpegB64) return { ok: false, error: 'blob_invalido' };
  try {
    const bin = atob(jpegB64);
    if (bin.length > 10 * 1024 * 1024) return { ok: false, error: 'imagem_grande' };
    const data = new ArrayBuffer(bin.length);
    const view = new Uint8Array(data);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    await new Promise((resolve, reject) => {
      chrome.wallpaper.setWallpaper(
        {
          data,
          layout: 'CENTER_CROPPED',
          filename: `professor-${String(hash ?? '').slice(0, 16)}.jpg`,
        },
        () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        },
      );
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---- Monitoramento de abas ----------------------------------------------------
// Listeners top-level (síncronos) para o MV3 acordar o SW no evento; só o log de
// navegação persiste em storage — o snapshot de abas é montado sob demanda.

// Serializa read-modify-write do navlog dentro de uma vida do SW.
let navlogChain = Promise.resolve();

function registrarEventoNav(tab) {
  if (!tab || !isSafeHttpUrl(tab.url)) return;
  const entrada = {
    url: tab.url,
    title: tab.title ?? '',
    ts: Date.now(),
    tabId: tab.id ?? null,
  };
  navlogChain = navlogChain
    .then(async () => {
      const log = (await chrome.storage.local.get(STORAGE_NAVLOG))[STORAGE_NAVLOG] ?? [];
      const ultimo = log[log.length - 1];
      if (ultimo && ultimo.url === entrada.url) {
        // Mesma página (re-ativação/título tardio): só atualiza título e hora.
        ultimo.title = entrada.title || ultimo.title;
        ultimo.ts = entrada.ts;
      } else {
        log.push(entrada);
      }
      await chrome.storage.local.set({
        [STORAGE_NAVLOG]: log.slice(-MAX_REPORT_EVENTS),
      });
    })
    .catch(() => {});
}

// Título chega depois da URL em muitos sites; preenche a entrada correspondente.
function backfillTitulo(tabId, title) {
  if (!title) return;
  navlogChain = navlogChain
    .then(async () => {
      const log = (await chrome.storage.local.get(STORAGE_NAVLOG))[STORAGE_NAVLOG] ?? [];
      const ultimo = log[log.length - 1];
      if (ultimo && ultimo.tabId === tabId && !ultimo.title) {
        ultimo.title = title;
        await chrome.storage.local.set({ [STORAGE_NAVLOG]: log });
      }
    })
    .catch(() => {});
}

// ---- Bloqueio de sites (regras do professor) ---------------------------------
// Snapshot vem do celular via set_rules e persiste em storage; cache em memória
// por vida do SW para o caminho quente do onUpdated.

let regrasCache = null; // [{pattern}] | null (ainda não carregado)

async function carregarRegras() {
  if (regrasCache !== null) return regrasCache;
  const salvo = (await chrome.storage.local.get(STORAGE_RULES))[STORAGE_RULES];
  regrasCache = Array.isArray(salvo?.rules) ? salvo.rules : [];
  return regrasCache;
}

function bloquearAba(tabId, url) {
  let dominio = '';
  try {
    dominio = new URL(url).hostname;
  } catch {
    // fica vazio
  }
  chrome.tabs
    .update(tabId, {
      url: chrome.runtime.getURL('blocked/blocked.html') + '?d=' + encodeURIComponent(dominio),
    })
    .catch(() => {});
}

async function aplicarBloqueio(tabId, url) {
  if (!isSafeHttpUrl(url)) return;
  const regras = await carregarRegras();
  if (regras.length && acharRegra(regras, url)) bloquearAba(tabId, url);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Na troca de URL o tab.title ainda é o da página anterior; grava vazio e
  // deixa o backfill preencher quando o título novo chegar.
  if (changeInfo.url) {
    registrarEventoNav({ ...tab, title: changeInfo.title ?? '' });
    // A tentativa fica no navlog ANTES do bloqueio — o professor vê a tentativa.
    aplicarBloqueio(tabId, changeInfo.url);
  } else if (changeInfo.title) {
    backfillTitulo(tabId, changeInfo.title);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => registrarEventoNav(tab))
    .catch(() => {});
});

async function montarRelatorio() {
  const [todas, [ativa]] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const tabs = todas.map((t) => ({
    url: t.url,
    title: t.title,
    active: ativa != null && t.id === ativa.id,
  }));
  const log = (await chrome.storage.local.get(STORAGE_NAVLOG))[STORAGE_NAVLOG] ?? [];
  const events = log.map(({ url, title, ts }) => ({ url, title, ts }));
  return makeTabReport(tabs, events);
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
      chrome.storage.local
        .get([STORAGE_KEYPAIR, STORAGE_BINDING])
        .then((o) =>
          sendResponse({
            state: lastState,
            teacher: lastTeacher,
            label: o[STORAGE_KEYPAIR]?.label ?? null,
            numero: o[STORAGE_BINDING]?.numero ?? null,
          }),
        )
        .catch(() =>
          sendResponse({ state: lastState, teacher: lastTeacher, label: null, numero: null }),
        );
      return true;

    case IPC.EXEC_OPEN_URL:
      execOpenUrl(msg).then(sendResponse);
      return true;

    case IPC.EXEC_CLOSE_TABS:
      execFecharAbas(msg).then(sendResponse);
      return true;

    case IPC.EXEC_CLOSE_ALL_TABS:
      execFecharTudo(msg).then(sendResponse);
      return true;

    case IPC.EXEC_SET_RULES:
      execAplicarRegras(msg).then(sendResponse);
      return true;

    case IPC.EXEC_WALLPAPER:
      execTrocarPapelDeParede(msg).then(sendResponse);
      return true;

    case IPC.EXEC_SHOW_MESSAGE:
      execMostrarMensagem(msg).then(sendResponse);
      return true;

    case IPC.EXEC_SET_CLASSVIEW:
      execAtualizarClassView(msg).then(sendResponse);
      return true;

    case IPC.TABS_REPORT:
      montarRelatorio()
        .then((report) => sendResponse({ report }))
        .catch(() => sendResponse({ report: null }));
      return true;

    case IPC.RECONNECT:
      (async () => {
        // Botão ↻ do popup: garante o offscreen e refaz a conexão do zero
        // (re-auth + streams novos) — recuperação manual pós-queda de rede.
        await ensureOffscreen();
        await tellOffscreen({ cmd: IPC.OFF_RESTART }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    case IPC.STORE_GET:
      chrome.storage.local
        .get(msg.key)
        .then((o) => sendResponse({ value: o[msg.key] ?? null }));
      return true;

    case IPC.STORE_SET:
      chrome.storage.local
        .set({ [msg.key]: msg.value })
        .then(() => sendResponse({ ok: true }));
      return true;

    case IPC.RESET_BIND:
      (async () => {
        // O offscreen desfaz o vínculo no RTDB (delete + rotação do token) e
        // limpa o storage via proxy.
        await ensureOffscreen();
        await tellOffscreen({ cmd: IPC.OFF_UNBIND }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    case IPC.GET_PAIRING:
      (async () => {
        // Dados do QR: identidade pública + token one-time (nada secreto além
        // do token, que só vale para quem vê a tela deste PC).
        const o = await chrome.storage.local.get([STORAGE_KEYPAIR, STORAGE_PAIRING]);
        const kp = o[STORAGE_KEYPAIR];
        const pair = o[STORAGE_PAIRING];
        if (!kp?.deviceId || !pair?.token) {
          sendResponse(null); // offscreen ainda não registrou
          return;
        }
        sendResponse({
          deviceId: kp.deviceId,
          pub: kp.pub,
          token: pair.token,
          label: kp.label ?? '',
        });
      })();
      return true;

    default:
      return false;
  }
});
