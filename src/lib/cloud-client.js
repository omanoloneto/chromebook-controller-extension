// Cliente de transporte via Firebase RTDB (roda no offscreen) — protocolo v4.
// Substitui o antigo short-poll HTTP (client.js). Um único stream SSE em
// /devices/{deviceId} entrega bind/cmd/state; report e presença sobem por REST.
// `run()` resolve quando o vínculo cai ('unbound'), o vínculo no banco diverge
// do pinado ('foreign_bind') ou `stop()` é chamado ('stopped').

import { importKey, seal, open } from './crypto.js';
import { ReplayGuard } from './replay.js';
import {
  MessageType,
  PROTOCOL_VERSION,
  parseClassView,
  limparLock,
  limparExam,
  limparMonitor,
  prazoLocal,
  makeAplicado,
  TRAVA_TETO_MS,
  PROVA_TETO_MS,
  MONITOR_TETO_MS,
  MONITOR_JANELA_TS_MS,
  MAX_APLICADO_ACKS,
} from './protocol.js';
import { novoId, idValido, limparPayloadUp, chavesParaPodar, UP_MAX_ENVELOPE } from './up.js';

const PRESENCE_MS = 25000; // heartbeat de presença (app considera offline >60s)
const REPORT_TICK_MS = 5000; // frequência de checagem do snapshot de abas
const REPORT_HEARTBEAT_MS = 60000; // reenvio mesmo sem mudança
const REPORT_LOGO_MS = 300; // relatório "logo depois" de aplicar estado/responder comando
const CMD_MAX_AGE_MS = 12 * 3600000; // comando de fila mais velho que isso morre
const MAX_ACKS = 20; // poda dos próprios acks não consumidos
// Trava/prova LIGADA num envelope mais velho que isso não liga (ex.: o mesmo
// professor re-pareou o PC no dia seguinte: o guard de rev zerou e o state/
// antigo ainda está no banco). A mesma janela do canal cmd.
const ESTADO_LIGADO_IDADE_MAX_MS = 12 * 3600000;
const UP_PODA_MS = 10 * 60 * 1000; // poda periódica da fila up
const LATERAL_DESLIGADO_MS = 10 * 60 * 1000; // 401/403 persistente desliga o recurso
const THUMB_INTERVALO_MS = 10000;
const THUMB_MAX_ENV = 262144; // rules: env < 256 KiB
const THUMB_MOTIVOS = ['sem_sessao', 'sem_permissao', 'aba_protegida', 'falhou'];

export class CloudClient {
  /// `fb`: FirebaseSession autenticada. `teacher`: {teacherUid, teacherPub}
  /// pinados (TOFU). `loadReplay`/`saveReplay`: persistem o estado anti-replay
  /// {cmd:{sid,seq}, rulesRev, wallpaperHash, classviewRev} — obrigatório:
  /// reconexão SSE re-entrega o nó inteiro e re-executaria comandos.
  /// `capturarThumb`: async () => {jpegB64, w, h} | {motivo} (grade ao vivo;
  /// o offscreen pede ao SW). `agora`/`agoraMono`: relógios injetáveis (teste).
  constructor({
    fb,
    deviceId,
    sessionKey,
    teacher,
    onCommand,
    getReport,
    onState,
    loadReplay,
    saveReplay,
    capturarThumb,
    agora = () => Date.now(),
    agoraMono = () => performance.now(),
  }) {
    this.fb = fb;
    this.deviceId = deviceId;
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
    this.classviewRev = 0;
    this.unitRev = 0;
    this.lockRev = 0;
    this.examRev = 0;
    this.monitorRev = 0;
    this.capturarThumb = capturarThumb;
    this.agora = agora;
    this.agoraMono = agoraMono;
    this.clockOffset = null; // relógio do servidor − local (pela resposta da presença)
    this.acksAplicados = []; // últimos acks (aplicado.acks do relatório)
    this._upDesligadoAte = 0; // mono: 401/403 persistente no up
    this._podando = false;
    this._upPodaTimer = null;
    this._relatorioTimer = null;
    // Grade ao vivo: prazo no relógio MONOTÔNICO deste PC.
    this._thumb = { prazoMono: 0, gravou: false, marcador: null, desligado: false };
    this._thumbTimer = null;
    this._thumbTick = null;

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

  /// Idade (ms) desde o último evento recebido no stream (put/patch/keep-alive).
  /// Grande = stream provavelmente morto (zumbi, ex.: socket derrubado no
  /// suspend). Infinity se ainda não há stream. Usado pelo heartbeat p/ o SW.
  streamAgeMs() {
    const t = this._stream?._lastEventAt ?? 0;
    return t ? Date.now() - t : Infinity;
  }

  _finish(reason) {
    if (!this.running) return;
    this.running = false;
    clearInterval(this._presenceTimer);
    clearInterval(this._reportTimer);
    clearInterval(this._upPodaTimer);
    clearTimeout(this._relatorioTimer);
    clearInterval(this._thumbTimer);
    this._thumbTimer = null;
    this._stream?.close();
    this._resolve?.(reason);
  }

  async _persistReplay() {
    try {
      await this.saveReplay?.({
        cmd: this.cmdGuard.toJSON(),
        rulesRev: this.rulesRev,
        wallpaperHash: this.wallpaperHash,
        classviewRev: this.classviewRev,
        unitRev: this.unitRev,
        lockRev: this.lockRev,
        examRev: this.examRev,
        monitorRev: this.monitorRev,
      });
    } catch {
      // best-effort; o pior caso é reprocessar um comando idempotente
    }
  }

  /// Sela um objeto com o cabeçalho v4 {sid, seq, ts}.
  _seal(obj) {
    return seal(this.key, { sid: this.sid, seq: ++this.outSeq, ts: Date.now(), ...obj });
  }

  /// Relógio deste PC corrigido pelo do servidor (resposta da presença).
  /// Só serve à janela de `ts` do monitor; prazos usam `ate − env.ts`.
  agoraCorrigido() {
    return this.agora() + (this.clockOffset ?? 0);
  }

  // ---- Entrada (stream) -------------------------------------------------------

  _route(path, data, type = 'put') {
    if (type === 'patch') {
      // patch = atualização dos filhos citados (o resto não muda): equivale a
      // um put em cada caminho. Sem isto, um patch em '/' ou '/state' seria lido
      // como nó inteiro (sem bind = "desvinculado"; sem classview = limpa).
      for (const [k, v] of Object.entries(data ?? {})) {
        this._route(`${path === '/' ? '' : path}/${k}`, v, 'put');
      }
      return;
    }
    if (path === '/') {
      const node = data ?? {};
      this._routeBind(node.bind ?? null);
      if (node.state?.rules) this._enqueue(() => this._applyRules(node.state.rules));
      if (node.state?.wallpaper) this._enqueue(() => this._applyWallpaper(node.state.wallpaper));
      if (node.state?.unit) this._enqueue(() => this._applyUnit(node.state.unit));
      if (typeof node.state?.lock === 'string') this._enqueue(() => this._applyLock(node.state.lock));
      if (typeof node.state?.exam === 'string') this._enqueue(() => this._applyExam(node.state.exam));
      // monitor ausente = ninguém olhando a grade.
      this._enqueue(() => this._applyMonitor(node.state?.monitor ?? null));
      // classview: ausente = null = limpa (PC que deixou de ser telão offline
      // se corrige aqui, no put completo da reconexão).
      this._enqueue(() => this._applyClassView(node.state?.classview ?? null));
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
    if (path === '/state/classview') {
      // string aplica; null é o delete do app (desmarcou o telão) — limpa.
      return this._enqueue(() => this._applyClassView(typeof data === 'string' ? data : null));
    }
    if (path === '/state/unit' && typeof data === 'string') {
      return this._enqueue(() => this._applyUnit(data));
    }
    // Trava e prova: envelope nulo/ilegível NÃO muda nada (destravar é on:false).
    if (path === '/state/lock' && typeof data === 'string') {
      return this._enqueue(() => this._applyLock(data));
    }
    if (path === '/state/exam' && typeof data === 'string') {
      return this._enqueue(() => this._applyExam(data));
    }
    if (path === '/state/monitor') {
      // null = o professor fechou a grade: para na hora.
      return this._enqueue(() => this._applyMonitor(typeof data === 'string' ? data : null));
    }
    if (path === '/state') {
      const s = data ?? {};
      if (typeof s.rules === 'string') this._enqueue(() => this._applyRules(s.rules));
      if (typeof s.wallpaper === 'string') {
        this._enqueue(() => this._applyWallpaper(s.wallpaper));
      }
      if (typeof s.unit === 'string') this._enqueue(() => this._applyUnit(s.unit));
      if (typeof s.lock === 'string') this._enqueue(() => this._applyLock(s.lock));
      if (typeof s.exam === 'string') this._enqueue(() => this._applyExam(s.exam));
      this._enqueue(() => this._applyMonitor(typeof s.monitor === 'string' ? s.monitor : null));
      this._enqueue(() => this._applyClassView(s.classview ?? null));
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
      console.warn('[CdA] executor lançou:', e?.message ?? e);
      ack = { ok: false, error: 'executor_falhou' };
    }
    // Foto da câmera (capture_camera): vai num nó próprio /snapshot cifrado —
    // a imagem é grande demais para o ack. O ack segue só com ok/erro.
    if (ack?.jpegB64) {
      try {
        const snap = await this._seal({
          v: PROTOCOL_VERSION,
          type: MessageType.CAMERA_SNAPSHOT,
          id: msg.id,
          jpegB64: ack.jpegB64,
        });
        await this.fb.put(`${this.base}/snapshot`, { env: snap, ts: this.fb.serverTimestamp() });
      } catch {
        // best-effort
      }
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
    this._registrarAck(msg.id, ack);
    this._pruneAcks();
  }

  /// Guarda o ack para o `aplicado.acks` do relatório (o app ≤ 0.19 apaga todo
  /// ack; o relatório confirma mesmo assim) e pede relatório logo.
  _registrarAck(id, ack) {
    if (typeof id !== 'string' || !id) return;
    this.acksAplicados.push({ id, ok: !!ack?.ok, error: ack?.error ?? null });
    if (this.acksAplicados.length > MAX_APLICADO_ACKS) {
      this.acksAplicados.splice(0, this.acksAplicados.length - MAX_APLICADO_ACKS);
    }
    this._pedirRelatorio();
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

  async _applyUnit(envelope) {
    // Número da unidade editado pelo professor. Ilegível/ausente → IGNORA
    // (número não é papel: o vigente continua; re-pareamento reescreve tudo).
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return;
    }
    if (msg.type !== MessageType.SET_UNIT) return;
    const rev = Number(msg.payload?.rev) || 0;
    if (rev <= this.unitRev) return; // já aplicado (ou mais velho)
    const numero = msg.payload?.numero;
    if (!Number.isInteger(numero) || numero < 1 || numero > 9999) return;
    const ack = await this.onCommand?.({
      type: MessageType.SET_UNIT,
      id: msg.id,
      payload: { numero },
    });
    if (ack?.ok) {
      this.unitRev = rev;
      await this._persistReplay();
    }
  }

  async _applyClassView(envelope) {
    // null (delete/ausente) OU envelope ilegível (app reinstalado = chave
    // nova) ⇒ este PC deixa de se considerar o telão. Diferente de
    // _applyRules, que só ignora envelope ilegível: aqui o snapshot velho
    // não pode ficar exposto na página.
    let msg = null;
    if (envelope != null) {
      try {
        msg = await open(this.key, envelope);
      } catch {
        msg = null;
      }
    }
    if (msg == null) {
      // Sempre repassa o null (remoção é idempotente e barata) — cobre até
      // storage órfão com replay perdido.
      await this.onCommand?.({ type: MessageType.SET_CLASS_VIEW, payload: { snapshot: null } });
      if (this.classviewRev !== 0) {
        this.classviewRev = 0;
        await this._persistReplay();
      }
      return;
    }
    if (msg.type !== MessageType.SET_CLASS_VIEW) return;
    const rev = Number(msg.payload?.rev) || 0;
    if (rev <= this.classviewRev) return; // snapshot já aplicado (ou mais velho)
    const snapshot = parseClassView(msg.payload);
    if (!snapshot) return;
    const ack = await this.onCommand?.({
      type: MessageType.SET_CLASS_VIEW,
      id: msg.id,
      payload: { snapshot },
    });
    if (ack?.ok) {
      this.classviewRev = rev;
      await this._persistReplay();
    }
  }

  // ---- Trava, prova e grade ao vivo (ext >= 0.7.0) ---------------------------

  /// Envelope LIGADO velho demais para valer (> 12 h). `env.ts` é relógio de
  /// servidor do professor: compara com o relógio deste PC corrigido pelo do
  /// servidor, para um PC com a data errada não ignorar (nem religar) a trava.
  _ligadoVelho(envTs) {
    return envTs < this.agoraCorrigido() - ESTADO_LIGADO_IDADE_MAX_MS;
  }

  /// set_lock: `rev >= lockRev` (igual REAPLICA — refaz a janela na reentrega);
  /// o SW guarda a cópia local e destrava sozinho no prazo.
  async _applyLock(envelope) {
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return; // ilegível (app reinstalado = chave nova): não muda nada
    }
    if (msg.type !== MessageType.SET_LOCK) return;
    const p = limparLock(msg.payload);
    if (!p || p.rev < this.lockRev) return;
    const envTs = Number(msg.ts) || 0;
    const agora = this.agora();
    let prazo = prazoLocal(p.ate, envTs, TRAVA_TETO_MS, agora);
    if (p.on && this._ligadoVelho(envTs)) prazo = agora;
    const ack = await this.onCommand?.({
      type: MessageType.SET_LOCK,
      id: msg.id,
      payload: { rev: p.rev, envTs, on: p.on, texto: p.texto, mute: p.mute, prazo },
    });
    if (ack?.ok) {
      if (p.rev !== this.lockRev) {
        this.lockRev = p.rev;
        await this._persistReplay();
      }
      this._pedirRelatorio();
    }
  }

  /// set_exam: mesmas regras da trava, teto de 4 h.
  async _applyExam(envelope) {
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return;
    }
    if (msg.type !== MessageType.SET_EXAM) return;
    const p = limparExam(msg.payload);
    if (!p || p.rev < this.examRev) return;
    const envTs = Number(msg.ts) || 0;
    const agora = this.agora();
    let prazo = prazoLocal(p.ate, envTs, PROVA_TETO_MS, agora);
    if (p.on && this._ligadoVelho(envTs)) prazo = agora;
    const ack = await this.onCommand?.({
      type: MessageType.SET_EXAM,
      id: msg.id,
      payload: { rev: p.rev, envTs, on: p.on, allow: p.allow, inicio: p.inicio, prazo },
    });
    if (ack?.ok) {
      if (p.rev !== this.examRev) {
        this.examRev = p.rev;
        await this._persistReplay();
      }
      this._pedirRelatorio();
    }
  }

  /// set_monitor: `rev > monitorRev` e `env.ts` a ±120 s do relógio corrigido.
  /// Prazo pelo relógio MONOTÔNICO: agora + clamp(ate − env.ts, 0, 45 s) — um
  /// PC com o relógio errado para do mesmo jeito. null = para na hora.
  async _applyMonitor(envelope) {
    if (envelope == null) return this._pararMonitor();
    let msg;
    try {
      msg = await open(this.key, envelope);
    } catch {
      return;
    }
    if (msg.type !== MessageType.SET_MONITOR) return;
    const p = limparMonitor(msg.payload);
    if (!p || p.rev <= this.monitorRev) return;
    const envTs = Number(msg.ts);
    if (!Number.isFinite(envTs) || Math.abs(envTs - this.agoraCorrigido()) > MONITOR_JANELA_TS_MS) {
      return; // envelope velho (reentregue depois de um reset de replay) ou do futuro
    }
    this.monitorRev = p.rev;
    await this._persistReplay();
    const restante = Math.min(Math.max(p.ate - envTs, 0), MONITOR_TETO_MS);
    this._thumb.prazoMono = this.agoraMono() + restante;
    this._thumb.desligado = false; // rev novo reabilita depois de um 401/403
    if (restante > 0 && !this._thumbTimer) {
      this._thumbTimer = setInterval(() => this._monitorTick(), THUMB_INTERVALO_MS);
      this._monitorTick();
    }
  }

  /// Uma rodada da grade: captura (via SW), sela e grava /thumbs/{id} pelo
  /// caminho lateral. Marcador (sem imagem) só quando muda.
  _monitorTick() {
    if (this._thumbTick) return this._thumbTick;
    this._thumbTick = this._monitorRodada()
      .catch((e) => console.warn('[CdA] miniatura:', e?.message ?? e))
      .finally(() => {
        this._thumbTick = null;
      });
    return this._thumbTick;
  }

  async _monitorRodada() {
    const t = this._thumb;
    if (!this.running) return;
    if (this.agoraMono() >= t.prazoMono) {
      await this._pararMonitor({ esperar: false });
      return;
    }
    if (t.desligado) return;
    let r = null;
    try {
      r = await this.capturarThumb?.();
    } catch {
      r = null;
    }
    if (!this.running || this.agoraMono() >= t.prazoMono) return; // parou durante a captura
    let obj = null;
    if (typeof r?.jpegB64 === 'string' && r.jpegB64) {
      obj = {
        v: PROTOCOL_VERSION,
        type: MessageType.THUMB_SNAPSHOT,
        jpegB64: r.jpegB64,
        w: Number(r.w) || 0,
        h: Number(r.h) || 0,
      };
    }
    let env = obj ? await this._seal(obj) : null;
    if (!env || env.length >= THUMB_MAX_ENV) {
      const motivo = !obj && THUMB_MOTIVOS.includes(r?.motivo) ? r.motivo : 'falhou';
      if (t.marcador === motivo) return; // uma vez por mudança de estado
      obj = { v: PROTOCOL_VERSION, type: MessageType.THUMB_SNAPSHOT, jpegB64: null, w: 0, h: 0, motivo };
      env = await this._seal(obj);
    }
    const res = await this.fb.putQuiet(`/thumbs/${this.deviceId}`, {
      env,
      ts: this.fb.serverTimestamp(),
    });
    if (res.status >= 200 && res.status < 300) {
      t.gravou = true;
      t.marcador = obj.motivo ?? null;
    } else if (res.status === 401 || res.status === 403) {
      t.desligado = true; // rules atrasadas: para até o próximo rev de state/monitor
    }
  }

  /// Para a grade e apaga a miniatura (lateral) uma vez.
  async _pararMonitor({ esperar = true } = {}) {
    const ativo = this._thumbTimer !== null;
    clearInterval(this._thumbTimer);
    this._thumbTimer = null;
    this._thumb.prazoMono = 0;
    if (!ativo) return;
    if (esperar) await this._thumbTick?.catch(() => {}); // escrita em voo antes do delete
    this._thumb.gravou = false;
    this._thumb.marcador = null;
    await this.fb.deleteQuiet(`/thumbs/${this.deviceId}`);
  }

  // ---- Canal aluno→professor (up) ----------------------------------------------

  /// Sela e grava um item em up/ (POST, caminho lateral). Único ponto de saída
  /// do ChromeOS (o rate-limit fica no SW, antes daqui). → {ok, mid} | {ok:false, erro}
  async sendUp(tipo, payload, mid) {
    if (!this.running || !this.key) return { ok: false, erro: 'sem_conexao' };
    if (this.agoraMono() < this._upDesligadoAte) return { ok: false, erro: 'sem_permissao' };
    const limpo = limparPayloadUp(tipo, payload);
    if (!limpo) return { ok: false, erro: 'payload_invalido' };
    const id = idValido(mid) ? mid : novoId();
    const env = await this._seal({ v: PROTOCOL_VERSION, type: tipo, mid: id, payload: limpo });
    if (env.length >= UP_MAX_ENVELOPE) return { ok: false, erro: 'payload_invalido' };
    const r = await this.fb.postQuiet(`${this.base}/up`, env);
    if (r.status >= 200 && r.status < 300) {
      this._podarUp();
      return { ok: true, mid: id };
    }
    if (r.status === 401 || r.status === 403) {
      this._upDesligadoAte = this.agoraMono() + LATERAL_DESLIGADO_MS;
      return { ok: false, erro: 'sem_permissao' };
    }
    return { ok: false, erro: 'sem_conexao' };
  }

  /// Poda da fila up: > 2 h e além das 20 mais novas (lateral, best-effort).
  async _podarUp() {
    if (this._podando) return;
    this._podando = true;
    try {
      const r = await this.fb.getQuiet(`${this.base}/up`, { shallow: true });
      if (r.status !== 200 || !r.body || typeof r.body !== 'object') return;
      for (const k of chavesParaPodar(Object.keys(r.body), this.agoraCorrigido())) {
        await this.fb.deleteQuiet(`${this.base}/up/${k}`);
      }
    } finally {
      this._podando = false;
    }
  }

  // ---- Saída (report + presença) -------------------------------------------------

  async _presence() {
    try {
      const antes = this.agora();
      const r = await this.fb.put(`${this.base}/presence`, { lastSeen: this.fb.serverTimestamp() });
      // A resposta traz o timestamp do servidor já resolvido: dá o desvio do
      // relógio deste PC sem custo extra (janela de ts do monitor).
      if (typeof r?.lastSeen === 'number') {
        this.clockOffset = r.lastSeen - (antes + this.agora()) / 2;
      }
      // NÃO marca 'connected' aqui: presença é um heartbeat REST de SAÍDA; o
      // sucesso do PUT não prova que o stream de ENTRADA (comandos) está vivo.
      // Quem afirma 'connected' é o recebimento de eventos do stream (run()).
      // Se o PUT falha, aí sim a rede está ruim → sinaliza 'connecting'.
    } catch (e) {
      this.onState?.(false, String(e?.message ?? e));
    }
  }

  /// Relatório logo depois de aplicar estado ou responder comando (debounce
  /// curto: um put inicial aplica várias coisas em sequência).
  _pedirRelatorio() {
    if (this._relatorioTimer || !this.running) return;
    this._relatorioTimer = setTimeout(() => {
      this._relatorioTimer = null;
      this._maybeReport();
    }, REPORT_LOGO_MS);
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
    // Confirmação positiva: trava/prova efetivas (o SW manda) + últimos acks.
    report = {
      ...report,
      aplicado: makeAplicado({
        trava: report.aplicado?.trava,
        prova: report.aplicado?.prova,
        acks: this.acksAplicados,
      }),
    };
    const fingerprint =
      JSON.stringify(report.tabs?.map((t) => [t.url, t.active]) ?? []) +
      '|' +
      (report.events?.[report.events.length - 1]?.ts ?? 0) +
      '|' +
      JSON.stringify(report.aplicado);
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
    this.classviewRev = Number(saved.classviewRev) || 0;
    this.unitRev = Number(saved.unitRev) || 0;
    this.lockRev = Number(saved.lockRev) || 0;
    this.examRev = Number(saved.examRev) || 0;
    this.monitorRev = Number(saved.monitorRev) || 0;

    this.running = true;
    return new Promise((resolve) => {
      this._resolve = resolve;

      this._stream = this.fb.stream(this.base, {
        // Cada evento recebido (inclusive o put inicial que o RTDB manda a cada
        // (re)conexão) prova que o stream de comandos está VIVO — é isto que
        // afirma 'connected'. Antes só a presença REST marcava 'connected', o
        // que MASCARAVA um stream morto com REST vivo: a UI dizia conectado, os
        // comandos não chegavam e a auto-reconexão (que só age preso em
        // 'connecting') nunca disparava. Ver _presence().
        onEvent: ({ type, path, data }) => {
          this.onState?.(true);
          this._route(path, data, type);
        },
        onDown: (motivo) => this.onState?.(false, motivo),
      });

      this._presence();
      this._presenceTimer = setInterval(() => this._presence(), PRESENCE_MS);
      this._reportTimer = setInterval(() => this._maybeReport(), REPORT_TICK_MS);
      this._upPodaTimer = setInterval(() => this._podarUp(), UP_PODA_MS);
    });
  }
}
