// Conexão WebRTC do lado do Chromebook (papel "offerer").
// Ver o handshake por QR code em docs/protocolo.md.
//
// Esboço — nada implementado ainda.

// Sem servidor de sinalização: usamos ICE "non-trickle" (juntar todos os
// candidatos antes de gerar o QR). Para rede local, host candidates bastam,
// então normalmente não é preciso STUN/TURN.
const RTC_CONFIG = { iceServers: [] };

export class ChromebookPeer {
  constructor() {
    this.pc = null;
    this.channel = null;
    this.onMessage = null; // callback(raw)
  }

  // 1) Cria a conexão e o DataChannel, gera o OFFER já com candidatos.
  // Retorna a string (SDP) que vai dentro do QR #1.
  async createOffer() {
    // TODO: new RTCPeerConnection(RTC_CONFIG)
    // TODO: this.pc.createDataChannel('controle')
    // TODO: createOffer + setLocalDescription
    // TODO: aguardar iceGatheringState === 'complete'
    // TODO: retornar this.pc.localDescription
    throw new Error('não implementado');
  }

  // 2) Recebe o ANSWER lido do QR #2 e finaliza a conexão.
  async acceptAnswer(/* answerSdp */) {
    // TODO: this.pc.setRemoteDescription(answer)
    throw new Error('não implementado');
  }

  send(/* str */) {
    // TODO: this.channel.send(str)
  }
}
