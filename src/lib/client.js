// Cliente de transporte (roda no offscreen) — ver docs/protocolo.md.
// Faz short-poll http:// no servidor do celular. Todo corpo é um envelope
// AES-256-GCM (crypto.js). O celular ORIGINA os comandos; aqui recebemos,
// executamos (via callback) e devolvemos ACK.

import { importKey, seal, open, keyFromBase64url } from './crypto.js';

const IDLE_MS = 1000; // intervalo entre polls quando ocioso

export class CommandClient {
  constructor({ ip, port, keyB64, onState, onCommand }) {
    this.base = `http://${ip}:${port}`;
    this.keyB64 = keyB64;
    this.onState = onState; // (connected: boolean, detail?: string)
    this.onCommand = onCommand; // async (cmd) => { ok, error }
    this.key = null;
    this.running = false;
    this.outSeq = 0;
    this.lastInSeq = 0;
    this.lastError = null;
  }

  async start() {
    this.key = await importKey(keyFromBase64url(this.keyB64));
    this.running = true;
    console.log('[CdA] cliente iniciado ->', this.base);
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
      // se o ACK falhar, segue o loop
    }
  }

  async _loop() {
    let backoff = IDLE_MS;
    while (this.running) {
      try {
        const res = await this._send('/poll', { type: 'poll' });
        if (res.status === 200) {
          this.lastError = null;
          this.onState?.(true);
          backoff = IDLE_MS;
          const msg = await open(this.key, await res.text());
          const seq = typeof msg.seq === 'number' ? msg.seq : -1;
          if (seq > this.lastInSeq) {
            this.lastInSeq = seq;
            if (msg.type && msg.type !== 'pong') {
              await this._handleCommand(msg);
              continue; // busca o próximo comando imediatamente
            }
          }
          await this._sleep(IDLE_MS);
        } else {
          this.lastError = `HTTP ${res.status}` + (res.status === 401 ? ' (chave/permissão)' : '');
          console.warn('[CdA] poll', this.lastError);
          this.onState?.(false, this.lastError);
          await this._sleep(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
      } catch (e) {
        this.lastError = String(e?.message ?? e);
        console.warn('[CdA] poll falhou:', this.lastError);
        this.onState?.(false, this.lastError);
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }
}
