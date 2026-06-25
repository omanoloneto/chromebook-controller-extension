// Popup = lançador. O pareamento de fato roda numa aba (pairing/pairing.html),
// porque a câmera (getUserMedia) não funciona no popup de extensão.

import { IPC } from '../lib/ipc.js';

const el = {
  status: document.getElementById('status'),
  dica: document.getElementById('dica'),
  conectado: document.getElementById('conectado'),
  btnParear: document.getElementById('btn-parear'),
};

function render(state) {
  const conectado = state === 'connected';
  el.status.textContent = conectado ? 'Conectado' : 'Não pareado';
  el.conectado.hidden = !conectado;
  el.dica.hidden = conectado;
  el.btnParear.textContent = conectado ? 'Parear outro celular' : 'Parear';
}

el.btnParear.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('pairing/pairing.html') });
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) render(msg.state);
});

chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => render(r?.state ?? 'disconnected'));
