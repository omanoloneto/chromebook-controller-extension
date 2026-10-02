// Rate-limit do canal aluno→professor (`up`) — docs/protocolo.md, "`up`".
// Puro, com `agora` injetado (tests/limites.test.mjs). Mesmas regras de
// agent/limites.py (Celita). O estado é persistido pelo chamador
// (chrome.storage.local `limites`), então sobrevive ao reinício do
// offscreen/service worker e ao botão ↻.
//
//   L1 chat: 1 a cada 2 s
//   L2 chat: 30 por hora
//   L3 pedido: 1 por site a cada 60 s e no máximo 5 pendentes
//   L4 mão: 1 a cada 10 s

export const L1_INTERVALO_MS = 2000;
export const L2_POR_HORA = 30;
export const L3_POR_SITE_MS = 60000;
export const L3_MAX_PENDENTES = 5;
export const L4_INTERVALO_MS = 10000;
const HORA_MS = 3600 * 1000;
const MAX_SITES = 50;

/// Texto ao aluno (todas as UIs usam exatamente estes).
export const TEXTO_LIMITE = Object.freeze({
  L1: 'Espere um pouquinho para mandar outra mensagem.',
  L2: 'Você mandou muitas mensagens. Espere o professor responder.',
  L3: 'Você já pediu. Aguarde o professor responder.',
  L4: 'Mão levantada ✋',
});

export function estadoVazio() {
  return { chat: [], pedidos: {}, mao: 0 };
}

// Dentro da janela [ts, ts + janela). Carimbo no futuro (relógio voltou)
// não segura o aluno: vale como vencido.
const dentro = (ts, agora, janela) => typeof ts === 'number' && agora - ts >= 0 && agora - ts < janela;

/// Normaliza o que veio do storage e descarta o vencido.
export function limparEstado(raw, agora) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const chat = (Array.isArray(o.chat) ? o.chat : []).filter((ts) => dentro(ts, agora, HORA_MS)).slice(-L2_POR_HORA);
  const pedidos = {};
  for (const [site, ts] of Object.entries(o.pedidos && typeof o.pedidos === 'object' ? o.pedidos : {})) {
    if (dentro(ts, agora, L3_POR_SITE_MS)) pedidos[site] = ts;
  }
  const mao = dentro(o.mao, agora, L4_INTERVALO_MS) ? o.mao : 0;
  return { chat, pedidos, mao };
}

/// null = pode; senão a regra que segura ('L1'..'L4').
/// `pendentes` (L3) = pedidos ainda sem resposta (o chamador conta).
export function verificar(estado, tipo, { agora, site = '', pendentes = 0 } = {}) {
  const e = limparEstado(estado, agora);
  switch (tipo) {
    case 'chat': {
      const ultimo = e.chat[e.chat.length - 1];
      if (dentro(ultimo, agora, L1_INTERVALO_MS)) return 'L1';
      if (e.chat.length >= L2_POR_HORA) return 'L2';
      return null;
    }
    case 'unblock_request':
      if (dentro(e.pedidos[site], agora, L3_POR_SITE_MS)) return 'L3';
      if (pendentes >= L3_MAX_PENDENTES) return 'L3';
      return null;
    case 'raise_hand':
      return dentro(e.mao, agora, L4_INTERVALO_MS) ? 'L4' : null;
    default:
      return null;
  }
}

/// Estado novo depois de um envio aceito.
export function registrar(estado, tipo, { agora, site = '' } = {}) {
  const e = limparEstado(estado, agora);
  switch (tipo) {
    case 'chat':
      e.chat = [...e.chat, agora].slice(-L2_POR_HORA);
      break;
    case 'unblock_request': {
      e.pedidos[site] = agora;
      const sites = Object.keys(e.pedidos);
      if (sites.length > MAX_SITES) {
        sites.sort((a, b) => e.pedidos[a] - e.pedidos[b]);
        for (const s of sites.slice(0, sites.length - MAX_SITES)) delete e.pedidos[s];
      }
      break;
    }
    case 'raise_hand':
      e.mao = agora;
      break;
    default:
      break;
  }
  return e;
}
