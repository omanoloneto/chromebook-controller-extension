// Modo nativo (Celita OS): a conexão com o Firebase vive num agente do
// sistema, fora do navegador. A extensão fala com ele por native messaging e
// vira só o braço para abas — sem offscreen, sem Firebase aqui dentro.
//
// Detecção em tempo de execução: se o host nativo não existe (Chromebook), o
// service worker segue no modo offscreen de sempre. Se o host existe mas o
// agente está fora, a porta cai e a reconexão fica por conta do alarme.

export const NATIVE_HOST = 'br.escola.celita.controle_de_aula';
const REPORT_DEBOUNCE_MS = 1000;
const UP_TIMEOUT_MS = 10000; // pedirUp: sem up-result do agente = ponte_sem_resposta

export class Native {
  /// `onExec(cmd, payload) -> Promise<{ok, error}>`; `onRules({rev, rules, filtros?, prova?})`;
  /// `onClassView(snapshot|null)`; `onState({state, detail, teacher})`.
  constructor({ onExec, onRules, onClassView, onState, montarRelatorio }) {
    this.onExec = onExec;
    this.onRules = onRules;
    this.onClassView = onClassView;
    this.onState = onState;
    this.montarRelatorio = montarRelatorio;
    this.port = null;
    this.indisponivel = false; // host não instalado: modo offscreen
    this.estado = { state: 'connecting', detail: null, motivo: null, teacher: null, label: null, numero: null, version: null };
    this.pareamento = null;
    this._reportTimer = null;
    this._ups = new Map(); // id -> {resolve, timer} (pedirUp aguardando up-result)
  }

  get ativo() {
    return this.port !== null;
  }

  conectar() {
    if (this.port || this.indisponivel) return;
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      this.indisponivel = true;
      return;
    }
    this.port = port;
    port.onMessage.addListener((msg) => this._receber(msg));
    port.onDisconnect.addListener(() => {
      const erro = chrome.runtime.lastError?.message ?? '';
      this.port = null;
      this._encerrarUps('ponte_caiu');
      // "Specified native messaging host not found" / "forbidden": não é
      // Celita — desliga o modo nativo até o próximo start do service worker.
      if (/not found|forbidden|not registered/i.test(erro)) {
        this.indisponivel = true;
        return;
      }
      this.onState?.({ state: 'connecting', detail: 'agente indisponível', motivo: null, teacher: null });
    });
    port.postMessage({ t: 'hello', ver: chrome.runtime.getManifest().version });
  }

  enviar(msg) {
    if (!this.port) return false;
    try {
      this.port.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  pedirPareamento() {
    this.enviar({ t: 'get', req: 'pairing' });
  }

  /// Pede ao agente para mandar um item ao professor (fila `up`): ele é o
  /// único ponto de saída no Celita (rate-limit e sessão ativa conferidos lá).
  /// Resolve com {ok, erro?}; sem resposta em 10 s = 'ponte_sem_resposta'.
  pedirUp(tipo, payload, id) {
    return new Promise((resolve) => {
      const chave = typeof id === 'string' && id ? id : `u${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this._ups.delete(chave);
        resolve({ ok: false, erro: 'ponte_sem_resposta' });
      }, UP_TIMEOUT_MS);
      this._ups.set(chave, { resolve, timer });
      if (!this.enviar({ t: 'up', id: chave, tipo, payload })) {
        clearTimeout(timer);
        this._ups.delete(chave);
        resolve({ ok: false, erro: 'ponte_caiu' });
      }
    });
  }

  _encerrarUps(erro) {
    for (const { resolve, timer } of this._ups.values()) {
      clearTimeout(timer);
      resolve({ ok: false, erro });
    }
    this._ups.clear();
  }

  /// Relatório de abas para o agente, com debounce: eventos de aba chegam em rajada.
  agendarRelatorio() {
    if (!this.port) return;
    clearTimeout(this._reportTimer);
    this._reportTimer = setTimeout(() => this.enviarRelatorio(), REPORT_DEBOUNCE_MS);
  }

  async enviarRelatorio() {
    if (!this.port) return;
    try {
      const report = await this.montarRelatorio();
      this.enviar({ t: 'report', report });
    } catch {
      // próximo evento de aba tenta de novo
    }
  }

  async _receber(msg) {
    switch (msg?.t) {
      case 'state':
        this.estado = {
          state: msg.state ?? 'connecting',
          detail: msg.detail ?? null,
          motivo: typeof msg.motivo === 'string' ? msg.motivo : null,
          teacher: msg.teacher ?? null,
          label: msg.label ?? null,
          numero: typeof msg.numero === 'number' ? msg.numero : null,
          version: msg.version ?? null,
        };
        this.onState?.(this.estado);
        return;
      case 'pairing':
        this.pareamento = msg.dados ?? null;
        return;
      case 'rules':
        // prova ausente (agente antigo) = a extensão mantém a que já valia.
        this.onRules?.({
          rev: msg.rev,
          rules: msg.rules,
          filtros: msg.filtros,
          ...(msg.prova && typeof msg.prova === 'object' ? { prova: msg.prova } : {}),
        });
        return;
      case 'up-result': {
        const pendente = this._ups.get(msg.id);
        if (!pendente) return;
        clearTimeout(pendente.timer);
        this._ups.delete(msg.id);
        pendente.resolve({ ok: msg.ok === true, ...(typeof msg.erro === 'string' ? { erro: msg.erro } : {}) });
        return;
      }
      case 'classview':
        this.onClassView?.(msg.snapshot ?? null);
        return;
      case 'exec': {
        let res;
        try {
          res = await this.onExec(msg.cmd, msg.payload ?? {});
        } catch (e) {
          console.warn('[CdA] executor nativo lançou:', e?.message ?? e);
          res = { ok: false, error: 'executor_falhou' };
        }
        this.enviar({ t: 'res', id: msg.id, res: res ?? { ok: false, error: 'sem_resposta' } });
        return;
      }
      default:
        return;
    }
  }
}
