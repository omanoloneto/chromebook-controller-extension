// Cliente de transporte (roda no offscreen) — ver docs/protocolo.md.
// Short-poll cifrado (AES-256-GCM) com a chave de sessão derivada do handshake.
// `run()` resolve quando a conexão cai (o orquestrador então redescobre).

import { importKey, seal, open } from './crypto.js';

const IDLE_MS = 1000;

export class CommandClient {
  constructor({ ip, port, deviceId, sessionKey, onState, onCommand }) {
    this.base = `http://${ip}:${port}`;
    this.deviceId = deviceId;
    this.sessionKeyBytes = sessionKey; // Uint8Array(32)
    this.onState = onState;
    this.onCommand = onCommand;
    this.key = null;
    this.running = false;
    this.outSeq = 0;
    this.lastInSeq = 0;
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
    return fetch(`${this.base}${path}?id=${encodeURIComponent(this.deviceId)}`, {
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
      // segue o loop
    }
  }

  // Retorna 'rebind' (sessão sumiu no servidor), 'lost' (servidor fora) ou 'stopped'.
  async run() {
    this.key = await importKey(this.sessionKeyBytes);
    this.running = true;
    let fails = 0;
    while (this.running) {
      try {
        const res = await this._send('/poll', { type: 'poll' });
        if (res.status === 200) {
          this.onState?.(true);
          fails = 0;
          const msg = await open(this.key, await res.text());
          const seq = typeof msg.seq === 'number' ? msg.seq : -1;
          if (seq > this.lastInSeq) {
            this.lastInSeq = seq;
            if (msg.type && msg.type !== 'pong') {
              await this._handleCommand(msg);
              continue;
            }
          }
          await this._sleep(IDLE_MS);
        } else if (res.status === 404) {
          return 'rebind'; // servidor não conhece esta sessão
        } else {
          this.onState?.(false, `HTTP ${res.status}`);
          if (++fails > 5) return 'lost';
          await this._sleep(1000);
        }
      } catch (e) {
        this.onState?.(false, String(e?.message ?? e));
        if (++fails > 3) return 'lost';
        await this._sleep(1000);
      }
    }
    return 'stopped';
  }
}
