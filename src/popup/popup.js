// Popup — status do vínculo, QR de pareamento, renomear PC e desvincular.

import { IPC } from '../lib/ipc.js';
import qrcode from '../lib/vendor/qrcode.js';
import { makeQrPayload } from '../lib/protocol.js';

const el = {
  status: document.getElementById('status'),
  detalhe: document.getElementById('detalhe'),
  detalhe2: document.getElementById('detalhe2'),
  conectado: document.getElementById('conectado'),
  prof: document.getElementById('prof'),
  pareamento: document.getElementById('pareamento'),
  conectando: document.getElementById('conectando'),
  qr: document.getElementById('qr'),
  btnTelaCheia: document.getElementById('btn-tela-cheia'),
  btnReset: document.getElementById('btn-reset'),
  nome: document.getElementById('nome'),
  btnNome: document.getElementById('btn-nome'),
};

let qrTimer = null;
let qrTokenAtual = null;

function render(state, detail, teacher) {
  el.conectado.hidden = state !== 'connected';
  el.pareamento.hidden = state !== 'pairing';
  el.conectando.hidden = state === 'connected' || state === 'pairing';
  if (state === 'connected') {
    el.status.textContent = 'Conectado ao professor';
    el.prof.textContent = teacher ? `✅ Conectado a ${teacher}.` : '✅ Conectado ao professor.';
  } else if (state === 'pairing') {
    el.status.textContent = 'Aguardando pareamento';
    atualizarQr();
  } else {
    el.status.textContent = 'Conectando…';
  }
  if (detail !== undefined) {
    el.detalhe.textContent = detail ?? '';
    el.detalhe2.textContent = detail ?? '';
  }
}

// O QR vem dos dados de pareamento no storage (via SW). O token rotaciona a
// cada uso — refaz a imagem quando mudar.
async function atualizarQr() {
  const dados = await chrome.runtime.sendMessage({ cmd: IPC.GET_PAIRING }).catch(() => null);
  if (!dados) {
    el.qr.replaceChildren(spanDica('Preparando registro…'));
    return;
  }
  if (dados.token === qrTokenAtual) return;
  qrTokenAtual = dados.token;
  const qr = qrcode(0, 'M');
  qr.addData(makeQrPayload(dados));
  qr.make();
  const img = document.createElement('img');
  img.src = qr.createDataURL(5, 8);
  img.alt = 'QR de pareamento';
  img.style.imageRendering = 'pixelated';
  img.style.width = '240px';
  el.qr.replaceChildren(img);
}

function spanDica(texto) {
  const s = document.createElement('span');
  s.className = 'dica';
  s.textContent = texto;
  return s;
}

el.btnTelaCheia.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pairing/pairing.html') });
  window.close();
});

el.btnReset.addEventListener('click', async () => {
  el.btnReset.disabled = true;
  await chrome.runtime.sendMessage({ cmd: IPC.RESET_BIND }).catch(() => {});
  el.btnReset.disabled = false;
  qrTokenAtual = null; // token rotacionou — força QR novo
  render('pairing');
});

el.btnNome.addEventListener('click', async () => {
  const label = el.nome.value.trim();
  if (!label) return;
  el.btnNome.disabled = true;
  const res = await chrome.runtime
    .sendMessage({ cmd: IPC.SET_LABEL, label })
    .catch(() => null);
  el.status.textContent = res?.ok ? 'Nome salvo — reconectando…' : 'Não deu para salvar o nome.';
  el.btnNome.disabled = false;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) render(msg.state, msg.detail, msg.teacher);
});

chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => {
  render(r?.state ?? 'connecting', undefined, r?.teacher);
  if (r?.label) el.nome.value = r.label;
});

// Enquanto o popup está em pareamento, o token pode rotacionar (QR usado).
qrTimer = setInterval(() => {
  if (!el.pareamento.hidden) atualizarQr();
}, 2000);
window.addEventListener('unload', () => clearInterval(qrTimer));
