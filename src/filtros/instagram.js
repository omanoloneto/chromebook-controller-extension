// Instagram: some com o botão e os links de Reels e com os reels do feed. Os
// endereços /reels e /reel são bloqueados no service worker.
'use strict';

const CSS_REELS = `
a[href="/reels/"],
a[href*="/reels/"],
a[href*="/reel/"],
article:has(a[href*="/reel/"])
{ display: none !important; }
`;

function aplicarInstagram(filtros) {
  CDA_FILTROS.estilo(filtros.reels ? CSS_REELS : '');
}

CDA_FILTROS.ao(aplicarInstagram);
CDA_FILTROS.aoMudarPagina(aplicarInstagram);
