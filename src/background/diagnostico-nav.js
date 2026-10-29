// Diagnóstico do Celita: tempo de carregamento das páginas, medido só enquanto
// o agente pede (sem agente, no Chromebook, nunca liga). Só o host sai daqui,
// nunca caminho ou query.

import { isSafeHttpUrl } from '../lib/protocol.js';
import { hostDeUrl } from '../lib/up.js';

const LOTE = 10;
const LOTE_ESPERA_MS = 5000;
const MAX_PENDENTES = 50;
const MAX_MS = 600000;

const RELOGIO = {
  agendar: (fn, ms) => setTimeout(fn, ms),
  cancelar: (id) => clearTimeout(id),
};

const limitar = (ms) => Math.min(MAX_MS, Math.max(0, Math.round(ms)));

export class NavDiag {
  /// `enviar(itens)`: false = não saiu, os itens esperam a próxima tentativa.
  /// `relogio`: {agendar(fn, ms), cancelar(id)}, injetável no teste.
  constructor({ enviar, relogio = RELOGIO }) {
    this.enviar = enviar;
    this.relogio = relogio;
    this.ativo = false;
    this.abas = new Map(); // tabId -> {host, t0, resp?, doc?, anterior?}
    this.pendentes = [];
    this._timer = null;
  }

  ligar(ativo) {
    this.ativo = ativo === true;
    if (this.ativo) return;
    this.abas.clear();
    this.pendentes = [];
    this._cancelar();
  }

  inicio(d) {
    if (!this._principal(d)) return;
    const anterior = this.abas.get(d.tabId)?.doc;
    if (!isSafeHttpUrl(d.url)) {
      this.abas.delete(d.tabId);
      return;
    }
    this.abas.set(d.tabId, { host: hostDeUrl(d.url), t0: d.timeStamp, anterior });
  }

  commit(d) {
    const nav = this._daNavegacao(d);
    if (!nav) return;
    nav.resp = d.timeStamp - nav.t0;
    nav.doc = d.documentId;
  }

  fim(d) {
    const nav = this._daNavegacao(d);
    if (!nav) return;
    this.abas.delete(d.tabId);
    const item = { host: nav.host, ms: limitar(d.timeStamp - nav.t0) };
    if (nav.resp !== undefined) item.resp = limitar(nav.resp);
    this._enfileirar(item);
  }

  erro(d) {
    const nav = this._daNavegacao(d);
    if (!nav) return;
    this.abas.delete(d.tabId);
    // ERR_ABORTED: o aluno parou ou saiu antes de carregar, não diz nada da rede.
    if (d.error === 'net::ERR_ABORTED') return;
    this._enfileirar({ host: nav.host, ms: limitar(d.timeStamp - nav.t0), erro: d.error });
  }

  esquecer(tabId) {
    this.abas.delete(tabId);
  }

  _principal(d) {
    return this.ativo && d.frameId === 0 && d.documentLifecycle !== 'prerender';
  }

  // A página anterior pode terminar de carregar depois que a nova começou
  // (endereço digitado com a outra ainda carregando): o evento é dela.
  _daNavegacao(d) {
    if (!this._principal(d)) return null;
    const nav = this.abas.get(d.tabId);
    if (!nav || (d.documentId !== undefined && d.documentId === nav.anterior)) return null;
    return nav;
  }

  _enfileirar(item) {
    this.pendentes.push(item);
    if (this.pendentes.length > MAX_PENDENTES) this.pendentes.shift();
    if (this.pendentes.length >= LOTE) this._enviar();
    else this._agendar();
  }

  _agendar() {
    if (this._timer !== null) return;
    this._timer = this.relogio.agendar(() => {
      this._timer = null;
      this._enviar();
    }, LOTE_ESPERA_MS);
  }

  _cancelar() {
    if (this._timer === null) return;
    this.relogio.cancelar(this._timer);
    this._timer = null;
  }

  _enviar() {
    this._cancelar();
    if (this.enviar(this.pendentes) === false) {
      this._agendar();
      return;
    }
    this.pendentes = [];
  }
}
