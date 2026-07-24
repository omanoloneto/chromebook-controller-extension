// Limpeza de sessões de sites fora da escola — parte PURA (sem chrome.*), para
// ser testável isolada (espelho em tests/session-wipe.test.mjs). O glue com
// chrome.browsingData / listeners vive em background/session-wipe.js.
//
// LIMITES (decisão de arquitetura — não regredir):
// - É POR-SITE, nunca por-conta. Nenhuma API do Chrome diz qual e-mail está
//   logado num site; só dá para limpar cookies/storage de um origin inteiro.
//   A conta @escolacelita.com sobrevive à limpeza só porque é a conta do
//   dispositivo (o Chrome re-injeta os cookies da conta primária via
//   account-consistency depois). Todo o resto — Canva/trabalhosdeciencias,
//   contas pessoais — é deslogado.
// - google.com é UM cookie jar para TODAS as contas Google: limpar desloga
//   todas de uma vez (a primária @escolacelita re-injeta; as demais não).

// Origins a PRESERVAR na limpeza (viram excludeOrigins: "limpa tudo MENOS
// estes"). Default VAZIO = limpa TODOS os sites, sem exceção (desloga inclusive
// o Canva). Existe como gancho: se um dia a escola quiser poupar algum site
// sancionado, o app/admin grava a lista em STORAGE_SCHOOL_ORIGINS — sem tocar
// no código. NÃO faz sentido pôr *.google.com aqui (só manteria as contas
// Google logadas, incluindo as pessoais).
export const DEFAULT_SCHOOL_ORIGINS = Object.freeze([]);

// Tipos de dado limpos. TODOS suportam filtro por origin (excludeOrigins);
// history/downloads/passwords NÃO suportam e fariam o remove() rejeitar — por
// isso ficam de fora de propósito.
export const DATA_A_LIMPAR = Object.freeze({
  cookies: true,
  localStorage: true,
  indexedDB: true,
  serviceWorkers: true,
  cacheStorage: true,
});

// Sanitiza a allowlist. `undefined`/não-array => volta ao DEFAULT (chave nunca
// configurada). Array (mesmo vazio) => usa como veio: `[]` significa
// deliberadamente "limpar TODOS os sites, sem exceção". Mantém só strings
// http(s) e deduplica.
export function normalizarOrigens(lista) {
  if (!Array.isArray(lista)) return [...DEFAULT_SCHOOL_ORIGINS];
  const vistos = new Set();
  const out = [];
  for (const s of lista) {
    if (typeof s !== 'string') continue;
    const o = s.trim();
    if (!/^https?:\/\/[^/]+$/.test(o)) continue; // origin puro (sem path)
    if (vistos.has(o)) continue;
    vistos.add(o);
    out.push(o);
  }
  return out;
}

// Monta os args de chrome.browsingData.remove(options, dataToRemove).
// excludeOrigins e origins são mutuamente exclusivos; allowlist vazia => omite
// o campo (= limpa todos os origins).
export function montarOpcoesLimpeza(origensEscola) {
  const excluir = normalizarOrigens(origensEscola);
  const options = { since: 0, originTypes: { unprotectedWeb: true } };
  if (excluir.length > 0) options.excludeOrigins = excluir;
  return { options, dataToRemove: { ...DATA_A_LIMPAR } };
}
