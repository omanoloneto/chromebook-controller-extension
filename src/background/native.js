// Modo nativo (Celita OS): a conexão com o Firebase vive num agente do
// sistema, fora do navegador. A extensão fala com ele por native messaging e
// vira só o braço para abas — sem offscreen, sem Firebase aqui dentro.
//
// Detecção em tempo de execução: se o host nativo não existe (Chromebook), o
// service worker segue no modo offscreen de sempre. Se o host existe mas o
// agente está fora, a porta cai e a reconexão fica por conta do alarme.

export const NATIVE_HOST = 'br.escola.celita.controle_de_aula';
const REPORT_DEBOUNCE_MS = 1000;

export class Native {
  /// `onExec(cmd, payload) -> Promise<{ok, error}>`; `onRules({rev, rules, filtros?})`;
  /// `onClassView(snapshot|null)`; `onState({state, detail, teacher})`.
  constructor({ onExec, onRules, onClassView, onState, montarRelatorio }) {
    this.onExec = onExec;
    this.onRules = onRules;
    this.onClassView = onClassView;
    this.onState = onState;
    this.montarRelatorio = montarRelatorio;
    this.port = null;
    this.indisponivel = false; // host não instalado: modo offscreen
    this.estado = { state: 'connecting', detail: null, teacher: null, label: null, numero: null, version: null };
    this.pareamento = null;
    this._reportTimer = null;
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
      // "Specified native messaging host not found" / "forbidden": não é
      // Celita — desliga o modo nativo até o próximo start do service worker.
      if (/not found|forbidden|not registered/i.test(erro)) {
        this.indisponivel = true;
        return;
      }
      this.onState?.({ state: 'connecting', detail: 'agente indisponível', teacher: null });
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
        this.onRules?.({ rev: msg.rev, rules: msg.rules, filtros: msg.filtros });
        return;
      case 'classview':
        this.onClassView?.(msg.snapshot ?? null);
        return;
      case 'exec': {
        let res;
        try {
          res = await this.onExec(msg.cmd, msg.payload ?? {});
        } catch (e) {
          res = { ok: false, error: String(e?.message ?? e) };
        }
        this.enviar({ t: 'res', id: msg.id, res: res ?? { ok: false, error: 'sem_resposta' } });
        return;
      }
      default:
        return;
    }
  }
}
