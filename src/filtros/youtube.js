// YouTube: some com os Shorts (o resto fica para pesquisa) e com os canais
// bloqueados. Os endereços /shorts e /@canal são bloqueados no service worker.
'use strict';

const CSS_SHORTS = `
ytd-reel-shelf-renderer,
ytd-rich-shelf-renderer[is-shorts],
ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model),
ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2),
grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
ytm-shorts-lockup-view-model,
ytm-shorts-lockup-view-model-v2,
ytd-reel-item-renderer,
ytm-reel-shelf-renderer,
ytd-guide-entry-renderer:has(a[title="Shorts"]),
ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
ytd-mini-guide-entry-renderer[aria-label="Shorts"],
ytm-pivot-bar-item-renderer:has(.pivot-shorts),
yt-tab-shape[tab-title="Shorts"],
ytd-video-renderer:has(a[href^="/shorts/"]),
ytd-grid-video-renderer:has(a[href^="/shorts/"]),
ytd-rich-item-renderer:has(a[href^="/shorts/"]),
ytd-compact-video-renderer:has(a[href^="/shorts/"]),
yt-lockup-view-model:has(a[href^="/shorts/"]),
.cda-oculto-shorts
{ display: none !important; }
`;

const CARTOES =
  'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ' +
  'ytd-channel-renderer, ytd-playlist-renderer, yt-lockup-view-model, ytd-reel-item-renderer';

function cssCanal(canal) {
  // O canal já vem normalizado ([A-Za-z0-9._-]), então cabe numa string CSS.
  const links = canal.startsWith('@')
    ? `a[href="/${canal}" i], a[href^="/${canal}/" i]`
    : `a[href="/channel/${canal}"], a[href^="/channel/${canal}/"]`;
  return `:is(${CARTOES}):has(${links}) { display: none !important; }`;
}

// O chip "Shorts" da busca não tem atributo próprio: só o texto.
function esconderChipShorts(ligado) {
  for (const chip of document.querySelectorAll('yt-chip-cloud-chip-renderer')) {
    chip.classList.toggle('cda-oculto-shorts', ligado && chip.textContent.trim() === 'Shorts');
  }
}

let ultimoDono = '';
function conferirDono(filtros) {
  if (!filtros.canais?.length || location.pathname !== '/watch') return;
  const link = document.querySelector(
    'ytd-watch-metadata ytd-channel-name a[href], ytd-video-owner-renderer a[href^="/@"], ytd-video-owner-renderer a[href^="/channel/"]',
  );
  const href = link?.getAttribute('href') ?? '';
  const handle = href.startsWith('/@') ? decodeURIComponent(href.slice(1).split('/')[0]) : undefined;
  const id = href.startsWith('/channel/') ? href.split('/')[2] : undefined;
  if (!handle && !id) return;
  const chave = location.href + '|' + (handle ?? id);
  if (chave === ultimoDono) return;
  ultimoDono = chave;
  chrome.runtime.sendMessage({ t: 'cda-canal', handle, id }).catch(() => {});
}

function aplicarYoutube(filtros) {
  const partes = [];
  if (filtros.shorts) partes.push(CSS_SHORTS);
  for (const canal of filtros.canais ?? []) partes.push(cssCanal(canal));
  CDA_FILTROS.estilo(partes.join('\n'));
  esconderChipShorts(filtros.shorts);
  conferirDono(filtros);
}

CDA_FILTROS.ao(aplicarYoutube);
CDA_FILTROS.aoMudarPagina(aplicarYoutube);
