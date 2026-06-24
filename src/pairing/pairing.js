// Pareamento — geração do QR #1 (offer) e leitura do QR #2 (answer).
// Ver docs/protocolo.md, seção "Pareamento".
//
// Esboço — nada implementado ainda.
//
// Sugestão de bibliotecas (a definir, mantendo a extensão sem etapa de build
// sempre que possível): um gerador de QR e um leitor via getUserMedia
// (BarcodeDetector, disponível no Chrome, dispensa biblioteca externa).

// Gera o conteúdo do QR #1 a partir do SDP do offer.
export function buildOfferQrPayload(/* offerSdp, nome */) {
  // TODO: montar { v, role: 'offer', sdp, name }
  // TODO: comprimir (deflate + base64url) para caber no QR
  throw new Error('não implementado');
}

// Lê o QR #2 (answer) usando a câmera do Chromebook.
export async function scanAnswerQr() {
  // TODO: getUserMedia({ video: true })
  // TODO: usar BarcodeDetector para ler o QR
  // TODO: descomprimir e retornar { v, role: 'answer', sdp }
  throw new Error('não implementado');
}
