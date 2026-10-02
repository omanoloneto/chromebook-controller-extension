// Popup — número da unidade em destaque, status do vínculo, QR de pareamento,
// reconectar (↻) e versão da extensão. No telão, oferece a página "Ver a turma".
// No ChromeOS conectado: "Falar com o professor", "✋ Levantar a mão" e o
// pedido da permissão opcional da miniatura (grade ao vivo).
// O `detail` técnico do offscreen nunca aparece aqui (só no console dele).

import { IPC, STORAGE_CLASSVIEW } from '../lib/ipc.js';
import qrcode from '../lib/vendor/qrcode.js';
import { makeQrPayload } from '../lib/protocol.js';

const el = {
  status: document.getElementById('status'),
  detalhe: document.getElementById('detalhe'),
  detalhe2: document.getElementById('detalhe2'),
  detalhe3: document.getElementById('detalhe3'),
  turma: document.getElementById('turma'),
  btnChat: document.getElementById('btn-chat'),
  btnMao: document.getElementById('btn-mao'),
  avisoTurma: document.getElementById('aviso-turma'),
  miniatura: document.getElementById('miniatura'),
  btnMiniatura: document.getElementById('btn-miniatura'),
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
let estadoAtual = 'connecting';
let modo = 'chromeos';
let telao = false;
let maoAte = 0;
let timerMao = null;
let timerAviso = null;

const PERMISSAO_MINIATURA = { origins: ['<all_urls>'] };
const MAO_LEVANTAR = '✋ Levantar a mão';
const MAO_LEVANTADA = 'Mão levantada ✋';

/// Texto fixo por estado (§10.1 da spec de turma; igual ao desktop.py).
function textoDoEstado(state, motivo) {
  if (motivo === 'vinculo_divergente') {
    return 'Este computador está ligado a outro professor. Desconecte e conecte de novo.';
  }
  switch (state) {
    case 'pairing':
      return 'Mostre este código para o professor';
    case 'configuring':
      return 'Preparando este computador para a aula…';
    case 'connected':
      return 'Pronto para a aula';
    default:
      return 'Conectando…';
  }
}

function render(state, motivo, teacher) {
  estadoAtual = state;
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
  const texto = textoDoEstado(state, motivo);
  el.detalhe.textContent = texto;
  el.detalhe2.textContent = texto === 'Conectando…' ? '' : texto; // o passo já diz "Conectando…"
  el.detalhe3.textContent = texto;
  renderTurma();
}

// ---- Turma: chat, mão e miniatura (ChromeOS, fora do telão) ----------------

function renderTurma() {
  const visivel = estadoAtual === 'connected' && modo === 'chromeos' && !telao;
  el.turma.hidden = !visivel;
  if (!visivel) return;
  const agora = Date.now();
  const levantada = agora < maoAte;
  el.btnMao.textContent = levantada ? MAO_LEVANTADA : MAO_LEVANTAR;
  el.btnMao.disabled = levantada;
  clearTimeout(timerMao);
  if (levantada) timerMao = setTimeout(renderTurma, maoAte - agora + 50);
  atualizarMiniatura();
}

async function atualizarMiniatura() {
  const tem = await Promise.resolve(chrome.permissions?.contains(PERMISSAO_MINIATURA)).catch(() => true);
  el.miniatura.hidden = tem !== false;
}

function avisoTurma(texto) {
  el.avisoTurma.textContent = texto;
  el.avisoTurma.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => {
    el.avisoTurma.hidden = true;
  }, 4000);
}

el.btnChat.addEventListener('click', async () => {
  el.btnChat.disabled = true;
  await chrome.runtime.sendMessage({ cmd: IPC.CHAT_ABRIR }).catch(() => {});
  window.close();
});

el.btnMao.addEventListener('click', async () => {
  el.btnMao.disabled = true;
  const r = await chrome.runtime.sendMessage({ cmd: IPC.CHAT_MAO }).catch(() => null);
  if (typeof r?.maoAte === 'number') maoAte = Math.max(maoAte, r.maoAte);
  if (r?.aviso) avisoTurma(r.aviso);
  else if (!r) avisoTurma('Não foi possível enviar agora. Tente de novo.');
  renderTurma();
});

// O pedido de permissão precisa nascer no gesto (sem await antes).
el.btnMiniatura.addEventListener('click', () => {
  chrome.permissions
    .request(PERMISSAO_MINIATURA)
    .catch(() => false)
    .then(() => atualizarMiniatura());
});

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
  render('connecting');
  await chrome.runtime.sendMessage({ cmd: IPC.RECONNECT }).catch(() => {});
  setTimeout(() => {
    el.btnReconectar.disabled = false;
    el.btnReconectar.classList.remove('girando');
  }, 2000);
});

// ---- Telão: botão "Ver a turma" (presença do snapshot = papel de telão) ----

async function atualizarTelao() {
  const o = await chrome.storage.local.get(STORAGE_CLASSVIEW).catch(() => ({}));
  telao = !!o[STORAGE_CLASSVIEW];
  el.telao.hidden = !telao;
  renderTurma();
}

el.btnTurma.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('turma/turma.html') });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_CLASSVIEW in changes) atualizarTelao();
});
atualizarTelao();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) render(msg.state, msg.motivo, msg.teacher);
  else if (msg?.cmd === IPC.CHAT_EVENTO && msg.tipo === 'mao' && typeof msg.maoAte === 'number') {
    maoAte = Math.max(maoAte, msg.maoAte);
    renderTurma();
  }
});

chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => {
  modo = r?.modo === 'nativo' ? 'nativo' : 'chromeos';
  maoAte = typeof r?.maoAte === 'number' ? r.maoAte : 0;
  render(r?.state ?? 'connecting', r?.motivo ?? null, r?.teacher);
  renderNumero(r?.numero ?? null, r?.label);
  // Versão vem do SW (getManifest não é confiável fora dele).
  el.versao.textContent = 'Versão ' + (r?.version ?? '—');
});

// Enquanto o popup está em pareamento, o token pode rotacionar (QR usado).
qrTimer = setInterval(() => {
  if (!el.pareamento.hidden) atualizarQr();
}, 2000);
window.addEventListener('unload', () => clearInterval(qrTimer));
