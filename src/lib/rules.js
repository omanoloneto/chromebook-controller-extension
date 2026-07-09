// Matching de regras de bloqueio — spec normativa em docs/protocolo.md §3.2.
// Precisa casar EXATAMENTE com o app (lib/src/commands/domain_rules.dart).
// Puro (sem chrome.*) — testável em Node (tests/rules.test.mjs).

export const MAX_RULES = 1000;
export const MAX_RULE_PATTERN = 200;

/// Normaliza um padrão digitado: trim, minúsculas, sem esquema, sem porta,
/// sem `/` final. `www.` NÃO é removido (subdomínio já casa via hostCasa).
export function normalizarPadrao(p) {
  let s = String(p ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  const barra = s.indexOf('/');
  let host = barra === -1 ? s : s.slice(0, barra);
  const resto = barra === -1 ? '' : s.slice(barra);
  const doisPontos = host.indexOf(':');
  if (doisPontos !== -1) host = host.slice(0, doisPontos);
  s = (host + resto).replace(/\/+$/, '');
  return s.slice(0, MAX_RULE_PATTERN);
}

/// Host casa com padrão de domínio: igual ou subdomínio.
/// Ex.: 'youtube.com' casa 'm.youtube.com', NÃO casa 'notyoutube.com'.
export function hostCasa(host, pattern) {
  return host === pattern || host.endsWith('.' + pattern);
}

/// Uma regra (já normalizada) casa com a URL?
export function regraCasa(pattern, url) {
  if (!pattern) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const barra = pattern.indexOf('/');
  if (barra === -1) return hostCasa(host, pattern);
  const pHost = pattern.slice(0, barra);
  const pPath = pattern.slice(barra); // inclui o '/'
  return hostCasa(host, pHost) && u.pathname.toLowerCase().startsWith(pPath);
}

/// Primeira regra que casa com a URL, ou null. `rules` = [{pattern}].
export function acharRegra(rules, url) {
  for (const r of rules ?? []) {
    if (regraCasa(r?.pattern, url)) return r;
  }
  return null;
}
