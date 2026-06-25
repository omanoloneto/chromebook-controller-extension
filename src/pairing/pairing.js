// Aba de pareamento (roda numa ABA, porque a câmera não funciona no popup).
// Agora ela SÓ LÊ o QR do celular, pede permissão para o IP e salva o pareamento.

import { IPC } from '../lib/ipc.js';
import { parsePairingQr } from './qr.js';

const el = {
  status: document.getElementById('status'),
  erro: document.getElementById('erro'),
  etapaCamera: document.getElementById('etapa-camera'),
  etapaConfirmar: document.getElementById('etapa-confirmar'),
  etapaOk: document.getElementById('etapa-ok'),
  alvo: document.getElementById('alvo'),
  camera: document.getElementById('camera'),
  btnConectar: document.getElementById('btn-conectar'),
  btnFechar: document.getElementById('btn-fechar'),
};

let stream = null;
let detector = null;
let scanning = false;
let creds = null; // { ip, port, key, name }
let tentando = false; // true depois que o usuário clica "Conectar"

function mostrarErro(t) {
  el.erro.textContent = t;
  el.erro.hidden = !t;
}
function setStatus(t) {
  el.status.textContent = t;
}
function pararCamera() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  el.camera.srcObject = null;
}

async function abrirCamera() {
  if (!('BarcodeDetector' in window)) {
    throw new Error('Este Chrome não tem leitor de QR. Atualize o Chrome/ChromeOS.');
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
        return aoLerQr(codes[0].rawValue);
      }
    } catch {
      // quadro sem QR
    }
    setTimeout(loop, 200);
  };
  loop();
}

function aoLerQr(texto) {
  try {
    creds = parsePairingQr(texto);
  } catch (e) {
    mostrarErro('QR inválido (' + (e?.message ?? e) + '). Continue apontando.');
    iniciarScan(); // tenta de novo com a mesma câmera
    return;
  }
  pararCamera();
  mostrarErro('');
  el.alvo.textContent = `${creds.ip}:${creds.port}`;
  el.etapaCamera.hidden = true;
  el.etapaConfirmar.hidden = false;
  setStatus('QR lido');
}

// Clique = gesto do usuário (necessário para pedir a permissão do host).
el.btnConectar.addEventListener('click', async () => {
  if (!creds) return;
  mostrarErro('');
  el.btnConectar.disabled = true;
  try {
    const granted = await chrome.permissions.request({
      origins: [`http://${creds.ip}/*`],
    });
    if (!granted) throw new Error('Permissão de rede local negada.');

    setStatus('Conectando…');
    tentando = true;
    const res = await chrome.runtime.sendMessage({
      cmd: IPC.PAIR_SAVE,
      ip: creds.ip,
      port: creds.port,
      key: creds.key,
      name: creds.name,
    });
    if (!res?.ok) throw new Error(res?.error ?? 'falha ao iniciar');
    // O sucesso final chega pelo evento STATE_CHANGED ('connected').
  } catch (e) {
    mostrarErro(String(e?.message ?? e));
  } finally {
    el.btnConectar.disabled = false;
  }
});

el.btnFechar.addEventListener('click', () => window.close());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd !== IPC.STATE_CHANGED) return;
  if (msg.state === 'connected') {
    el.etapaConfirmar.hidden = true;
    el.etapaOk.hidden = false;
    el.btnFechar.hidden = false;
    mostrarErro('');
    setStatus('Conectado');
  } else if (tentando) {
    // ainda tentando conectar: mostra o motivo do último erro, se houver
    setStatus('Tentando conectar ao celular…');
    if (msg.detail) {
      mostrarErro(
        'Sem resposta do celular (' + msg.detail + '). ' +
          'Confira: mesma Wi-Fi, app aberto, e teste abrir http://' +
          (creds ? creds.ip + ':' + creds.port : '<ip>') +
          '/ numa aba (deve responder "controle-de-aula").',
      );
    }
  }
});

// Início.
(async () => {
  try {
    setStatus('Pedindo acesso à câmera…');
    el.etapaCamera.hidden = false;
    await abrirCamera();
    setStatus('Procurando o QR do celular…');
    iniciarScan();
  } catch (e) {
    el.etapaCamera.hidden = true;
    mostrarErro(String(e?.message ?? e));
    setStatus('Falhou');
  }
})();
