// Canal aluno→professor (`up`) e utilitários de turma — docs/protocolo.md
// ("`up` (PC → professor)"). Puro (sem chrome.*) — testável em Node
// (tests/up.test.mjs). Mesmas regras de agent/up.py (Celita) e de
// lib/src/cloud/up_router.dart (app).

export const UP_MAX_ENVELOPE = 4096; // rules: filho de up/ é string < 4096
export const MAX_CHAT_TEXTO = 500; // code points
export const MAX_PEDIDO_SITE = 100;
export const MAX_PEDIDO_URL = 500;
export const MAX_PEDIDO_MOTIVO = 200;
export const UP_MAX_ENTRADAS = 20; // o PC poda além disto
export const UP_IDADE_MAX_PC = 2 * 3600 * 1000; // ... e o que tiver mais de 2 h

export const UpType = Object.freeze({
  CHAT: 'chat',
  UNBLOCK_REQUEST: 'unblock_request',
  RAISE_HAND: 'raise_hand',
});

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/// Id de comando/mensagem: 12 bytes aleatórios em base64url (16 caracteres).
export function novoId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  return s;
}

/// Id aceito vindo de uma página da extensão (o SW gera outro se não casar).
export function idValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(id);
}

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/// Os 8 primeiros caracteres de um pushId do RTDB codificam o ms do servidor.
/// Chave que não é pushId → null.
export function pushIdMs(key) {
  if (typeof key !== 'string' || key.length < 8) return null;
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    const v = PUSH_CHARS.indexOf(key[i]);
    if (v < 0) return null;
    ms = ms * 64 + v;
  }
  return ms;
}

/// Chaves de `up` a apagar na poda do PC: mais velhas que 2 h e as mais
/// antigas além das 20 mais novas. Chave que não é pushId também sai.
export function chavesParaPodar(chaves, agora) {
  const validas = [];
  const fora = [];
  for (const k of chaves ?? []) {
    const ms = pushIdMs(k);
    if (ms === null || ms < agora - UP_IDADE_MAX_PC) fora.push(k);
    else validas.push(k);
  }
  validas.sort(); // pushIds são cronológicos
  return [...fora, ...validas.slice(0, Math.max(0, validas.length - UP_MAX_ENTRADAS))];
}

/// Sufixos públicos curtos: pedir "com" liberaria a internet inteira.
export const SUFIXOS_PUBLICOS = Object.freeze([
  'com', 'br', 'net', 'org', 'edu', 'gov',
  'com.br', 'net.br', 'org.br', 'edu.br', 'gov.br',
  'app', 'dev', 'io',
]);

/// Host aceitável num pedido de liberação (PC antes de enviar, professor ao
/// receber): minúsculo, ^[a-z0-9.-]{1,100}$, >= 2 rótulos não vazios e nunca
/// um sufixo público.
export function siteValido(site) {
  if (typeof site !== 'string' || !/^[a-z0-9.-]{1,100}$/.test(site)) return false;
  const rotulos = site.split('.');
  if (rotulos.length < 2 || rotulos.some((r) => r === '')) return false;
  return !SUFIXOS_PUBLICOS.includes(site);
}

/// Hostname minúsculo de uma URL (vazio se não der para ler).
export function hostDeUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/// Corta por code points (um emoji conta 1, como no Python e no Dart).
export function cortarCodePoints(s, max) {
  const cps = Array.from(String(s ?? ''));
  return cps.length > max ? cps.slice(0, max).join('') : cps.join('');
}

export function contarCodePoints(s) {
  return Array.from(String(s ?? '')).length;
}

/// Payload limpo para o `up` (caps de code points), ou null se inválido.
export function limparPayloadUp(tipo, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (tipo) {
    case UpType.CHAT: {
      const texto = cortarCodePoints(String(p.texto ?? '').trim(), MAX_CHAT_TEXTO);
      return texto ? { texto } : null;
    }
    case UpType.UNBLOCK_REQUEST: {
      const site = typeof p.site === 'string' ? p.site : '';
      if (!siteValido(site)) return null;
      const url = cortarCodePoints(p.url ?? '', MAX_PEDIDO_URL);
      const motivo = cortarCodePoints(String(p.motivo ?? '').trim(), MAX_PEDIDO_MOTIVO);
      const bloqueio = p.bloqueio === 'prova' ? 'prova' : 'regra';
      return { site, url, motivo, bloqueio };
    }
    case UpType.RAISE_HAND:
      return {};
    default:
      return null;
  }
}

/// Iniciais do professor para o avatar do chat: tira "Prof.", "Profa.",
/// "Professor", "Professora"; 2+ palavras = 1ª letra da primeira e da última;
/// 1 palavra = as 2 primeiras letras; vazio = "?". Ex.: "Prof. Manoel" → "MA".
export function monograma(nome) {
  const palavras = String(nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (palavras.length && ['prof.', 'profa.', 'professor', 'professora'].includes(palavras[0].toLowerCase())) {
    palavras.shift();
  }
  if (palavras.length === 0) return '?';
  if (palavras.length === 1) return Array.from(palavras[0]).slice(0, 2).join('').toUpperCase();
  const primeira = Array.from(palavras[0])[0];
  const ultima = Array.from(palavras[palavras.length - 1])[0];
  return (primeira + ultima).toUpperCase();
}
