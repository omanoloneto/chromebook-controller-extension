// Cliente mínimo do Firebase (Auth anônima + RTDB REST + stream SSE).
// SEM o SDK oficial: MV3 proíbe script remoto e o repo não tem bundler —
// a superfície necessária é pequena (2 endpoints de auth + 5 verbos REST +
// 1 listener SSE). Roda no offscreen (DOM completo: EventSource disponível).
//
// Auth: Identity Toolkit REST (signUp anônimo) + Secure Token (refresh).
// Stream: EventSource em `{databaseURL}/{path}.json?auth=<idToken>` — o RTDB
// manda eventos `put`/`patch`/`keep-alive`/`cancel`/`auth_revoked`.

/// Recria o stream se ficar 90s sem NENHUM evento (keep-alives chegam ~30s;
/// tampa fechada mata o socket em silêncio — sem watchdog ficaríamos "conectados"
/// para sempre).
export const STREAM_WATCHDOG_MS = 90000;

/// Renova o idToken 5 min antes de expirar (vida padrão: 1h).
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

/// Códigos do Secure Token que significam "esta conta MORREU" — só aí vale
/// criar conta anônima nova. Erro de rede, 5xx ou resposta de portal cativo
/// NÃO entram: cair para signUp nesses casos troca o uid, e o uid antigo está
/// pinado em meta/uid nas rules (first-write-wins) — o device ficaria com
/// permission-denied PARA SEMPRE (visto em queda de energia na escola: a rede
/// volta "meio viva" e o DNS/portal devolve lixo HTTP 200 antes da internet
/// real subir).
const AUTH_DEAD_CODES = new Set([
  'INVALID_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'USER_NOT_FOUND',
  'USER_DISABLED',
  'INVALID_GRANT',
  'MISSING_REFRESH_TOKEN',
]);

/// Interpreta um evento SSE do RTDB — puro, testável (tests/firebase.test.mjs).
/// Retorna { type, path?, data? } ou null para eventos ignoráveis/malformados.
export function parseStreamEvent(eventName, dataText) {
  switch (eventName) {
    case 'put':
    case 'patch': {
      let body;
      try {
        body = JSON.parse(dataText);
      } catch {
        return null;
      }
      if (!body || typeof body.path !== 'string') return null;
      return { type: eventName, path: body.path, data: body.data };
    }
    case 'keep-alive':
      return { type: 'keep-alive' };
    case 'cancel': // servidor revogou a permissão de leitura do caminho
      return { type: 'cancel' };
    case 'auth_revoked': // idToken expirou — renovar e reconectar
      return { type: 'auth_revoked' };
    default:
      return null;
  }
}

export class FirebaseSession {
  /// `loadAuth`/`saveAuth`: persistência de {uid, refreshToken} (o offscreen
  /// usa o service worker como proxy de chrome.storage).
  /// `authOrigin`/`tokenOrigin`/`namespace`: overrides p/ o emulador.
  constructor({
    apiKey,
    databaseURL,
    loadAuth,
    saveAuth,
    authOrigin = 'https://identitytoolkit.googleapis.com',
    tokenOrigin = 'https://securetoken.googleapis.com',
    namespace = null,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    EventSourceImpl = globalThis.EventSource,
  }) {
    this.apiKey = apiKey;
    this.databaseURL = databaseURL.replace(/\/+$/, '');
    this.loadAuth = loadAuth;
    this.saveAuth = saveAuth;
    this.authOrigin = authOrigin;
    this.tokenOrigin = tokenOrigin;
    this.namespace = namespace; // emulador exige ?ns=<db-name>
    this.fetch = fetchImpl;
    this.EventSourceImpl = EventSourceImpl;

    this.uid = null;
    this.idToken = null;
    this._refreshToken = null;
    this._refreshTimer = null;
    this._streams = new Set(); // streams ativos: reconectam após refresh
  }

  // ---- Auth -----------------------------------------------------------------

  /// Restaura a conta anônima persistida (refresh) ou cria uma nova (signUp).
  /// Só cria conta nova se NÃO havia conta salva ou se ela morreu de verdade
  /// (`authDead` — códigos definitivos do Secure Token). Falha transitória
  /// (rede/5xx/portal cativo) LANÇA — o mainLoop do offscreen retenta.
  async signIn() {
    const saved = (await this.loadAuth?.()) ?? null;
    if (saved?.refreshToken) {
      try {
        await this._refresh(saved.refreshToken);
        return this.uid;
      } catch (e) {
        if (!e?.authDead) throw e; // transitório: NUNCA abandonar o uid pinado
        // Conta morta (ex.: auto-delete de anônimas) — identidade nova.
        console.warn('[CdA] conta anônima morta, criando nova:', e?.message);
      }
    }
    const res = await this.fetch(
      `${this.authOrigin}/v1/accounts:signUp?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    if (!res.ok) throw new Error(`signup_http_${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data?.localId || !data.idToken || !data.refreshToken) {
      // Portal cativo/DNS sequestrado devolvendo lixo com HTTP 200: não é uma
      // conta — e principalmente NÃO pode sobrescrever o storage com undefined.
      throw new Error('signup_resposta_invalida');
    }
    this.uid = data.localId;
    this.idToken = data.idToken;
    this._refreshToken = data.refreshToken;
    await this.saveAuth?.({ uid: this.uid, refreshToken: this._refreshToken });
    this._scheduleRefresh(Number(data.expiresIn) * 1000);
    return this.uid;
  }

  async _refresh(refreshToken) {
    const res = await this.fetch(`${this.tokenOrigin}/v1/token?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(
        refreshToken ?? this._refreshToken,
      )}`,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // Secure Token responde {error:{message:'TOKEN_EXPIRED',...}} (às vezes
      // com sufixo ': detalhe'); o emulador usa {error:'...'} plano.
      const code = String(body?.error?.message ?? body?.error ?? '')
        .split(':')[0]
        .trim();
      const err = new Error(`refresh_http_${res.status}${code ? `_${code}` : ''}`);
      err.status = res.status;
      err.authDead = res.status === 400 && AUTH_DEAD_CODES.has(code);
      throw err;
    }
    const data = await res.json().catch(() => null);
    if (!data?.user_id || !data.id_token || !data.refresh_token) {
      throw new Error('refresh_resposta_invalida'); // transitório (portal cativo)
    }
    this.uid = data.user_id;
    this.idToken = data.id_token;
    this._refreshToken = data.refresh_token;
    await this.saveAuth?.({ uid: this.uid, refreshToken: this._refreshToken });
    this._scheduleRefresh(Number(data.expires_in) * 1000);
    // O idToken vai na URL do EventSource — streams precisam reconectar.
    for (const s of this._streams) s._reconnect('token_renovado');
    return this.uid;
  }

  _scheduleRefresh(lifetimeMs) {
    clearTimeout(this._refreshTimer);
    const delay = Math.max(60000, lifetimeMs - REFRESH_MARGIN_MS);
    this._refreshTimer = setTimeout(() => {
      this._refresh().catch((e) =>
        console.warn('[CdA] refresh agendado falhou (retenta em 60s):', e?.message),
      );
      // Falha transitória: o retry natural vem do próximo 401/auth_revoked,
      // mas agenda uma nova tentativa curta por garantia.
      this._scheduleRefresh(REFRESH_MARGIN_MS + 60000);
    }, delay);
  }

  stop() {
    clearTimeout(this._refreshTimer);
    for (const s of this._streams) s.close();
  }

  // ---- REST -----------------------------------------------------------------

  serverTimestamp() {
    return { '.sv': 'timestamp' };
  }

  _url(path, extra = '') {
    const p = path.startsWith('/') ? path : `/${path}`;
    const ns = this.namespace ? `&ns=${this.namespace}` : '';
    return `${this.databaseURL}${p}.json?auth=${this.idToken}${ns}${extra}`;
  }

  /// fetch com 1 retry após refresh se o token expirou (401).
  async _request(method, path, body) {
    for (let tentativa = 0; ; tentativa++) {
      const res = await this.fetch(this._url(path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && tentativa === 0) {
        await this._refresh();
        continue;
      }
      if (!res.ok) {
        const err = new Error(`rtdb_${method}_${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  }

  get(path) {
    return this._request('GET', path);
  }

  put(path, value) {
    return this._request('PUT', path, value);
  }

  patch(path, value) {
    return this._request('PATCH', path, value);
  }

  /// POST → {name: pushId}. Retorna o pushId.
  async push(path, value) {
    const r = await this._request('POST', path, value);
    return r?.name ?? null;
  }

  delete(path) {
    return this._request('DELETE', path);
  }

  // ---- Stream (SSE) -----------------------------------------------------------

  /// Escuta um caminho. `onEvent({type:'put'|'patch', path, data})` recebe cada
  /// mudança; `onDown(motivo)` avisa quedas (a reconexão é automática).
  /// Retorna um handle com `close()`.
  stream(path, { onEvent, onDown } = {}) {
    const session = this;
    const handle = {
      closed: false,
      _es: null,
      _watchdog: null,
      _reconnectTimer: null,
      _backoffMs: BACKOFF_MIN_MS,
      _lastEventAt: 0,

      close() {
        this.closed = true;
        clearInterval(this._watchdog);
        clearTimeout(this._reconnectTimer);
        this._es?.close();
        session._streams.delete(this);
      },

      _reconnect(motivo) {
        if (this.closed) return;
        onDown?.(motivo);
        this._es?.close();
        this._es = null;
        // Um agendamento por vez: _reconnect pode chegar em rajada (erro SSE +
        // refresh + watchdog) — dois timers criariam dois EventSource vivos no
        // mesmo handle (socket vazado entregando evento em dobro).
        if (this._reconnectTimer) return;
        const delay = this._backoffMs;
        this._backoffMs = Math.min(this._backoffMs * 2, BACKOFF_MAX_MS);
        // Backoff no teto = queda longa (ex.: falta de luz). O idToken pode
        // ter expirado com a rede fora — EventSource novo com token velho é
        // 401 mudo (onerror sem status), reconectaria para sempre. Renova
        // junto: no sucesso o token novo entra na URL da próxima conexão.
        if (delay >= BACKOFF_MAX_MS) session._refresh().catch(() => {});
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._connect();
        }, delay);
      },

      _connect() {
        if (this.closed) return;
        this._es?.close(); // nunca dois sockets no mesmo handle
        const es = new session.EventSourceImpl(session._url(path));
        this._es = es;
        this._lastEventAt = Date.now();

        const marcar = () => {
          this._lastEventAt = Date.now();
          this._backoffMs = BACKOFF_MIN_MS;
        };

        for (const nome of ['put', 'patch', 'keep-alive', 'cancel', 'auth_revoked']) {
          es.addEventListener(nome, (ev) => {
            marcar();
            const parsed = parseStreamEvent(nome, ev.data);
            if (!parsed) return;
            if (parsed.type === 'auth_revoked') {
              session
                ._refresh()
                .catch(() => {}) // _refresh reconecta os streams; se falhar, o watchdog age
                .finally(() => this._reconnect('auth_revoked'));
            } else if (parsed.type === 'cancel') {
              this._reconnect('cancel'); // perdeu permissão (ex.: unbind) — o caller decide via onEvent do put inicial seguinte
            } else if (parsed.type !== 'keep-alive') {
              try {
                onEvent?.(parsed);
              } catch (e) {
                console.warn('[CdA] onEvent lançou:', e);
              }
            }
          });
        }
        es.onerror = () => this._reconnect('erro_sse');
      },
    };

    // Watchdog: sem NENHUM evento por STREAM_WATCHDOG_MS ⇒ socket morto.
    handle._watchdog = setInterval(() => {
      if (handle.closed || !handle._lastEventAt) return;
      if (Date.now() - handle._lastEventAt > STREAM_WATCHDOG_MS) {
        handle._reconnect('watchdog');
      }
    }, STREAM_WATCHDOG_MS / 3);

    this._streams.add(handle);
    handle._connect();
    return handle;
  }
}
