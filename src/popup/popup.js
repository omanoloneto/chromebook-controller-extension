// Lógica do popup — orquestra o pareamento e mostra o status.
// Esboço — nada implementado ainda.

// import { ChromebookPeer } from '../lib/webrtc.js';
// import { buildOfferQrPayload, scanAnswerQr } from '../pairing/pairing.js';

const btnParear = document.getElementById('btn-parear');
const status = document.getElementById('status');

btnParear?.addEventListener('click', async () => {
  // Fluxo de pareamento (ver docs/protocolo.md):
  //  1. peer.createOffer() -> gerar QR #1 e exibir (#etapa-offer)
  //  2. scanAnswerQr() -> ler QR #2 com a câmera (#etapa-answer)
  //  3. peer.acceptAnswer(answer) -> conectado
  //  4. status.textContent = 'Conectado'
  status.textContent = 'Pareamento ainda não implementado';
});
