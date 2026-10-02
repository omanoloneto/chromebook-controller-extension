// Modo prova (set_exam) — semântica normativa em docs/protocolo.md
// ("`set_exam`"). Puro (sem chrome.*) — testável em Node (tests/prova.test.mjs).
//
// Com a prova ligada, a URL de topo de uma aba passa por estes casos, e o
// primeiro que casar decide:
//   1. página desta extensão, nova aba, chrome-search:// ou about:blank → libera
//   2. esquema que não é http(s) → bloqueia (m=prova)
//   3. mesmo host da página inicial da escola e caminho com o mesmo prefixo
//      → libera (sem filtros)
//   4. casa a lista `allow` (regraCasa) → só os filtros valem (Shorts, IA…);
//      as regras de bloqueio do professor NÃO valem em prova
//   5. senão → bloqueia (m=prova)

import { acharRegra } from './rules.js';
import { motivoFiltro } from './filtros.js';

/// A prova vale agora? `prazo` = relógio local (ms); ausente = sem prazo
/// (Celita: o agente desliga a prova quando o prazo dele vence).
export function provaAtiva(prova, agora) {
  if (!prova || prova.on !== true) return false;
  return typeof prova.prazo !== 'number' || agora < prova.prazo;
}

function liberadaSempre(u, extId) {
  if (u.protocol === 'chrome-extension:') return !!extId && u.host === extId;
  if (u.protocol === 'chrome:') return u.host === 'newtab' || u.host === 'new-tab-page';
  if (u.protocol === 'chrome-search:') return true;
  if (u.protocol === 'about:') return u.pathname === 'blank';
  return false;
}

function casaInicio(u, inicio) {
  if (!inicio) return false;
  let i;
  try {
    i = new URL(inicio);
  } catch {
    return false;
  }
  return u.hostname.toLowerCase() === i.hostname.toLowerCase() && u.pathname.startsWith(i.pathname);
}

/// undefined = prova desligada (vale o bloqueio de sempre); null = libera;
/// string = motivo do bloqueio ('prova' ou o do filtro).
/// O chamador passa só a prova ATIVA (provaAtiva) — `prova.on` é conferido de
/// novo aqui por segurança.
export function motivoProva(prova, filtros, url, extId) {
  if (!prova || prova.on !== true) return undefined;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null; // sem endereço legível não há para onde redirecionar
  }
  if (liberadaSempre(u, extId)) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'prova';
  if (casaInicio(u, prova.inicio)) return null;
  if (acharRegra(prova.allow, url)) return motivoFiltro(filtros, url);
  return 'prova';
}
