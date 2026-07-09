// Cliente de transporte via Firebase RTDB (roda no offscreen) — protocolo v4.
// Substitui o antigo short-poll HTTP (client.js). Um único stream SSE em
// /devices/{deviceId} entrega bind/cmd/state; report e presença sobem por REST.
// `run()` resolve quando o vínculo cai ('unbound'), o vínculo no banco diverge
// do pinado ('foreign_bind') ou `stop()` é chamado ('stopped').

import { importKey, seal, open } from './crypto.js';
import { ReplayGuard } from './replay.js';
import { MessageType, PROTOCOL_VERSION } from './protocol.js';

const PRESENCE_MS = 25000; // heartbeat de presença (app considera offline >60s)
const REPORT_TICK_MS = 5000; // frequência de checagem do snapshot de abas
const REPORT_HEARTBEAT_MS = 60000; // reenvio mesmo sem mudança
const CMD_MAX_AGE_MS = 12 * 3600000; // comando de fila mais velho que isso morre
const MAX_ACKS = 20; // poda dos próprios acks não consumidos

export class CloudClient {
  /// `fb`: FirebaseSession autenticada. `teacher`: {teacherUid, teacherPub}
  /// pinados (TOFU). `loadReplay`/`saveReplay`: persistem o estado anti-replay
  /// {cmd:{sid,seq}, rulesRev, wallpaperHash} — obrigatório: reconexão SSE
  /// re-entrega o nó inteiro e re-executaria comandos.
  constructor({ fb, deviceId, sessionKey, teacher, onCommand, getReport, onState, loadReplay, saveReplay }) {
    this.fb = fb;
    this.base = `/devices/${deviceId}`;
    this.teacher = teacher;
    this.sessionKeyBytes = sessionKey;
    this.onCommand = onCommand; // async (cmd) => {ok, error} (dispatcher p/ o SW)
    this.getReport = getReport; // async () => report | null
    this.onState = onState; // (conectado: bool, detalhe?: string)
    this.loadReplay = loadReplay;
    this.saveReplay = saveReplay;

    this.key = null;
    this.running = false;
    this.sid = 0;
    this.outSeq = 0;
    this.cmdGuard = null;
    this.rulesRev = 0;
    this.wallpaperHash = null;

    this._resolve = null;
    this._stream = null;
    this._presenceTimer = null;
    this._reportTimer = null;
    this._chain = Promise.resolve(); // serializa o processamento de comandos
    this._lastReportFingerprint = null;
    this._lastReportSentTs = 0;
  }

  stop() {
    this._finish('stopped');
  }

  _finish(reason) {
    if (!this.running) return;
    this.running = false;
    clearInterval(this._presenceTimer);
    clearInterval(this._reportTimer);
    this._stream?.close();
    this._resolve?.(reason);
  }

  async _persistReplay() {
    try {
      await this.saveReplay?.({
        cmd: this.cmdGuard.toJSON(),
        rulesRev: this.rulesRev,
        wallpaperHash: this.wallpaperHash,
      });
    } catch {
      // best-effort; o pior caso é reprocessar um comando idempotente
    }
  }

  /// Sela um objeto com o cabeçalho v4 {sid, seq, ts}.
  _seal(obj) {
    return seal(this.key, { sid: this.sid, seq: ++this.outSeq, ts: Date.now(), ...obj });
  }

  // ---- Entrada (stream) -------------------------------------------------------

  _route(path, data) {
    if (path === '/') {
      const node = data ?? {};
      this._routeBind(node.bind ?? null);
      if (node.state?.rules) this._enqueue(() => this._applyRules(node.state.rules));
      if (node.state?.wallpaper) this._enqueue(() => this._applyWallpaper(node.state.wallpaper));
      for (const [pushId, env] of Object.entries(node.cmd ?? {}).sort()) {
        if (typeof env === 'string') this._enqueue(() => this._handleCmd(pushId, env));
      }
      return;
    }
    if (path === '/bind') return this._routeBind(data);
    if (path === '/state/rules' && typeof data === 'string') {
      return this._enqueue(() => this._applyRules(data));
    }
    if (path === '/state/wallpaper' && typeof data === 'string') {
      return this._enqueue(() => this._applyWallpaper(data));
    }
    if (path === '/state' && data) {
      if (typeof data.rules === 'string') this._enqueue(() => this._applyRules(data.rules));
      if (typeof data.wallpaper === 'string') {
        this._enqueue(() => this._applyWallpaper(data.wallpaper));
      }
      return;
    }
    if (path.startsWith('/cmd/')) {
      const pushId = path.slice('/cmd/'.length);
      if (typeof data === 'string') this._enqueue(() => this._handleCmd(pushId, data));
      return; // data null = eco do nosso delete
    }
    if (path === '/cmd' && data) {
      for (const [pushId, env] of Object.entries(data).sort()) {
        if (typeof env === 'string') this._enqueue(() => this._handleCmd(pushId, env));
      }
    }
    // /meta, /pairing, /report, /presence, /ack: ecos das nossas escritas.
  }

  _routeBind(bind) {
    if (!bind) return this._finish('unbound');
    if (bind.teacherPub !== this.teacher.teacherPub) return this._finish('foreign_bind');
  }

  _enqueue(fn) {
    this._chain = this._chain.then(() => (this.running ? fn() : null)).catch((e) => {
      console.warn('[CdA] processamento falhou:', e?.message ?? e);
    });
  }

  // ---- Comandos de fila (cmd/) --------------------------------------------------

  async _handleCmd(pushId, envelope) {
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      // Ilegível com a nossa chave (lixo/raça de re-pareamento): consome.
      await this.fb.delete(`${this.base}/cmd/${pushId}`).catch(() => {});
      return;
    }
    const fresco = this.cmdGuard.accept({
      sid: Number(msg.sid),
      seq: Number(msg.seq),
      ts: Number(msg.ts),
      nowMs: Date.now(),
    });
    if (!fresco) {
      // Replay (reconexão SSE re-entregou) ou velho demais: só limpa.
      await this.fb.delete(`${this.base}/cmd/${pushId}`).catch(() => {});
      return;
    }
    let ack;
    try {
      ack = await this.onCommand?.(msg);
    } catch (e) {
      ack = { ok: false, error: String(e?.message ?? e) };
    }
    try {
      const env = await this._seal({
        v: PROTOCOL_VERSION,
        type: MessageType.ACK,
        id: msg.id,
        ok: !!ack?.ok,
        error: ack?.error ?? null,
      });
      await this.fb.put(`${this.base}/ack/${pushId}`, env);
    } catch {
      // ack é best-effort
    }
    await this.fb.delete(`${this.base}/cmd/${pushId}`).catch(() => {});
    await this._persistReplay();
    this._pruneAcks();
  }

  async _pruneAcks() {
    try {
      const acks = await this.fb.get(`${this.base}/ack`);
      const ids = Object.keys(acks ?? {}).sort(); // pushIds são cronológicos
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ACKS))) {
        await this.fb.delete(`${this.base}/ack/${id}`);
      }
    } catch {
      // poda é best-effort
    }
  }

  // ---- Comandos de estado (state/) ---------------------------------------------

  async _applyRules(envelope) {
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return;
    }
    if (msg.type !== MessageType.SET_RULES) return;
    const rev = Number(msg.payload?.rev) || 0;
    if (rev <= this.rulesRev) return; // snapshot já aplicado (ou mais velho)
    const ack = await this.onCommand?.(msg);
    if (ack?.ok) {
      this.rulesRev = rev;
      await this._persistReplay();
    }
  }

  async _applyWallpaper(envelope) {
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return;
    }
    if (msg.type !== MessageType.SET_WALLPAPER) return;
    const hash = String(msg.payload?.hash ?? '');
    if (!hash || hash === this.wallpaperHash) return;
    // O comando só carrega o hash; o blob (claro) mora em /wallpapers/{teacherUid}.
    let blob;
    try {
      blob = await this.fb.get(`/wallpapers/${this.teacher.teacherUid}`);
    } catch (e) {
      console.warn('[CdA] blob do wallpaper inacessível:', e?.message);
      return;
    }
    if (!blob || blob.hash !== hash || typeof blob.jpeg !== 'string') return;
    const ack = await this.onCommand?.({
      type: MessageType.SET_WALLPAPER,
      id: msg.id,
      payload: { hash, jpegB64: blob.jpeg },
    });
    if (ack?.ok || ack?.error === 'so_chromeos') {
      // Fora do ChromeOS marca como aplicado — não adianta re-tentar.
      this.wallpaperHash = hash;
      await this._persistReplay();
    }
  }

  // ---- Saída (report + presença) -------------------------------------------------

  async _presence() {
    try {
      await this.fb.put(`${this.base}/presence`, { lastSeen: this.fb.serverTimestamp() });
      this.onState?.(true);
    } catch (e) {
      this.onState?.(false, String(e?.message ?? e));
    }
  }

  // Report sobe quando o estado mudou (fingerprint) ou a cada 60s.
  async _maybeReport() {
    if (!this.getReport) return;
    let report;
    try {
      report = await this.getReport();
    } catch {
      return;
    }
    if (!report) return;
    const fingerprint =
      JSON.stringify(report.tabs?.map((t) => [t.url, t.active]) ?? []) +
      '|' +
      (report.events?.[report.events.length - 1]?.ts ?? 0);
    const agora = Date.now();
    if (
      fingerprint === this._lastReportFingerprint &&
      agora - this._lastReportSentTs < REPORT_HEARTBEAT_MS
    ) {
      return;
    }
    try {
      const env = await this._seal({ type: MessageType.TAB_REPORT, ...report });
      await this.fb.put(`${this.base}/report`, { env, ts: this.fb.serverTimestamp() });
      this._lastReportFingerprint = fingerprint;
      this._lastReportSentTs = agora;
    } catch {
      // retenta no próximo tick
    }
  }

  // ---- Loop -----------------------------------------------------------------------

  async run() {
    this.key = await importKey(this.sessionKeyBytes);
    this.sid = Date.now(); // época nova a cada vida do offscreen
    this.outSeq = 0;
    const saved = (await this.loadReplay?.()) ?? {};
    this.cmdGuard = ReplayGuard.from(saved.cmd, { maxAgeMs: CMD_MAX_AGE_MS });
    this.rulesRev = Number(saved.rulesRev) || 0;
    this.wallpaperHash = saved.wallpaperHash ?? null;

    this.running = true;
    return new Promise((resolve) => {
      this._resolve = resolve;

      this._stream = this.fb.stream(this.base, {
        onEvent: ({ path, data }) => this._route(path, data),
        onDown: (motivo) => this.onState?.(false, motivo),
      });

      this._presence();
      this._presenceTimer = setInterval(() => this._presence(), PRESENCE_MS);
      this._reportTimer = setInterval(() => this._maybeReport(), REPORT_TICK_MS);
    });
  }
}
