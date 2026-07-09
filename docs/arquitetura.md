# Arquitetura — Extensão (Chromebook, cliente Firebase)

## Visão geral

Transporte via **Firebase Realtime Database**, com criptografia
**ponta-a-ponta** por cima. Chromebook e celular podem estar em **redes
diferentes** — só precisam de internet.

- **Extensão (este repo)** = cliente RTDB com **Auth anônima**. Exibe um **QR
  de pareamento**; após o professor escanear, fica vinculada (TOFU) e escuta o
  próprio nó `/devices/{deviceId}` por **SSE** (EventSource).
- **App (celular)** = escreve comandos cifrados em `cmd/` e `state/`; a
  extensão executa, dá ack e sobe o relatório de abas.

```
   CHROMEBOOK (extensão)            RTDB                APP (professor)
   exibe QR {id,pub,tok}   ───────►  ◄──────────────── escaneia, grava bind
   stream SSE /devices/{id} ◄──────  ◄──────────────── cmd/state (envelopes)
   executa, ack, deleta     ───────►
   report (envelope) PUT    ───────►  ──────────────►  abas/histórico no app
   presence heartbeat 25s   ───────►
```

> **Por que REST+SSE e não o SDK do Firebase?** MV3 proíbe script remoto
> (CSP `script-src 'self'`) e o repo é deliberadamente sem bundler. A
> superfície necessária é pequena: 2 endpoints de auth + 5 verbos REST + 1
> stream SSE — tudo em `firebase.js` (~250 linhas testáveis).

## Componentes

| Parte | Pasta | Responsabilidade |
|-------|-------|------------------|
| **Offscreen** | `src/offscreen/` | Orquestra: auth anônima → registro no RTDB → pareamento (QR/TOFU) → `CloudClient`. Vive fora do service worker (que hiberna). |
| **Service worker** | `src/background/` | Garante o offscreen (`chrome.alarms`), executa `chrome.tabs` (abrir/fechar), **monitora abas** (nav-log em `storage`), **bloqueia sites** (regras em `storage` + cache, redirect p/ `blocked/`), **papel de parede** (recebe o blob base64 por IPC), ícone, dados do QR p/ o popup. |
| **Popup** | `src/popup/` | Status do vínculo, **QR de pareamento**, "Abrir QR em tela cheia", **"Desvincular professor"** e **nome deste PC**. |
| **Página de pareamento** | `src/pairing/` | QR grande em tela cheia (escaneia de longe). |
| **Página de bloqueio** | `src/blocked/` | "Site bloqueado pelo professor" (+ domínio via `?d=`). |
| **Biblioteca** | `src/lib/` | `firebase.js` (auth REST + verbos + stream SSE), `cloud-client.js` (cmd/state/report/presença), `replay.js` (anti-replay, paridade Dart), `keypair.js` (X25519+HKDF), `crypto.js` (AES-256-GCM), `protocol.js`, `rules.js`, `ipc.js`, `vendor/qrcode.js` (gerador de QR, MIT, vendorizado). |

## Pareamento (QR + TOFU)

- A extensão gera 1x: par X25519 + `deviceId` + **token one-time** (16 bytes).
- Registra `meta/{uid,pub,label}` e `pairing/token` no RTDB e exibe o QR
  `{v:4, id, pub, tok, label}`.
- O professor escaneia → as **rules** validam o token e gravam o `bind`
  (TOFU imposto no servidor: outro professor não sobrescreve).
- A extensão confere o token, **pina** `teacherPub`, deriva a chave de sessão
  (`keypair.js`) e **rotaciona o token** — QRs fotografados morrem.
- Reset pelo popup ("Desvincular professor"): apaga `bind/report/ack/presence`
  do banco, rotaciona o token e volta a exibir o QR.

## Conexão e robustez

- **1 stream SSE** em `/devices/{deviceId}` (put/patch/keep-alive). **Watchdog
  de 90s**: keep-alives chegam ~30s; tampa fechada mata o socket em silêncio —
  sem watchdog a extensão acreditaria estar conectada. Backoff 1s→60s.
- **idToken vive 1h** e vai na URL do EventSource → o refresh agendado recria
  o stream; `auth_revoked` também.
- **Anti-replay persistido** (`replay.js` + `chrome.storage`): reconexão SSE
  re-entrega o nó inteiro; sem o guard, comandos seriam re-executados.
- Presença = `PUT presence/lastSeen` a cada 25s (não há `onDisconnect` fora do
  SDK); report sobe quando as abas mudam ou a cada 60s.

## Permissões

| Permissão | Para quê |
|-----------|----------|
| `tabs` | Abrir/fechar/focar abas, informar URLs/títulos (`tab_report`, sem captura de tela) e bloquear sites (redirect). |
| `wallpaper` | Trocar o papel de parede (só existe em ChromeOS). |
| `offscreen` | Hospedar o cliente Firebase (SSE/auth/timers). |
| `storage` | Par de chaves, vínculo, token de pareamento, auth, anti-replay, regras, nav-log. |
| `alarms` | Reanimar o service worker (que garante o offscreen). |
| `host_permissions` | Só endpoints do Firebase (`*.firebaseio.com`, `*.firebasedatabase.app`, `identitytoolkit`/`securetoken.googleapis.com`) — sem o aviso "ler dados em todos os sites". |

## Pontos de atenção

- **Chrome ≥ 133** (X25519 no WebCrypto).
- **Limites do monitoramento/bloqueio:** janelas anônimas/convidado são
  invisíveis (a menos que a extensão seja permitida no anônimo); iframes não
  disparam o bloqueio (só navegação top-level); pode haver uma "piscada" da
  página antes do redirect; em aparelho não gerenciado o aluno pode desativar a
  extensão — o professor vê o PC ficar **offline**.
- **Regras persistem** em `chrome.storage`: o bloqueio vale mesmo offline.
- **Conta anônima apagada** (não acontece no Auth padrão; só se o projeto for
  upgradeado p/ Identity Platform com "Automatic clean-up" ligado): a extensão
  gera identidade nova e o PC precisa re-parear.
