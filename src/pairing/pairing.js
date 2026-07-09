// Página de pareamento (tela cheia) — QR grande + reação ao vínculo em tempo real.

import { IPC } from '../lib/ipc.js';
import qrcode from '../lib/vendor/qrcode.js';
import { makeQrPayload } from '../lib/protocol.js';

const el = {
  instrucao: document.getElementById('instrucao'),
  qr: document.getElementById('qr'),
  nome: document.getElementById('nome'),
  detalhe: document.getElementById('detalhe'),
  sucesso: document.getElementById('sucesso'),
};

let tokenAtual = null;

function spanDica(texto) {
  const s = document.createElement('span');
  s.className = 'dica';
  s.textContent = texto;
  return s;
}

async function atualizar() {
  const estado = await chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).catch(() => null);
  if (estado?.state === 'connected') {
    el.instrucao.hidden = true;
    el.qr.hidden = true;
    el.nome.hidden = true;
    el.sucesso.hidden = false;
    return;
  }
  el.instrucao.hidden = false;
  el.qr.hidden = false;
  el.sucesso.hidden = true;

  const dados = await chrome.runtime.sendMessage({ cmd: IPC.GET_PAIRING }).catch(() => null);
  if (!dados) {
    el.qr.replaceChildren(spanDica('Preparando registro…'));
    return;
  }
  el.nome.textContent = dados.label ? `Este PC: ${dados.label}` : '';
  if (dados.token === tokenAtual) return;
  tokenAtual = dados.token;
  const qr = qrcode(0, 'M');
  qr.addData(makeQrPayload(dados));
  qr.make();
  const img = document.createElement('img');
  img.src = qr.createDataURL(10, 8);
  img.alt = 'QR de pareamento';
  el.qr.replaceChildren(img);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) {
    if (msg.detail) el.detalhe.textContent = msg.detail;
    atualizar();
  }
});

atualizar();
setInterval(atualizar, 2000);
