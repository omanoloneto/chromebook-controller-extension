// Lógica do popup — orquestra o pareamento e mostra o status.
// O QR é gerado com window.qrcode (lib/vendor/qrcode.js, script clássico).
// A leitura do QR usa o BarcodeDetector nativo (suportado no ChromeOS).

import { IPC } from '../lib/ipc.js';

const el = {
  status: document.getElementById('status'),
  erro: document.getElementById('erro'),
  etapaOffer: document.getElementById('etapa-offer'),
  etapaAnswer: document.getElementById('etapa-answer'),
  etapaOk: document.getElementById('etapa-ok'),
  qrOffer: document.getElementById('qr-offer'),
  camera: document.getElementById('camera'),
  btnParear: document.getElementById('btn-parear'),
  btnEncerrar: document.getElementById('btn-encerrar'),
};

let stream = null;
let detector = null;
let scanning = false;

function mostrarErro(texto) {
  el.erro.textContent = texto;
  el.erro.hidden = !texto;
}

function setStatus(texto) {
  el.status.textContent = texto;
}

function pararCamera() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  el.camera.srcObject = null;
}

function mostrarConectado() {
  pararCamera();
  el.etapaOffer.hidden = true;
  el.etapaAnswer.hidden = true;
  el.etapaOk.hidden = false;
  el.btnParear.hidden = true;
  el.btnEncerrar.hidden = false;
  setStatus('Conectado');
}

function mostrarDesconectado() {
  pararCamera();
  el.etapaOffer.hidden = true;
  el.etapaAnswer.hidden = true;
  el.etapaOk.hidden = true;
  el.btnParear.hidden = false;
  el.btnEncerrar.hidden = true;
  setStatus('Não pareado');
}

function renderQr(container, texto) {
  // qrcode(typeNumber=0 => automático, nível de correção 'L' => maior capacidade)
  const qr = qrcode(0, 'L');
  qr.addData(texto);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

// Abre a câmera (uma vez). Também faz o Chrome expor o IP real da LAN (sem mDNS),
// o que é essencial para a conexão com o app funcionar na rede local.
async function abrirCamera() {
  if (!('BarcodeDetector' in window)) {
    throw new Error(
      'Este Chrome não tem leitor de QR (BarcodeDetector). Atualize o Chrome/ChromeOS.',
    );
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
  });
  el.camera.srcObject = stream;
  await el.camera.play();
  detector = new BarcodeDetector({ formats: ['qr_code'] });
}

// Loop contínuo de leitura do QR #2 (answer). Reinicia-se enquanto `scanning`.
function iniciarScan() {
  scanning = true;
  const loop = async () => {
    if (!scanning) return;
    try {
      const codes = await detector.detect(el.camera);
      if (codes.length > 0) {
        scanning = false;
        return aoLerAnswer(codes[0].rawValue);
      }
    } catch {
      // quadro sem QR — continua
    }
    setTimeout(loop, 200);
  };
  loop();
}

async function aoLerAnswer(texto) {
  setStatus('Conectando…');
  const res = await chrome.runtime.sendMessage({ cmd: IPC.PAIR_ANSWER, answer: texto });
  if (res?.ok) {
    // Sucesso final chega pelo evento STATE_CHANGED ('connected').
    return;
  }
  mostrarErro('QR inválido: ' + (res?.error ?? 'desconhecido') + '. Tentando de novo…');
  iniciarScan(); // continua tentando ler
}

async function parear() {
  mostrarErro('');
  el.btnParear.disabled = true;
  try {
    // 1) Câmera (e permissão) ANTES do offer — ver comentário em abrirCamera().
    await abrirCamera();

    // 2) Pede o offer ao offscreen (via service worker) e mostra o QR #1.
    setStatus('Gerando código…');
    const res = await chrome.runtime.sendMessage({ cmd: IPC.PAIR_START });
    if (!res?.ok) throw new Error(res?.error ?? 'falha ao gerar offer');

    renderQr(el.qrOffer, res.offer);
    el.etapaOffer.hidden = false;
    el.etapaAnswer.hidden = false;
    setStatus('Aguardando o celular…');

    // 3) Começa a ler o QR de resposta do celular.
    iniciarScan();
  } catch (e) {
    mostrarErro(String(e?.message ?? e));
    mostrarDesconectado();
  } finally {
    el.btnParear.disabled = false;
  }
}

async function encerrar() {
  await chrome.runtime.sendMessage({ cmd: IPC.PAIR_RESET }).catch(() => {});
  mostrarDesconectado();
}

// Eventos de status vindos do offscreen/service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd !== IPC.STATE_CHANGED) return;
  if (msg.state === 'connected') mostrarConectado();
  else if (msg.state === 'disconnected') mostrarDesconectado();
  else if (msg.state === 'connecting') setStatus('Conectando…');
});

el.btnParear.addEventListener('click', parear);
el.btnEncerrar.addEventListener('click', encerrar);

// Ao abrir o popup, pergunta o estado atual.
chrome.runtime.sendMessage({ cmd: IPC.GET_STATE }).then((r) => {
  if (r?.state === 'connected') mostrarConectado();
  else mostrarDesconectado();
});
