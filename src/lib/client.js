// Cliente de transporte (roda no offscreen) — ver docs/protocolo.md.
// Faz long-poll http:// no servidor do celular. Todo corpo é um envelope
// AES-256-GCM (crypto.js). O celular ORIGINA os comandos; aqui recebemos,
// executamos (via callback) e devolvemos ACK.

import { importKey, seal, open, keyFromBase64url } from './crypto.js';

export class CommandClient {
  constructor({ ip, port, keyB64, onState, onCommand }) {
    this.base = `http://${ip}:${port}`;
    this.keyB64 = keyB64;
    this.onState = onState; // (connected: boolean)
    this.onCommand = onCommand; // async (cmd) => { ok, error }
    this.key = null;
    this.running = false;
    this.outSeq = 0;
    this.lastInSeq = 0;
  }

  async start() {
    this.key = await importKey(keyFromBase64url(this.keyB64));
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async _send(path, obj) {
    obj.seq = ++this.outSeq;
    obj.ts = Date.now();
    const body = await seal(this.key, obj);
    return fetch(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
      // Dica de Private Network Access (ignorada onde não houver suporte).
      targetAddressSpace: 'local',
    });
  }

  async _handleCommand(cmd) {
    let ack;
    try {
      ack = await this.onCommand?.(cmd);
    } catch (e) {
      ack = { ok: false, error: String(e?.message ?? e) };
    }
    try {
      await this._send('/ack', {
        type: 'ack',
        id: cmd.id,
        ok: !!ack?.ok,
        error: ack?.error ?? null,
      });
    } catch {
      // se o ACK falhar, o servidor reenvia/ignora; não derruba o loop
    }
  }

  async _loop() {
    let backoff = 500;
    while (this.running) {
      try {
        const res = await this._send('/poll', { type: 'poll' });
        if (res.status === 200) {
          this.onState?.(true);
          backoff = 500;
          const msg = await open(this.key, await res.text());
          const seq = typeof msg.seq === 'number' ? msg.seq : -1;
          if (seq > this.lastInSeq) {
            this.lastInSeq = seq;
            if (msg.type && msg.type !== 'pong') {
              await this._handleCommand(msg);
            }
          }
        } else if (res.status === 401) {
          // credenciais inválidas/expiradas: para e sinaliza desconectado
          this.onState?.(false);
          this.running = false;
          break;
        } else {
          this.onState?.(false);
          await this._sleep(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
      } catch {
        // servidor fora do ar / rede caiu: tenta de novo com backoff
        this.onState?.(false);
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }
}
