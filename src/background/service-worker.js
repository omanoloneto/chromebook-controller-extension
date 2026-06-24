// Service worker (Manifest V3) — núcleo da extensão.
//
// Responsabilidades (a implementar):
//  - Manter a RTCPeerConnection / RTCDataChannel com o celular (app).
//  - Tratar mensagens recebidas conforme docs/protocolo.md.
//  - Executar comandos no navegador (ex.: open_url -> chrome.tabs).
//  - Enviar ACK para cada comando.
//
// ⚠️ No MV3 o service worker pode hibernar quando ocioso. A estratégia de
// keepalive (ping/pong) está descrita em docs/protocolo.md e docs/arquitetura.md.

import { handleMessage } from '../lib/protocol.js';

// TODO: instanciar/recuperar a conexão WebRTC ao reativar o worker.
// import { ChromebookPeer } from '../lib/webrtc.js';

chrome.runtime.onInstalled.addListener(() => {
  // TODO: estado inicial, abrir tela de pareamento se ainda não pareado.
  console.log('[Controle de Aula] extensão instalada.');
});

// Esboço do roteamento de uma mensagem recebida pelo DataChannel.
// `raw` é a string JSON definida em docs/protocolo.md.
export async function onDataChannelMessage(raw, reply) {
  // TODO: parse + validação de versão (campo "v").
  // TODO: chamar handleMessage e devolver o ACK por `reply`.
  return handleMessage(raw, reply);
}
