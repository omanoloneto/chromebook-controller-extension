// Página de pareamento (roda numa ABA, não no popup).
// Motivo: getUserMedia (câmera) no popup falha — o prompt de permissão tira o
// foco e fecha o popup, cancelando a permissão. Numa aba normal funciona e a
// permissão fica salva para a origem da extensão.

import { IPC } from '../lib/ipc.js';

const el = {
  status: document.getElementById('status'),
  erro: document.getElementById('erro'),
  etapaOffer: document.getElementById('etapa-offer'),
  etapaAnswer: document.getElementById('etapa-answer'),
  etapaOk: document.getElementById('etapa-ok'),
  qrOffer: document.getElementById('qr-offer'),
  camera: document.getElementById('camera'),
  btnFechar: document.getElementById('btn-fechar'),
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
  el.btnFechar.hidden = false;
  setStatus('Conectado');
}

function renderQr(container, texto) {
  const qr = qrcode(0, 'L'); // tipo automático, nível L (maior capacidade)
  qr.addData(texto);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
}

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
  if (res?.ok) return; // sucesso chega pelo evento STATE_CHANGED
  mostrarErro('QR inválido: ' + (res?.error ?? 'desconhecido') + '. Tentando de novo…');
  iniciarScan();
}

async function iniciar() {
  mostrarErro('');
  try {
    // 1) Câmera (e permissão) ANTES do offer: faz o Chrome expor o IP real da
    //    LAN (sem mDNS), essencial para conectar com o app.
    setStatus('Pedindo acesso à câmera…');
    await abrirCamera();

    // 2) Pede o offer ao offscreen (via service worker) e mostra o QR #1.
    setStatus('Gerando código…');
    const res = await chrome.runtime.sendMessage({ cmd: IPC.PAIR_START });
    if (!res?.ok) throw new Error(res?.error ?? 'falha ao gerar offer');

    renderQr(el.qrOffer, res.offer);
    el.etapaOffer.hidden = false;
    el.etapaAnswer.hidden = false;
    setStatus('Aguardando o celular…');

    // 3) Lê o QR de resposta do celular.
    iniciarScan();
  } catch (e) {
    const msg = String(e?.name === 'NotAllowedError'
      ? 'Permissão de câmera negada. Clique no cadeado da aba e permita a câmera.'
      : e?.message ?? e);
    mostrarErro(msg);
    setStatus('Falhou');
  }
}

// Status vindo do offscreen/service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd !== IPC.STATE_CHANGED) return;
  if (msg.state === 'connected') mostrarConectado();
});

el.btnFechar.addEventListener('click', () => window.close());

iniciar();
