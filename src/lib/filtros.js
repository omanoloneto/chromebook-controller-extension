// Filtros de vídeos curtos, canais e IAs — spec em docs/protocolo.md §3.
// Puro (sem chrome.*) — testável em Node (tests/filtros.test.mjs).
//
// O professor liga filtros prontos em vez de digitar padrões: esconder Shorts
// e Reels exige mexer na página (content scripts), não só na URL, e a lista de
// IAs muda com frequência demais para ficar a cargo de quem dá aula.

import { hostCasa } from './rules.js';

export const MAX_CANAIS = 200;
export const MAX_CANAL = 100;

// Pedido do usuário: tudo chega ligado; o professor desliga no app.
export const FILTROS_PADRAO = Object.freeze({
  shorts: true,
  reels: true,
  tiktok: true,
  ias: true,
  canais: Object.freeze([]),
});

export const DOMINIOS_IA = Object.freeze([
  'gemini.google.com',
  'aistudio.google.com',
  'notebooklm.google.com',
  'labs.google',
  'chatgpt.com',
  'chat.openai.com',
  'sora.com',
  'claude.ai',
  'copilot.microsoft.com',
  'copilot.cloud.microsoft',
  'perplexity.ai',
  'deepseek.com',
  'meta.ai',
  'grok.com',
  'character.ai',
  'poe.com',
  'chat.mistral.ai',
  'pi.ai',
  'you.com',
  'phind.com',
  'blackbox.ai',
  'chat.qwen.ai',
  'kimi.com',
  'duck.ai',
]);

const CANAL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const CANAL_HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;

/// '@Handle', 'handle', 'youtube.com/@handle/videos', 'youtube.com/channel/UC…'
/// ou 'UC…' → '@handle' (minúsculo) ou o id 'UC…'. Inválido → null.
export function normalizarCanal(texto) {
  let s = String(texto ?? '').trim();
  if (!s) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*youtube\.com(\/[^?#]*)?/i);
  if (url) {
    const partes = (url[1] ?? '').split('/').filter(Boolean);
    if (partes[0]?.startsWith('@')) s = partes[0];
    else if (partes[0] === 'channel' && partes[1]) s = partes[1];
    else return null;
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  if (CANAL_ID.test(s)) return s;
  if (!s.startsWith('@')) s = '@' + s;
  return CANAL_HANDLE.test(s) ? s.toLowerCase() : null;
}

/// Payload cru (ou ausente) → filtros completos. Chave ausente = padrão.
export function limparFiltros(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const bool = (k) => (typeof o[k] === 'boolean' ? o[k] : FILTROS_PADRAO[k]);
  const canais = [];
  for (const c of Array.isArray(o.canais) ? o.canais : []) {
    const n = typeof c === 'string' && c.length <= MAX_CANAL ? normalizarCanal(c) : null;
    if (n && !canais.includes(n)) canais.push(n);
    if (canais.length >= MAX_CANAIS) break;
  }
  return { shorts: bool('shorts'), reels: bool('reels'), tiktok: bool('tiktok'), ias: bool('ias'), canais };
}

function primeiroSegmento(pathname) {
  return (pathname.split('/')[1] ?? '').toLowerCase();
}

function ehYoutube(host) {
  return hostCasa(host, 'youtube.com');
}

function ehGoogle(host) {
  return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

/// Por que um filtro bloqueia esta URL: 'tiktok' | 'shorts' | 'reels' | 'ia' |
/// 'canal' | null. Só URL — esconder partes da página é dos content scripts.
export function motivoFiltro(filtros, url) {
  if (!filtros) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const seg = primeiroSegmento(u.pathname);

  if (filtros.tiktok && hostCasa(host, 'tiktok.com')) return 'tiktok';
  if (filtros.shorts && ehYoutube(host) && seg === 'shorts') return 'shorts';
  if (filtros.reels && hostCasa(host, 'instagram.com')) {
    // /reels/, /reel/{id} e a aba Reels do perfil (/{usuario}/reels/).
    const segundo = (u.pathname.split('/')[2] ?? '').toLowerCase();
    if (seg === 'reels' || seg === 'reel' || segundo === 'reels' || segundo === 'reel') return 'reels';
  }
  if (filtros.ias) {
    if (DOMINIOS_IA.some((d) => hostCasa(host, d))) return 'ia';
    if (ehGoogle(host) && seg === 'search' && u.searchParams.get('udm') === '50') return 'ia';
    if (hostCasa(host, 'bing.com') && (seg === 'chat' || seg === 'copilotsearch')) return 'ia';
    if (hostCasa(host, 'huggingface.co') && seg === 'chat') return 'ia';
  }
  if (filtros.canais?.length && ehYoutube(host)) {
    const partes = u.pathname.split('/').filter(Boolean);
    let canal = null;
    if (partes[0]?.startsWith('@')) {
      try {
        canal = decodeURIComponent(partes[0]).toLowerCase();
      } catch {
        canal = null;
      }
    } else if (partes[0] === 'channel' && partes[1]) canal = partes[1];
    if (canal && filtros.canais.includes(canal)) return 'canal';
  }
  return null;
}

/// O dono de um vídeo (handle ou id vindos da página) está bloqueado?
export function canalBloqueado(filtros, { handle, id } = {}) {
  if (!filtros?.canais?.length) return false;
  const h = typeof handle === 'string' ? normalizarCanal(handle) : null;
  return (h !== null && filtros.canais.includes(h)) || (typeof id === 'string' && filtros.canais.includes(id));
}
