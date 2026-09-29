// Google: com as IAs bloqueadas, some com o resumo de IA do topo da pesquisa e
// com o botão do Modo IA. O Modo IA em si (udm=50) é bloqueado no service worker.
'use strict';

const CSS_IA = `
a[href*="udm=50"],
[aria-label="Modo IA" i],
[aria-label="AI Mode" i],
.cda-oculto-ia
{ display: none !important; }
`;

// O resumo não tem id estável; o título dele é o que muda menos.
const TITULO_RESUMO = /^(vis[aã]o geral (criada )?(por|de) ia|ai overview)$/i;
const RAIZES = new Set(['rso', 'center_col', 'rcnt', 'search']);

function blocoDoResumo(titulo) {
  let el = titulo;
  for (let i = 0; i < 25 && el?.parentElement; i++) {
    if (RAIZES.has(el.parentElement.id)) return el;
    el = el.parentElement;
  }
  return titulo.closest('[data-hveid]') ?? null;
}

function esconderResumo(ligado) {
  if (!ligado) {
    for (const el of document.querySelectorAll('.cda-oculto-ia')) el.classList.remove('cda-oculto-ia');
    return;
  }
  for (const titulo of document.querySelectorAll('[role="heading"], h1, h2, h3')) {
    if (!TITULO_RESUMO.test(titulo.textContent.trim())) continue;
    blocoDoResumo(titulo)?.classList.add('cda-oculto-ia');
  }
}

function aplicarGoogle(filtros) {
  CDA_FILTROS.estilo(filtros.ias ? CSS_IA : '');
  esconderResumo(filtros.ias);
}

CDA_FILTROS.ao(aplicarGoogle);
CDA_FILTROS.aoMudarPagina(aplicarGoogle);
