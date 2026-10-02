// Janela da trava (ChromeOS). Só mostra o recado: quem abre, re-foca e fecha
// esta janela é o service worker (garantirTrava). Texto da rede só por
// textContent.

import { STORAGE_TRAVA } from '../lib/ipc.js';

const PADRAO = 'Olhos no professor';
const texto = document.getElementById('texto');

function mostrar(trava) {
  const t = typeof trava?.texto === 'string' && trava.texto.trim() ? trava.texto : PADRAO;
  texto.textContent = t;
  document.title = t;
}

chrome.storage.local
  .get(STORAGE_TRAVA)
  .then((o) => mostrar(o[STORAGE_TRAVA]))
  .catch(() => mostrar(null));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_TRAVA]) mostrar(changes[STORAGE_TRAVA].newValue);
});

// Nada a fazer com o teclado aqui: menu de contexto e atalhos da página ficam
// mudos (os do sistema continuam — limite declarado no protocolo).
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'F11') e.preventDefault();
});
