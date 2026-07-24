// Popup — número da unidade em destaque, status do vínculo, QR de pareamento,
// reconectar (↻) e versão da extensão. No telão, oferece a página "Ver a turma".

import { IPC, STORAGE_CLASSVIEW } from '../lib/ipc.js';
import qrcode from '../lib/vendor/qrcode.js';
import { makeQrPayload } from '../lib/protocol.js';

const el = {
  status: document.getElementById('status'),
  detalhe: document.getElementById('detalhe'),
  detalhe2: document.getElementById('detalhe2'),
  conectado: document.getElementById('conectado'),
  numero: document.getElementById('numero'),
  prof: document.getElementById('prof'),
  pareamento: document.getElementById('pareamento'),
  conectando: document.getElementById('conectando'),
  qr: document.getElementById('qr'),
  btnTelaCheia: document.getElementById('btn-tela-cheia'),
  btnReconectar: document.getElementById('btn-reconectar'),
  versao: document.getElementById('versao'),
  telao: document.getElementById('telao'),
  btnTurma: document.getElementById('btn-turma'),
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

// Número grande: numero do bind (app >= 0.13); PCs pareados antes ainda não
// têm — cai para o label do PC até re-parear.
function renderNumero(numero, label) {
  if (typeof numero === 'number') {
    el.numero.textContent = String(numero);
    el.numero.classList.remove('texto');
  } else {
    el.numero.textContent = label ?? '—';
    el.numero.classList.add('texto');
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

// ---- Reconectar (↻): derruba e refaz a conexão Firebase --------------------

el.btnReconectar.addEventListener('click', async () => {
  el.btnReconectar.disabled = true;
  el.btnReconectar.classList.add('girando');
  render('connecting', 'reconectando…');
  await chrome.runtime.sendMessage({ cmd: IPC.RECONNECT }).catch(() => {});
  setTimeout(() => {
    el.btnReconectar.disabled = false;
    el.btnReconectar.classList.remove('girando');
  }, 2000);
});

// ---- Telão: botão "Ver a turma" (presença do snapshot = papel de telão) ----

async function atualizarTelao() {
  const o = await chrome.storage.local.get(STORAGE_CLASSVIEW).catch(() => ({}));
  el.telao.hidden = !o[STORAGE_CLASSVIEW];
}

el.btnTurma.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('turma/turma.html') });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_CLASSVIEW in changes) atualizarTelao();
});
atualizarTelao();

// Versão da extensão no rodapé (no lugar do antigo aviso de exclusividade).
el.versao.textContent = 'Versão ' + chrome.runtime.getManifest().version;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) render(msg.state, msg.detail, msg.teacher);
});

chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => {
  render(r?.state ?? 'connecting', undefined, r?.teacher);
  renderNumero(r?.numero ?? null, r?.label);
});

// Enquanto o popup está em pareamento, o token pode rotacionar (QR usado).
qrTimer = setInterval(() => {
  if (!el.pareamento.hidden) atualizarQr();
}, 2000);
window.addEventListener('unload', () => clearInterval(qrTimer));
