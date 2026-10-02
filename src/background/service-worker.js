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
  STORAGE_FILTROS,
  STORAGE_CLASSVIEW,
  STORAGE_VERSION,
  STORAGE_TRAVA,
  STORAGE_PROVA,
  STORAGE_LIMITES,
  SESSAO_BLOQUEIOS,
  SESSAO_PEDIDOS,
  SESSAO_CHAT,
  SESSAO_CHAT_JANELA,
} from '../lib/ipc.js';
import {
  isSafeHttpUrl,
  makeTabReport,
  MAX_REPORT_EVENTS,
  MAX_TRAVA_TEXTO,
  MAX_PROVA_INICIO,
} from '../lib/protocol.js';
import { hostCasa, acharRegra, normalizarPadrao, MAX_RULES, MAX_RULE_PATTERN } from '../lib/rules.js';
import { limparFiltros, motivoFiltro, canalBloqueado } from '../lib/filtros.js';
import {
  UpType,
  novoId,
  idValido,
  siteValido,
  hostDeUrl,
  cortarCodePoints,
  MAX_CHAT_TEXTO,
  MAX_PEDIDO_MOTIVO,
} from '../lib/up.js';
import { verificar, registrar, TEXTO_LIMITE, L4_INTERVALO_MS } from '../lib/limites.js';
import { provaAtiva, motivoProva } from '../lib/prova.js';
// Efeito colateral: registra os listeners de limpeza de sessão (desloga todos
// os sites na virada de sessão; a conta @escolacelita re-injeta sozinha).
import './session-wipe.js';
import { Native } from './native.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const KEEPALIVE_ALARM = 'keepalive';
// Sem heartbeat saudável por mais que isto = offscreen travado -> OFF_RESTART.
// Heartbeat é a cada 20s e o alarme a cada 60s; 45s pega um travado no 1º tick
// sem falso-positivo de um offscreen só reconectando.
const HEARTBEAT_STALE_MS = 45000;
let lastState = 'searching';
let lastTeacher = null;
let lastMotivo = null; // código fixo do estado (ex.: 'vinculo_divergente'); nunca texto cru
let naoLidasBadge = 0; // mensagens do professor não lidas (badge da ação)
// Host desta extensão (chrome-extension://<id>/): páginas próprias nunca são
// bloqueadas pela prova.
const EXT_HOST = new URL(chrome.runtime.getURL('')).host;
let creating = null;
let lastHealthyAt = Date.now();

// A versão vive no SW (único contexto com getManifest garantido); grava no
// storage p/ o offscreen (registrar/meta.ext) ler via proxy.
const VERSAO = chrome.runtime.getManifest().version;
function gravarVersao() {
  chrome.storage.local.set({ [STORAGE_VERSION]: VERSAO }).catch(() => {});
}
gravarVersao(); // todo (re)start do SW — cobre wake sem onStartup (pós-efêmero)

// ---- Modo nativo (Celita OS) -----------------------------------------------
// No Celita a conexão vive num agente do sistema; aqui só executamos abas.
// Sem host nativo (Chromebook), tudo abaixo segue no modo offscreen.

const native = new Native({
  onExec: (cmd, payload) => executarNativo(cmd, payload),
  onRules: (p) => execAplicarRegras(p),
  onClassView: (snapshot) => execAtualizarClassView({ snapshot }),
  onState: (e) => {
    lastTeacher = e.teacher ?? null;
    lastMotivo = e.motivo ?? null;
    updateBadge(e.state);
  },
  montarRelatorio: () => montarRelatorio(),
});
native.conectar();

function executarNativo(cmd, payload) {
  switch (cmd) {
    case 'open_url':
      return execOpenUrl(payload);
    case 'close_tabs':
      return execFecharAbas(payload);
    case 'close_all_tabs':
      return execFecharTudo(payload);
    case 'show_message':
      return execMostrarMensagem(payload);
    case 'unblock_result':
      // O agente já esperou as próprias regras/prova; aqui é só recarregar a aba.
      return execResultadoPedido(payload);
    default:
      return Promise.resolve({ ok: false, error: 'tipo_desconhecido' });
  }
}

/// Offscreen só quando não há agente nativo.
async function garantirConexao() {
  native.conectar();
  if (native.ativo) return false;
  return ensureOffscreen();
}

chrome.runtime.onInstalled.addListener(() => {
  gravarVersao();
  updateBadge('searching');
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  garantirConexao();
});

chrome.runtime.onStartup.addListener(() => {
  gravarVersao();
  lastHealthyAt = Date.now();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  garantirConexao();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  const criado = await garantirConexao();
  if (native.ativo) {
    native.enviarRelatorio(); // batida de 1 min: o agente reenvia a cada 60 s
    return;
  }
  // Offscreen já existia mas há muito não reporta stream saudável => TRAVADO
  // (congelado no suspend ou EventSource zumbi). ensureOffscreen não reinicia um
  // offscreen vivo-porém-travado — só o OFF_RESTART (incondicional) destrava.
  // Este alarme é o ÚNICO ator de recuperação que sobrevive a um offscreen
  // travado (a auto-reconexão e o watchdog vivem dentro dele).
  // 'pairing' é espera legítima pelo QR (heartbeat fica unhealthy de propósito)
  // — NÃO reiniciar, senão regenera o QR a cada minuto.
  if (
    !criado &&
    lastState !== 'pairing' &&
    Date.now() - lastHealthyAt > HEARTBEAT_STALE_MS
  ) {
    lastHealthyAt = Date.now(); // não re-disparar antes do reinício assentar
    console.log('[CdA] SW: offscreen travado — forçando OFF_RESTART');
    tellOffscreen({ cmd: IPC.OFF_RESTART }).catch(() => {});
  }
});

// ---- Offscreen --------------------------------------------------------------

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return false; // já existe
  if (creating) {
    await creating;
    return true;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // WORKERS: conexão Firebase (SSE/timers). USER_MEDIA: capturar 1 foto da
    // webcam via getUserMedia (comando capture_camera; exige policy do admin).
    reasons: ['WORKERS', 'USER_MEDIA'],
    justification:
      'Manter a conexão com o Firebase, receber comandos e tirar foto de presença pela câmera.',
  });
  await creating;
  creating = null;
  return true; // criado agora
}

const tellOffscreen = (payload) =>
  chrome.runtime.sendMessage({ target: TARGET_OFFSCREEN, ...payload });

// ---- Ícone ------------------------------------------------------------------

function updateBadge(state) {
  lastState = state;
  const connected = state === 'connected';
  // Mensagem do professor não lida tem prioridade sobre o "conectado".
  const naoLidas = Math.min(naoLidasBadge, 99);
  chrome.action.setBadgeText({ text: naoLidas > 0 ? String(naoLidas) : connected ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({
    color: naoLidas > 0 ? '#2962ff' : connected ? '#00897b' : '#9e9e9e',
  });
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
    console.warn('[CdA] open_url falhou:', e?.message ?? e);
    return { ok: false, error: 'aba_falhou' };
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
    console.warn('[CdA] close_tabs falhou:', e?.message ?? e);
    return { ok: false, error: 'fechar_falhou' };
  }
}

// Fecha TUDO (fim de aula/limpar abas). closeWindows=true derruba as janelas
// inteiras (aluno cai na área de trabalho; a extensão sobrevive — o offscreen
// não é janela). closeWindows=false fecha as abas deixando 1 vazia.
// fimDeAula=true (app >= 0.20): antes, some a conversa, os pedidos e os
// limites — a conta "aluno" é compartilhada com a próxima turma.
async function execFecharTudo({ closeWindows = false, fimDeAula = false } = {}) {
  if (fimDeAula === true) await limparTurma({ desligarEstado: !native.ativo });
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
      await chrome.tabs.remove(todas.map((t) => t.id)).catch(async () => {
        // Uma aba sumiu entre a consulta e o remove (a janela de chat que o
        // fim de aula acabou de fechar, ou o aluno): tabs.remove para no
        // primeiro id inválido — fecha o resto uma a uma.
        for (const t of todas) await chrome.tabs.remove(t.id).catch(() => {});
      });
    }
    return { ok: true };
  } catch (e) {
    console.warn('[CdA] close_all_tabs falhou:', e?.message ?? e);
    return { ok: false, error: 'fechar_falhou' };
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
      console.warn('[CdA] show_message falhou:', e?.message ?? e);
      return { ok: false, error: 'aviso_falhou' };
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
    console.warn('[CdA] notificação falhou:', e?.message ?? e);
    return { ok: false, error: 'aviso_falhou' };
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
    console.warn('[CdA] set_class_view falhou:', e?.message ?? e);
    return { ok: false, error: 'classview_falhou' };
  }
}

// Aplica o snapshot de regras de bloqueio e varre as abas já abertas.
// `filtros` ausente (remetente antigo) mantém os que já valiam.
// `prova` (só no Celita, vinda do agente pela ponte: {on, allow, inicio}):
// ausente (agente antigo) deixa a prova como está.
async function execAplicarRegras({ rev, rules, filtros, prova }) {
  const limpas = (Array.isArray(rules) ? rules : [])
    .filter((r) => typeof r?.pattern === 'string' && r.pattern.length > 0)
    .slice(0, MAX_RULES)
    .map((r) => ({ pattern: r.pattern.slice(0, MAX_RULE_PATTERN) }));
  regrasCache = limpas;
  const gravar = { [STORAGE_RULES]: { rev: typeof rev === 'number' ? rev : 0, rules: limpas } };
  if (filtros !== undefined) {
    filtrosCache = limparFiltros(filtros);
    gravar[STORAGE_FILTROS] = filtrosCache;
  }
  await chrome.storage.local.set(gravar);
  if (prova && typeof prova === 'object') await gravarProvaDaPonte(rev, prova);
  await varrerAbas();
  return { ok: true };
}

// Reavalia as abas abertas (regras novas, prova ligada).
async function varrerAbas() {
  try {
    const [regras, efetivos, prova] = await Promise.all([carregarRegras(), carregarFiltros(), carregarProva()]);
    const todas = await chrome.tabs.query({});
    for (const t of todas) {
      const motivo = motivoBloqueio(regras, efetivos, t.url, prova);
      if (motivo) bloquearAba(t.id, t.url, motivo);
    }
  } catch {
    // varredura é best-effort
  }
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
    console.warn('[CdA] papel de parede falhou:', e?.message ?? e);
    return { ok: false, error: 'papel_falhou' };
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
        delete ultimo.bloqueio; // nova tentativa é marcada de novo, se ainda bloquear
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
let filtrosCache = null; // filtros efetivos | null (ainda não carregado)

async function carregarRegras() {
  if (regrasCache !== null) return regrasCache;
  const salvo = (await chrome.storage.local.get(STORAGE_RULES))[STORAGE_RULES];
  regrasCache = Array.isArray(salvo?.rules) ? salvo.rules : [];
  return regrasCache;
}

// Nunca recebeu filtros = ninguém configurou ainda: vale o padrão (tudo ligado).
async function carregarFiltros() {
  if (filtrosCache !== null) return filtrosCache;
  const salvo = (await chrome.storage.local.get(STORAGE_FILTROS))[STORAGE_FILTROS];
  filtrosCache = limparFiltros(salvo);
  if (!salvo) await chrome.storage.local.set({ [STORAGE_FILTROS]: filtrosCache }).catch(() => {});
  return filtrosCache;
}

/// 'regra' (site bloqueado pelo professor), 'prova', um motivo de filtro, ou
/// null. Com a prova ligada, ela decide sozinha (src/lib/prova.js): as regras
/// de bloqueio não valem em prova, só os filtros.
function motivoBloqueio(regras, filtros, url, prova = null) {
  const emProva = motivoProva(provaAtiva(prova, Date.now()) ? prova : null, filtros, url, EXT_HOST);
  if (emProva !== undefined) return emProva;
  if (!isSafeHttpUrl(url)) return null;
  if (regras.length && acharRegra(regras, url)) return 'regra';
  return motivoFiltro(filtros, url);
}

// Marca a tentativa no navlog: o agente e o celular sabem que foi bloqueada
// mesmo quando o motivo é um filtro, que eles não reavaliam.
function marcarBloqueio(url, motivo) {
  navlogChain = navlogChain
    .then(async () => {
      const log = (await chrome.storage.local.get(STORAGE_NAVLOG))[STORAGE_NAVLOG] ?? [];
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].url === url) {
          log[i].bloqueio = motivo;
          await chrome.storage.local.set({ [STORAGE_NAVLOG]: log });
          return;
        }
      }
    })
    .catch(() => {});
}

function bloquearAba(tabId, url, motivo = 'regra') {
  let dominio = '';
  try {
    dominio = new URL(url).hostname;
  } catch {
    // fica vazio
  }
  marcarBloqueio(url, motivo);
  // O pedido de liberação é montado deste registro (URL real), nunca dos
  // parâmetros da página — grava ANTES de redirecionar.
  registrarBloqueio(tabId, url, motivo)
    .catch(() => {})
    .then(() =>
      chrome.tabs.update(tabId, {
        url:
          chrome.runtime.getURL('blocked/blocked.html') +
          '?d=' + encodeURIComponent(dominio) +
          '&m=' + encodeURIComponent(motivo),
      }),
    )
    .catch(() => {});
}

async function aplicarBloqueio(tabId, url) {
  const [regras, filtros, prova] = await Promise.all([carregarRegras(), carregarFiltros(), carregarProva()]);
  const motivo = motivoBloqueio(regras, filtros, url, prova);
  if (motivo) bloquearAba(tabId, url, motivo);
}

// O dono do vídeo só aparece na página: o content script do YouTube avisa e o
// bloqueio é decidido aqui, com os filtros daqui.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.t !== 'cda-canal' || sender.id !== chrome.runtime.id || !sender.tab?.id) return false;
  carregarFiltros()
    .then((filtros) => {
      if (canalBloqueado(filtros, msg)) bloquearAba(sender.tab.id, sender.tab.url, 'canal');
    })
    .catch(() => {});
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title) native.agendarRelatorio();
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

chrome.tabs.onRemoved.addListener((tabId) => {
  native.agendarRelatorio();
  esquecerBloqueio(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  native.agendarRelatorio();
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
  const events = log.map(({ url, title, ts, bloqueio }) => ({ url, title, ts, bloqueio }));
  return makeTabReport(tabs, events);
}

// ---- Pedido e chat ------------------------------------------------------------
// Recursos de turma (ext >= 0.7.0). Fica ANTES do roteamento de propósito: o
// prepare-extension.py do Celita corta de "// ---- Roteamento" até o fim, e a
// página de bloqueio (pedir liberação) e o modo prova valem nos dois modos.
// No Celita, a janela de chat e a trava são do sistema (GTK, agente); aqui elas
// só agem no ChromeOS — as funções existem nos dois modos, mas só o roteamento
// do ChromeOS as chama.

const PEDIDO_SEM_RESPOSTA_MS = 10 * 60 * 1000; // "O professor ainda não respondeu"
const RECARGA_ESPERA_MS = 10000; // aprovado: espera as regras novas antes de recarregar
const MAX_BLOQUEIOS = 50;
const MAX_PEDIDOS = 50;
const MAX_CHAT_ITENS = 100;
const ALARME_TRAVA = 'trava'; // reafirma a trava a cada 30 s
const ALARME_TRAVA_FIM = 'trava-fim'; // destrava sozinho no prazo
const TEXTO_FALHA_ENVIO = 'Não foi possível enviar agora. Tente de novo.';

// Toda leitura-modificação-escrita de storage desta seção passa por uma fila
// única: o SW recebe eventos em rajada (aba bloqueada + mensagem + página).
let filaTurma = Promise.resolve();
function naFila(fn) {
  const p = filaTurma.then(fn);
  filaTurma = p.catch(() => {});
  return p;
}

// chrome.storage.session: some ao fechar o navegador e sobrevive à morte do
// SW e do offscreen. Ausente (ambiente de teste da ponte) = sem registro.
const areaSessao = () => chrome.storage.session ?? null;

async function lerSessao(chave, padrao) {
  const area = areaSessao();
  if (!area) return padrao;
  try {
    return (await area.get(chave))[chave] ?? padrao;
  } catch {
    return padrao;
  }
}

/// Lê, muda e grava uma chave da sessão dentro da fila. `fn` devolve o valor
/// novo (undefined = não grava). Nunca chamar mudarSessao de dentro de `fn`.
function mudarSessao(chave, padrao, fn) {
  return naFila(async () => {
    const area = areaSessao();
    if (!area) return undefined;
    const atual = await lerSessao(chave, padrao);
    const novo = fn(atual);
    if (novo !== undefined) await area.set({ [chave]: novo });
    return novo;
  });
}

const horaMin = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// ---- Registro do bloqueio (o pedido nasce daqui) ----

function registrarBloqueio(tabId, url, motivo) {
  const host = hostDeUrl(url);
  return mudarSessao(SESSAO_BLOQUEIOS, {}, (b) => {
    b[tabId] = { url: String(url ?? '').slice(0, 2048), host, motivo, ts: Date.now() };
    const ids = Object.keys(b);
    if (ids.length > MAX_BLOQUEIOS) {
      ids.sort((x, y) => (b[x]?.ts ?? 0) - (b[y]?.ts ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_BLOQUEIOS)) delete b[id];
    }
    return b;
  }).then(() =>
    // Bloqueado de novo depois de "aprovado" (as regras mudaram outra vez, ou
    // as novas não chegaram a tempo): a liberação não vale mais. Sem isto a
    // página ficaria para sempre em "Liberado! Abrindo o site…", sem botão.
    mudarSessao(SESSAO_PEDIDOS, {}, (p) => {
      if (p[host]?.estado !== 'aprovado') return undefined;
      delete p[host];
      return p;
    }),
  );
}

function esquecerBloqueio(tabId) {
  return mudarSessao(SESSAO_BLOQUEIOS, {}, (b) => {
    if (!(tabId in b)) return undefined;
    delete b[tabId];
    return b;
  }).catch(() => {});
}

// ---- Saída para o professor (único ponto: o SW decide o que sobe) ----

/// ChromeOS: o offscreen sela e grava em up/. Celita: o agente, pela ponte.
async function enviarUp(tipo, payload, mid) {
  try {
    if (!native.ativo) await garantirConexao();
    if (native.ativo) return await native.pedirUp(tipo, payload, mid);
    const r = await chrome.runtime.sendMessage({ target: TARGET_OFFSCREEN, cmd: IPC.UP_SEND, tipo, payload, mid });
    return r ?? { ok: false, erro: 'sem_resposta' };
  } catch {
    return { ok: false, erro: 'sem_conexao' };
  }
}

/// Rate-limit persistido (src/lib/limites.js): confere e já registra.
/// null = pode; senão a regra ('L1'..'L4').
function consumirLimite(tipo, extra = {}) {
  return naFila(async () => {
    const agora = Date.now();
    const atual = (await chrome.storage.local.get(STORAGE_LIMITES))[STORAGE_LIMITES];
    const regra = verificar(atual, tipo, { agora, ...extra });
    if (regra) return regra;
    await chrome.storage.local.set({ [STORAGE_LIMITES]: registrar(atual, tipo, { agora, ...extra }) });
    return null;
  });
}

/// Pedido que não saiu (rede) não pode prender o aluno por 60 s.
function devolverLimitePedido(site) {
  return naFila(async () => {
    const atual = (await chrome.storage.local.get(STORAGE_LIMITES))[STORAGE_LIMITES];
    if (atual?.pedidos?.[site] === undefined) return;
    delete atual.pedidos[site];
    await chrome.storage.local.set({ [STORAGE_LIMITES]: atual });
  }).catch(() => {});
}

/// O agente do Celita pode recusar pelo limite dele; o resto é "tente de novo".
const erroEhLimite = (erro) => /limite|^L[1-4]$/i.test(String(erro ?? ''));

// ---- Pedir liberação (página de bloqueio) ----

async function estadoDoPedido(tabId) {
  const reg = (await lerSessao(SESSAO_BLOQUEIOS, {}))[tabId] ?? null;
  const pedidos = await lerSessao(SESSAO_PEDIDOS, {});
  return { ok: true, site: reg?.host ?? null, pedido: reg ? (pedidos[reg.host] ?? null) : null };
}

async function pedirLiberacao(tabId, motivo) {
  const reg = (await lerSessao(SESSAO_BLOQUEIOS, {}))[tabId];
  // Página aberta à mão (sem bloqueio registrado), filtro da escola ou
  // endereço sem site de verdade: não há o que pedir.
  if (!reg || (reg.motivo !== 'regra' && reg.motivo !== 'prova') || !siteValido(reg.host)) {
    return { ok: false, erro: 'sem_registro' };
  }
  const site = reg.host;
  const agora = Date.now();
  const pedidos = await lerSessao(SESSAO_PEDIDOS, {});
  const pendentes = Object.values(pedidos).filter(
    (p) => p?.estado === 'enviado' && agora - p.ts >= 0 && agora - p.ts < PEDIDO_SEM_RESPOSTA_MS,
  ).length;
  if (await consumirLimite(UpType.UNBLOCK_REQUEST, { site, pendentes })) {
    return { ok: false, erro: 'limite', aviso: TEXTO_LIMITE.L3 };
  }
  const mid = novoId();
  const r = await enviarUp(
    UpType.UNBLOCK_REQUEST,
    {
      site,
      url: reg.url,
      motivo: cortarCodePoints(String(motivo ?? '').trim(), MAX_PEDIDO_MOTIVO),
      bloqueio: reg.motivo === 'prova' ? 'prova' : 'regra',
    },
    mid,
  );
  if (!r?.ok) {
    if (erroEhLimite(r?.erro)) return { ok: false, erro: 'limite', aviso: TEXTO_LIMITE.L3 };
    await devolverLimitePedido(site);
    return { ok: false, erro: 'falhou' };
  }
  await mudarSessao(SESSAO_PEDIDOS, {}, (p) => {
    p[site] = { mid, ts: Date.now(), estado: 'enviado' };
    const sites = Object.keys(p);
    if (sites.length > MAX_PEDIDOS) {
      sites.sort((x, y) => (p[x]?.ts ?? 0) - (p[y]?.ts ?? 0));
      for (const s of sites.slice(0, sites.length - MAX_PEDIDOS)) delete p[s];
    }
    return p;
  });
  return { ok: true };
}

// A página de bloqueio fala só com o SW (nunca com o offscreen), e o pedido é
// montado pelo registro da PRÓPRIA aba — `?d=`/`?m=` servem só para exibir.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.t !== 'cda-pedido') return false;
  const pagina = chrome.runtime.getURL('blocked/blocked.html');
  if (sender.id !== chrome.runtime.id || sender.tab?.id == null || !String(sender.url ?? '').startsWith(pagina)) {
    sendResponse({ ok: false, erro: 'origem_invalida' });
    return false;
  }
  const tarefa = msg.acao === 'enviar' ? pedirLiberacao(sender.tab.id, msg.motivo) : estadoDoPedido(sender.tab.id);
  tarefa.then(sendResponse, (e) => {
    console.warn('[CdA] pedido de liberação falhou:', e?.message ?? e);
    sendResponse({ ok: false, erro: 'falhou' });
  });
  return true;
});

// ---- Resposta do professor (unblock_result) ----

/// Espera o estado novo valer (rev das regras ou da prova), por até `ms`.
async function esperarRevs(rulesRev, examRev, ms) {
  const alvoRegras = Number(rulesRev) || 0;
  const alvoProva = Number(examRev) || 0;
  if (!alvoRegras && !alvoProva) return;
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const regras = (await chrome.storage.local.get(STORAGE_RULES))[STORAGE_RULES];
    const prova = await carregarProva();
    if ((!alvoRegras || (regras?.rev ?? 0) >= alvoRegras) && (!alvoProva || (prova?.rev ?? 0) >= alvoProva)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/// Aprovado: toda aba ainda parada na página de bloqueio daquele site volta
/// para o endereço que tentava abrir.
async function liberarAbas(site, rulesRev, examRev) {
  await esperarRevs(rulesRev, examRev, RECARGA_ESPERA_MS);
  const bloqueios = await lerSessao(SESSAO_BLOQUEIOS, {});
  const pagina = chrome.runtime.getURL('blocked/blocked.html');
  const abas = await chrome.tabs.query({}).catch(() => []);
  for (const [id, reg] of Object.entries(bloqueios)) {
    if (reg?.host !== site || !isSafeHttpUrl(reg.url)) continue;
    const aba = abas.find((a) => a.id === Number(id));
    if (!aba || !String(aba.url || aba.pendingUrl || '').startsWith(pagina)) continue; // navegou/fechou
    await esquecerBloqueio(aba.id);
    await chrome.tabs.update(aba.id, { url: reg.url }).catch(() => {});
  }
}

async function execResultadoPedido({ site, approved, motivo, rulesRev, examRev } = {}) {
  if (!siteValido(site) || typeof approved !== 'boolean') return { ok: false, error: 'payload_invalido' };
  const motivoRecusa = cortarCodePoints(String(motivo ?? '').trim(), MAX_PEDIDO_MOTIVO);
  await mudarSessao(SESSAO_PEDIDOS, {}, (p) => {
    const antes = p[site] ?? {};
    p[site] = approved
      ? { mid: antes.mid ?? null, ts: antes.ts ?? Date.now(), estado: 'aprovado' }
      : { mid: antes.mid ?? null, ts: antes.ts ?? Date.now(), estado: 'recusado', motivoRecusa };
    return p;
  });
  if (!native.ativo) {
    // No Celita o agente põe o aviso na janela de chat dele.
    const texto = approved
      ? `O professor liberou ${site}.`
      : `Pedido para abrir ${site} não foi liberado.` + (motivoRecusa ? ` Motivo: ${motivoRecusa}` : '');
    await chatAnexar({ id: novoId(), autor: 'sistema', texto, ts: Date.now() }, { naoLida: !approved });
    if (!approved) abrirChat({ foco: false }).catch(() => {});
  }
  // O ack sai já; recarregar espera as regras novas valerem (≤ 10 s).
  if (approved) liberarAbas(site, rulesRev, examRev).catch(() => {});
  return { ok: true };
}

// ---- Fim de aula / desvincular ----

/// Some a conversa, os pedidos e os limites (a conta "aluno" é compartilhada
/// com a próxima turma). `desligarEstado` (ChromeOS): desliga também a trava e
/// a prova locais — redundância com o on:false que o professor manda.
async function limparTurma({ desligarEstado = false } = {}) {
  const janelaChat = await lerSessao(SESSAO_CHAT_JANELA, null);
  await naFila(async () => {
    await areaSessao()?.remove([SESSAO_CHAT, SESSAO_PEDIDOS, SESSAO_CHAT_JANELA]);
    await chrome.storage.local.remove(STORAGE_LIMITES);
  }).catch(() => {});
  // Esperar: o close_all_tabs logo depois não pode tentar fechar a aba dela
  // já fechando (tabs.remove para no primeiro id inválido e sobra aba aberta).
  if (janelaChat != null) await chrome.windows.remove(janelaChat).catch(() => {});
  naoLidasBadge = 0;
  atualizarBadgeChat();
  if (!desligarEstado) return;
  await naFila(async () => {
    // `encerrada` impede que a reentrega do MESMO envelope ligado religue.
    const t = await lerTrava();
    if (t?.on) await gravarTrava({ ...t, on: false, encerrada: true });
    const p = await carregarProva();
    if (p?.on) await gravarProva({ ...p, on: false, encerrada: true });
  }).catch(() => {});
  await garantirTrava();
}

// ---- Modo prova (cópia local) ----

let provaCache; // undefined = ainda não lida neste SW

async function carregarProva() {
  if (provaCache !== undefined) return provaCache;
  provaCache = (await chrome.storage.local.get(STORAGE_PROVA))[STORAGE_PROVA] ?? null;
  return provaCache;
}

async function gravarProva(p) {
  provaCache = p;
  await chrome.storage.local.set({ [STORAGE_PROVA]: p });
}

const limparAllowLocal = (allow) =>
  (Array.isArray(allow) ? allow : [])
    .map((r) => (typeof r?.pattern === 'string' ? normalizarPadrao(r.pattern) : ''))
    .filter(Boolean)
    .slice(0, MAX_RULES)
    .map((pattern) => ({ pattern }));

const inicioValido = (inicio) =>
  typeof inicio === 'string' && inicio.length <= MAX_PROVA_INICIO && isSafeHttpUrl(inicio) ? inicio : null;

/// ChromeOS: set_exam já limpo pelo CloudClient, com o prazo local.
async function execSetExam({ rev, envTs, on, allow, inicio, prazo } = {}) {
  if (typeof rev !== 'number' || typeof on !== 'boolean') return { ok: false, error: 'payload_invalido' };
  await naFila(async () => {
    const atual = await carregarProva();
    const mesmo = atual && atual.rev === rev && atual.envTs === envTs;
    if (mesmo && atual.encerrada) return; // o fim de aula já desligou este envelope
    await gravarProva({
      rev,
      envTs,
      on,
      allow: limparAllowLocal(allow),
      inicio: inicioValido(inicio),
      // Reentrega do mesmo envelope (reconexão) não estende o prazo.
      prazo: mesmo && typeof atual.prazo === 'number' ? atual.prazo : Number(prazo) || 0,
    });
  });
  await varrerAbas();
  return { ok: true };
}

/// Celita: o agente repassa {on, allow, inicio} junto das regras e desliga a
/// prova quando o prazo dele vence (aqui não há prazo).
function gravarProvaDaPonte(rev, prova) {
  return naFila(() =>
    gravarProva({
      rev: typeof rev === 'number' ? rev : 0,
      on: prova.on === true,
      allow: limparAllowLocal(prova.allow),
      inicio: inicioValido(prova.inicio),
    }),
  );
}

// ---- "Olhos em mim" no ChromeOS (cópia local + janela em tela cheia) ----
// Limites declarados: atalhos do ChromeOS, apps Android e janelas fora do
// Chrome continuam acessíveis por instantes; abas que já estavam abertas não
// são fechadas (só as novas), para não perder trabalho do aluno.

let travaCache; // undefined = ainda não lida neste SW

async function lerTrava() {
  if (travaCache !== undefined) return travaCache;
  travaCache = (await chrome.storage.local.get(STORAGE_TRAVA))[STORAGE_TRAVA] ?? null;
  return travaCache;
}

async function gravarTrava(t) {
  travaCache = t;
  await chrome.storage.local.set({ [STORAGE_TRAVA]: t });
}

const travaAtiva = (t, agora = Date.now()) =>
  !!t && t.on === true && typeof t.prazo === 'number' && agora < t.prazo;

const PAGINA_TRAVA = () => chrome.runtime.getURL('lock/lock.html');

/// ChromeOS: set_lock já limpo pelo CloudClient, com o prazo local. Mesmo
/// `rev` reaplica (refaz a janela); envelope nulo nunca chega aqui.
async function execSetLock({ rev, envTs, on, texto, mute, prazo } = {}) {
  if (typeof rev !== 'number' || typeof on !== 'boolean') return { ok: false, error: 'payload_invalido' };
  await naFila(async () => {
    const atual = await lerTrava();
    const mesmo = atual && atual.rev === rev && atual.envTs === envTs;
    if (mesmo && atual.encerrada) return;
    await gravarTrava({
      rev,
      envTs,
      on,
      texto: cortarCodePoints(String(texto ?? ''), MAX_TRAVA_TEXTO) || 'Olhos no professor',
      mute: mute === true,
      prazo: mesmo && typeof atual.prazo === 'number' ? atual.prazo : Number(prazo) || 0,
      mutadas: atual?.mutadas ?? [],
      janela: atual?.janela ?? null,
    });
  });
  await garantirTrava();
  return { ok: true };
}

async function desmutar(ids) {
  for (const id of ids ?? []) await chrome.tabs.update(id, { muted: false }).catch(() => {});
}

/// Reafirma a trava (janela, foco, som) ou desfaz tudo se acabou.
function garantirTrava() {
  return naFila(garantirTravaAgora).catch((e) => console.warn('[CdA] trava:', e?.message ?? e));
}

async function garantirTravaAgora() {
  const t = await lerTrava();
  if (!t) return;
  if (travaAtiva(t)) {
    let janela = t.janela != null ? await chrome.windows.get(t.janela).catch(() => null) : null;
    if (!janela) {
      janela = await chrome.windows
        .create({ url: PAGINA_TRAVA(), type: 'popup', state: 'fullscreen', focused: true })
        .catch(() => null);
      // A janela de chat aberta sai da frente (volta ao destravar, se houver não lidas).
      const chatId = await lerSessao(SESSAO_CHAT_JANELA, null);
      if (chatId != null) await chrome.windows.update(chatId, { state: 'minimized' }).catch(() => {});
    } else {
      if (janela.state !== 'fullscreen') {
        await chrome.windows.update(janela.id, { state: 'fullscreen' }).catch(() => {});
      }
      if (!janela.focused) await chrome.windows.update(janela.id, { focused: true }).catch(() => {});
    }
    let mutadas = Array.isArray(t.mutadas) ? [...t.mutadas] : [];
    if (t.mute) {
      for (const aba of await chrome.tabs.query({}).catch(() => [])) {
        if (aba.windowId === janela?.id || aba.mutedInfo?.muted) continue;
        await chrome.tabs.update(aba.id, { muted: true }).catch(() => {});
        if (!mutadas.includes(aba.id)) mutadas.push(aba.id);
      }
    } else if (mutadas.length) {
      await desmutar(mutadas);
      mutadas = [];
    }
    await gravarTrava({ ...t, janela: janela?.id ?? null, mutadas });
    chrome.alarms.create(ALARME_TRAVA, { periodInMinutes: 0.5 });
    chrome.alarms.create(ALARME_TRAVA_FIM, { when: t.prazo + 250 });
    return;
  }
  // Destravou (on:false, prazo vencido, fim de aula, desvincular).
  const tinhaJanela = t.janela != null;
  if (!tinhaJanela && !t.mutadas?.length) return;
  if (tinhaJanela) await chrome.windows.remove(t.janela).catch(() => {});
  await desmutar(t.mutadas);
  await gravarTrava({ ...t, janela: null, mutadas: [] });
  chrome.alarms.clear(ALARME_TRAVA);
  chrome.alarms.clear(ALARME_TRAVA_FIM);
  // Mensagem que chegou durante a trava: a janela de chat abre agora.
  const chat = await lerSessao(SESSAO_CHAT, null);
  if (chat?.naoLidas > 0) abrirChat({ foco: false }).catch(() => {});
}

// Gatilhos da trava. A ponte do Celita não usa a trava da extensão (o overlay
// é do sistema) — os `?.` deixam o worker subir em ambientes sem essas APIs.
chrome.windows.onRemoved?.addListener((id) => {
  lerTrava().then((t) => {
    if (t?.janela === id) garantirTrava(); // recria se ainda vale
  });
  lerSessao(SESSAO_CHAT_JANELA, null).then((chatId) => {
    if (chatId === id) areaSessao()?.remove(SESSAO_CHAT_JANELA);
  });
});
chrome.windows.onFocusChanged?.addListener((id) => {
  lerTrava().then((t) => {
    if (travaAtiva(t) && id !== t.janela) garantirTrava();
  });
});
chrome.windows.onBoundsChanged?.addListener((janela) => {
  lerTrava().then((t) => {
    if (travaAtiva(t) && janela.id === t.janela && janela.state !== 'fullscreen') garantirTrava();
  });
});
chrome.tabs.onCreated?.addListener((aba) => {
  lerTrava().then((t) => {
    if (!travaAtiva(t) || aba.windowId === t.janela) return;
    if (String(aba.pendingUrl || aba.url || '').startsWith(PAGINA_TRAVA())) return;
    chrome.tabs.remove(aba.id).catch(() => {}); // aba NOVA durante a trava
  });
});
chrome.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === ALARME_TRAVA || alarme.name === ALARME_TRAVA_FIM) garantirTrava();
});

// ---- Janela de chat (ChromeOS) ----

function chatVazio() {
  return { de: null, itens: [], naoLidas: 0, maoAte: 0 };
}

function mudarChat(fn) {
  return mudarSessao(SESSAO_CHAT, chatVazio(), fn);
}

/// Anexa um item ao histórico (≤ 100). `naoLida` conta no badge e no título.
async function chatAnexar(item, { naoLida = false, de = null } = {}) {
  const c = await mudarChat((c) => {
    if (item.id && c.itens.some((i) => i.id === item.id && i.autor === item.autor)) return undefined;
    c.itens.push(item);
    if (c.itens.length > MAX_CHAT_ITENS) c.itens.splice(0, c.itens.length - MAX_CHAT_ITENS);
    if (de) c.de = de;
    if (naoLida) c.naoLidas = (c.naoLidas ?? 0) + 1;
    return c;
  });
  if (c && naoLida) atualizarBadgeChat(c.naoLidas);
  return c !== undefined;
}

function atualizarBadgeChat(n) {
  if (typeof n === 'number') naoLidasBadge = n;
  try {
    updateBadge(lastState);
  } catch {
    // sem chrome.action (ponte do Celita)
  }
}

async function chatFocado() {
  const id = await lerSessao(SESSAO_CHAT_JANELA, null);
  if (id == null) return false;
  const w = await chrome.windows.get(id).catch(() => null);
  return !!w?.focused && w.state !== 'minimized';
}

let abrindoChat = null;

/// Abre (ou levanta) a janela de chat no canto inferior direito, estilo
/// Messenger. Nunca duplica; com a tela travada, não abre (abre ao destravar).
function abrirChat({ foco = false } = {}) {
  if (abrindoChat) return abrindoChat;
  abrindoChat = (async () => {
    if (travaAtiva(await lerTrava())) return null;
    const existente = await lerSessao(SESSAO_CHAT_JANELA, null);
    if (existente != null) {
      const w = await chrome.windows.get(existente).catch(() => null);
      if (w) {
        await chrome.windows
          .update(w.id, foco ? { state: 'normal', focused: true } : { drawAttention: true })
          .catch(() => {});
        return w.id;
      }
    }
    const pos = {};
    try {
      const n = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if ([n?.left, n?.top, n?.width, n?.height].every((v) => typeof v === 'number')) {
        pos.left = Math.max(0, n.left + n.width - 356);
        pos.top = Math.max(0, n.top + n.height - 476);
      }
    } catch {
      // sem janela normal: o sistema escolhe a posição
    }
    const w = await chrome.windows.create({
      url: chrome.runtime.getURL('chat/chat.html'),
      type: 'popup',
      width: 340,
      height: 460,
      ...pos,
      focused: !!foco,
    });
    await areaSessao()?.set({ [SESSAO_CHAT_JANELA]: w.id });
    return w.id;
  })().finally(() => {
    abrindoChat = null;
  });
  return abrindoChat;
}

/// chat_message do professor (ChromeOS).
async function execChatMessage({ texto, de, mid, ts } = {}) {
  const t = cortarCodePoints(String(texto ?? '').trim(), MAX_CHAT_TEXTO);
  if (!t) return { ok: false, error: 'chat_vazio' };
  const nome = cortarCodePoints(String(de ?? '').trim(), 60) || null;
  const focada = await chatFocado();
  const novo = await chatAnexar(
    {
      id: idValido(mid) ? mid : novoId(),
      autor: 'professor',
      ...(nome ? { de: nome } : {}),
      texto: t,
      ts: typeof ts === 'number' && ts > 0 ? ts : Date.now(),
    },
    { naoLida: !focada, de: nome },
  );
  if (novo) abrirChat({ foco: false }).catch((e) => console.warn('[CdA] janela de chat:', e?.message ?? e));
  return { ok: true };
}

// Falha de rede aparece no próprio balão ("Não enviada · Tentar de novo");
// só a recusa por limite (do agente do Celita) vira aviso no rodapé.
const avisoFalhaUp = (r) => (erroEhLimite(r?.erro) ? { aviso: TEXTO_LIMITE.L1 } : {});

/// Balão que ficou "Enviando…" porque o SW morreu no meio do envio.
const ENVIO_PRESO_MS = 30000;
const envioPreso = (i, agora = Date.now()) =>
  i.estado === 'enviando' && agora - (i.desde ?? i.ts ?? 0) > ENVIO_PRESO_MS;

async function marcarEstadoChat(id, estado) {
  await mudarChat((c) => {
    const item = c.itens.find((i) => i.id === id && i.autor === 'aluno');
    if (!item) return undefined;
    item.estado = estado;
    if (estado === 'enviando') item.desde = Date.now();
    else delete item.desde;
    return c;
  });
}

/// `anexada`: o balão entrou no histórico (a janela limpa o campo); com
/// limite não entra, e o texto fica no campo para o aluno tentar depois.
async function chatEnviar({ id, texto } = {}) {
  const t = cortarCodePoints(String(texto ?? '').trim(), MAX_CHAT_TEXTO);
  if (!t) return { ok: false, anexada: false };
  const regra = await consumirLimite(UpType.CHAT);
  if (regra) return { ok: false, anexada: false, aviso: TEXTO_LIMITE[regra] };
  const mid = idValido(id) ? id : novoId();
  await chatAnexar({ id: mid, autor: 'aluno', texto: t, ts: Date.now(), estado: 'enviando' });
  const r = await enviarUp(UpType.CHAT, { texto: t }, mid);
  await marcarEstadoChat(mid, r?.ok ? 'enviada' : 'falhou');
  return r?.ok ? { ok: true, anexada: true } : { ok: false, anexada: true, ...avisoFalhaUp(r) };
}

async function chatReenviar({ id } = {}) {
  const c = await lerSessao(SESSAO_CHAT, chatVazio());
  const item = c.itens.find(
    (i) => i.id === id && i.autor === 'aluno' && (i.estado === 'falhou' || envioPreso(i)),
  );
  if (!item) return { ok: false };
  const regra = await consumirLimite(UpType.CHAT);
  if (regra) return { ok: false, aviso: TEXTO_LIMITE[regra] };
  await marcarEstadoChat(item.id, 'enviando');
  // Mesmo mid: o professor deduplica por (PC, mid).
  const r = await enviarUp(UpType.CHAT, { texto: item.texto }, item.id);
  await marcarEstadoChat(item.id, r?.ok ? 'enviada' : 'falhou');
  return r?.ok ? { ok: true } : { ok: false, ...avisoFalhaUp(r) };
}

async function chatMao() {
  const regra = await consumirLimite(UpType.RAISE_HAND);
  if (regra) {
    const c = await lerSessao(SESSAO_CHAT, chatVazio());
    return { ok: false, maoAte: c.maoAte ?? 0 };
  }
  const r = await enviarUp(UpType.RAISE_HAND, {}, novoId());
  if (!r?.ok) return { ok: false, aviso: TEXTO_FALHA_ENVIO };
  const agora = Date.now();
  const maoAte = agora + L4_INTERVALO_MS;
  await chatAnexar({ id: novoId(), autor: 'sistema', texto: `Você levantou a mão às ${horaMin(agora)}`, ts: agora });
  await mudarChat((c) => {
    c.maoAte = maoAte;
    return c;
  });
  chrome.runtime.sendMessage({ cmd: IPC.CHAT_EVENTO, tipo: 'mao', maoAte }).catch(() => {});
  return { ok: true, maoAte };
}

async function chatLidas() {
  await mudarChat((c) => {
    if (!c.naoLidas) return undefined;
    c.naoLidas = 0;
    return c;
  });
  atualizarBadgeChat(0);
}

async function chatHistorico() {
  const [c, binding, trava] = await Promise.all([
    lerSessao(SESSAO_CHAT, chatVazio()),
    chrome.storage.local.get(STORAGE_BINDING).then((o) => o[STORAGE_BINDING] ?? null),
    lerTrava(),
  ]);
  return {
    ...c,
    professor: binding?.teacherName ?? null,
    // 'searching' = SW acabou de (re)nascer e ainda não sabe: a janela não
    // trava o campo por isso (o heartbeat do offscreen confirma em ≤ 20 s).
    conectado: lastState === 'searching' ? null : lastState === 'connected',
    travada: travaAtiva(trava),
  };
}

// ---- Miniatura da grade ao vivo (ChromeOS) ----

const PERMISSAO_MINIATURA = { origins: ['<all_urls>'] };

function ehWebStore(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === 'chromewebstore.google.com' || (h === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  } catch {
    return false;
  }
}

async function blobParaBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/// Só a aba ativa da janela normal em foco (captureVisibleTab), reduzida a
/// ≤ 480 px de largura, JPEG qualidade 60. Precisa da permissão OPCIONAL
/// <all_urls> concedida no popup — host_permissions não cresce.
async function capturarMiniatura() {
  const permitido = await Promise.resolve(chrome.permissions?.contains(PERMISSAO_MINIATURA)).catch(() => false);
  if (!permitido) return { motivo: 'sem_permissao' };
  let janela;
  try {
    janela = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  } catch {
    return { motivo: 'aba_protegida' };
  }
  const aba = janela?.tabs?.find((t) => t.active);
  const url = String(aba?.url ?? '');
  const propria = url.startsWith(chrome.runtime.getURL(''));
  if (!janela || janela.type !== 'normal' || !aba || (!isSafeHttpUrl(url) && !propria) || ehWebStore(url)) {
    return { motivo: 'aba_protegida' };
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(janela.id, { format: 'jpeg', quality: 60 });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const escala = Math.min(1, 480 / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * escala));
    const h = Math.max(1, Math.round(bmp.height * escala));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    return { jpegB64: await blobParaBase64(jpeg), w, h };
  } catch (e) {
    console.warn('[CdA] miniatura falhou:', e?.message ?? e);
    return { motivo: 'falhou' };
  }
}

/// `aplicado` do relatório (ChromeOS): trava e prova EFETIVAS agora.
async function aplicadoLocal() {
  const [t, p] = await Promise.all([lerTrava(), carregarProva()]);
  const agora = Date.now();
  return {
    trava: t ? { rev: t.rev, on: travaAtiva(t, agora) } : null,
    prova: p ? { rev: p.rev, on: provaAtiva(p, agora) } : null,
  };
}

// Cada (re)início do SW (inclui onStartup/onInstalled) reafirma a trava: um
// reboot sem rede volta travado pela cópia local.
garantirTrava();
lerSessao(SESSAO_CHAT, null).then((c) => {
  if (c?.naoLidas > 0) atualizarBadgeChat(c.naoLidas);
});

// ---- Roteamento -------------------------------------------------------------

// Quem pode mandar o quê. Content scripts rodam no processo do site (YouTube,
// Instagram, Google) e só falam por `t:'cda-canal'`; um processo de site
// comprometido não pode executar comando do professor, gravar no storage pelo
// proxy, nem capturar a tela. Comandos do professor, proxy de storage e
// miniatura vêm só do offscreen; o resto, só de páginas da extensão.
const SO_DO_OFFSCREEN = new Set([
  IPC.STORE_GET,
  IPC.STORE_SET,
  IPC.STATE_CHANGED,
  IPC.HEARTBEAT,
  IPC.TABS_REPORT,
  IPC.EXEC_OPEN_URL,
  IPC.EXEC_CLOSE_TABS,
  IPC.EXEC_CLOSE_ALL_TABS,
  IPC.EXEC_SET_RULES,
  IPC.EXEC_WALLPAPER,
  IPC.EXEC_SHOW_MESSAGE,
  IPC.EXEC_SET_CLASSVIEW,
  IPC.EXEC_CHAT_MESSAGE,
  IPC.EXEC_UNBLOCK_RESULT,
  IPC.EXEC_SET_LOCK,
  IPC.EXEC_SET_EXAM,
  IPC.TURMA_LIMPAR,
  IPC.CAPTURE_THUMB,
]);
const SO_DE_PAGINA = new Set([
  IPC.GET_STATE,
  IPC.GET_PAIRING,
  IPC.RESET_BIND,
  IPC.RECONNECT,
  IPC.CHAT_HISTORICO,
  IPC.CHAT_ENVIAR,
  IPC.CHAT_REENVIAR,
  IPC.CHAT_MAO,
  IPC.CHAT_LIDAS,
  IPC.CHAT_ABRIR,
]);

function remetenteAceito(cmd, sender) {
  const url = String(sender?.url ?? '');
  if (sender?.id !== chrome.runtime.id) return false;
  if (SO_DO_OFFSCREEN.has(cmd)) return url === chrome.runtime.getURL(OFFSCREEN_URL);
  if (SO_DE_PAGINA.has(cmd)) return url.startsWith(chrome.runtime.getURL(''));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === TARGET_OFFSCREEN) return false;
  if (!remetenteAceito(msg?.cmd, sender)) {
    sendResponse({ ok: false, error: 'origem_invalida' });
    return false;
  }

  switch (msg?.cmd) {
    case IPC.STATE_CHANGED:
      lastTeacher = msg.teacher ?? lastTeacher;
      lastMotivo = msg.motivo ?? null;
      updateBadge(msg.state);
      return false;

    case IPC.HEARTBEAT:
      // Offscreen vivo e stream saudável — reseta o relógio do watchdog do SW.
      if (msg.healthy) {
        lastHealthyAt = Date.now();
        // SW reiniciado não sabe o estado até o próximo STATE_CHANGED: stream
        // saudável é conectado (badge, popup e janela de chat).
        if (lastState === 'searching') updateBadge('connected');
      }
      return false;

    case IPC.GET_STATE:
      // `motivo` é código fixo (o popup traduz); `modo` esconde do popup o que
      // é só do ChromeOS (chat, mão, miniatura).
      if (native.ativo) {
        sendResponse({
          state: native.estado.state,
          motivo: native.estado.motivo ?? null,
          teacher: native.estado.teacher,
          label: native.estado.label,
          numero: native.estado.numero,
          version: native.estado.version ? `${VERSAO} (agente ${native.estado.version})` : VERSAO,
          modo: 'nativo',
        });
        return false;
      }
      Promise.all([chrome.storage.local.get([STORAGE_KEYPAIR, STORAGE_BINDING]), lerSessao(SESSAO_CHAT, null)])
        .then(([o, chat]) =>
          sendResponse({
            state: lastState,
            motivo: lastMotivo,
            teacher: lastTeacher,
            label: o[STORAGE_KEYPAIR]?.label ?? null,
            numero: o[STORAGE_BINDING]?.numero ?? null,
            version: VERSAO,
            modo: 'chromeos',
            maoAte: chat?.maoAte ?? 0,
          }),
        )
        .catch(() =>
          sendResponse({
            state: lastState,
            motivo: lastMotivo,
            teacher: lastTeacher,
            label: null,
            numero: null,
            version: VERSAO,
            modo: 'chromeos',
            maoAte: 0,
          }),
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
      // O CloudClient junta os acks ao `aplicado` (trava/prova efetivas daqui).
      Promise.all([montarRelatorio(), aplicadoLocal()])
        .then(([report, aplicado]) => sendResponse({ report: { ...report, aplicado } }))
        .catch(() => sendResponse({ report: null }));
      return true;

    // ---- Recursos de turma (ChromeOS; vêm do offscreen, da janela de chat e do popup)
    case IPC.EXEC_CHAT_MESSAGE:
      execChatMessage(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'chat_falhou' }));
      return true;

    case IPC.EXEC_UNBLOCK_RESULT:
      execResultadoPedido(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'executor_falhou' }));
      return true;

    case IPC.EXEC_SET_LOCK:
      execSetLock(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'executor_falhou' }));
      return true;

    case IPC.EXEC_SET_EXAM:
      execSetExam(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'executor_falhou' }));
      return true;

    case IPC.TURMA_LIMPAR:
      limparTurma({ desligarEstado: true }).then(() => sendResponse({ ok: true }));
      return true;

    case IPC.CAPTURE_THUMB:
      capturarMiniatura().then(sendResponse, () => sendResponse({ motivo: 'falhou' }));
      return true;

    case IPC.CHAT_HISTORICO:
      chatHistorico().then(sendResponse, () => sendResponse(null));
      return true;

    case IPC.CHAT_ENVIAR:
      chatEnviar(msg).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case IPC.CHAT_REENVIAR:
      chatReenviar(msg).then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case IPC.CHAT_MAO:
      chatMao().then(sendResponse, () => sendResponse({ ok: false }));
      return true;

    case IPC.CHAT_LIDAS:
      chatLidas().then(() => sendResponse({ ok: true }));
      return true;

    case IPC.CHAT_ABRIR:
      abrirChat({ foco: true }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;

    case IPC.RECONNECT:
      if (native.ativo) {
        native.enviar({ t: 'reconnect' });
        sendResponse({ ok: true });
        return false;
      }
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
      if (native.ativo) {
        native.enviar({ t: 'unbind' });
        sendResponse({ ok: true });
        return false;
      }
      (async () => {
        // O offscreen desfaz o vínculo no RTDB (delete + rotação do token) e
        // limpa o storage via proxy.
        await ensureOffscreen();
        await tellOffscreen({ cmd: IPC.OFF_UNBIND }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    case IPC.GET_PAIRING:
      if (native.ativo) {
        // O token rotaciona no agente; pede o atual para o próximo popup.
        native.pedirPareamento();
        sendResponse(native.pareamento);
        return false;
      }
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
