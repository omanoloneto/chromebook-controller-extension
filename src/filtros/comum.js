// Base dos filtros de página: lê os filtros efetivos (o service worker grava
// no storage), avisa cada site quando mudam e mantém um <style> próprio.
// Script clássico: content scripts não carregam módulos; os scripts da mesma
// entrada do manifest compartilham este escopo.
'use strict';

var CDA_FILTROS = (() => {
  // Espelho de FILTROS_PADRAO (src/lib/filtros.js): vale antes da 1ª gravação.
  const PADRAO = { shorts: true, reels: true, tiktok: true, ias: true, canais: [] };
  const ID_ESTILO = 'cda-filtros-estilo';
  const ouvintes = [];
  let atual = null;
  let css = '';

  function colocarEstilo() {
    let el = document.getElementById(ID_ESTILO);
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = ID_ESTILO;
    }
    if (el.textContent !== css) el.textContent = css;
    if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
  }

  function aplicar(f) {
    atual = { ...PADRAO, ...(f && typeof f === 'object' ? f : {}) };
    for (const fn of ouvintes) fn(atual);
  }

  let agendado = false;
  function aoMudarPagina(fn) {
    // Sites de página única trocam o conteúdo sem recarregar: reaplica em lote.
    new MutationObserver(() => {
      if (agendado) return;
      agendado = true;
      setTimeout(() => {
        agendado = false;
        colocarEstilo();
        if (atual) fn(atual);
      }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.storage.local
    .get('filtros')
    .then((o) => aplicar(o.filtros))
    .catch(() => aplicar(null));
  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area === 'local' && mudancas.filtros) aplicar(mudancas.filtros.newValue);
  });

  return {
    ao(fn) {
      ouvintes.push(fn);
      if (atual) fn(atual);
    },
    estilo(novo) {
      css = novo;
      colocarEstilo();
    },
    aoMudarPagina,
  };
})();
