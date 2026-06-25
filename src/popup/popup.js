// Popup — mostra o status do vínculo, permite desvincular e informar o IP do
// celular (fallback quando a descoberta automática não acha).

import { IPC } from '../lib/ipc.js';

const el = {
  status: document.getElementById('status'),
  conectado: document.getElementById('conectado'),
  procurando: document.getElementById('procurando'),
  ip: document.getElementById('ip'),
  btnIp: document.getElementById('btn-ip'),
  btnReset: document.getElementById('btn-reset'),
};

function render(state) {
  const conectado = state === 'connected';
  el.status.textContent = conectado ? 'Conectado ao professor' : 'Procurando o professor…';
  el.conectado.hidden = !conectado;
  el.procurando.hidden = conectado;
}

el.btnIp.addEventListener('click', async () => {
  const ip = el.ip.value.trim();
  if (!ip) return;
  el.btnIp.disabled = true;
  await chrome.runtime.sendMessage({ cmd: IPC.SET_MANUAL_IP, ip }).catch(() => {});
  el.status.textContent = 'Tentando ' + ip + '…';
  el.btnIp.disabled = false;
});

el.btnReset.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ cmd: IPC.RESET_BIND }).catch(() => {});
  render('searching');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) render(msg.state);
});

chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => render(r?.state ?? 'searching'));
