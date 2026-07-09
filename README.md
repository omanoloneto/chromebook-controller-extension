# Controle de Aula — Extensão (Chromebook)

Extensão Chrome (Manifest V3) que exibe um **QR de pareamento** e, depois de
escaneada pelo professor, recebe comandos via **Firebase Realtime Database**
com **criptografia ponta-a-ponta** — funciona mesmo com Chromebook e celular em
**redes Wi-Fi diferentes**. Faz parte do projeto **Controle de Aula**:

| Componente | Repositório | Papel |
|------------|-------------|-------|
| **Extensão** (este repo) | `chromebook-controller-extension` | Cliente no Chromebook |
| **App de controle** | [`chromebook-controller-app`](https://github.com/omanoloneto/chromebook-controller-app) | Celular do professor |

> ⚠️ **Status:** em desenvolvimento. Protocolo v4 (Firebase) implementado nos
> dois lados; conexão real entre 2 aparelhos ainda não testada em campo.

## Como funciona (pareamento por QR)

- A extensão autentica no Firebase (conta anônima) e **exibe um QR** no popup
  (e em tela cheia). O professor **escaneia 1x** com o app: o PC fica
  **vinculado** (TOFU — vínculo exclusivo, imposto pelas Security Rules; o
  token do QR é de uso único).
- Depois disso a extensão escuta o próprio nó no RTDB por **SSE** e obedece só
  ao professor pinado: abre/fecha abas, aplica bloqueios, troca o papel de
  parede.
- No mesmo canal ela **informa as abas abertas e as URLs visitadas** (somente
  URLs/títulos — **sem captura de tela**), cifradas ponta-a-ponta (o Google não
  vê o conteúdo).
- **Sem SDK do Firebase**: cliente próprio REST + SSE (`src/lib/firebase.js`) —
  MV3 proíbe script remoto e o repo é sem bundler.

```
CHROMEBOOK (esta extensão)        RTDB               APP (professor)
exibe QR {id, pub, token}  ─────►  ◄───────────────  escaneia, grava bind
stream SSE (cmd/state)     ◄─────  ◄───────────────  comandos cifrados
executa, ack, deleta       ─────►
report cifrado + presença  ─────►  ──────────────►   lista/abas no app
```

Detalhes: [`docs/arquitetura.md`](docs/arquitetura.md) e
[`docs/protocolo.md`](docs/protocolo.md).

## Estrutura

```
src/
├── manifest.json
├── offscreen/     # orquestra auth + pareamento + CloudClient (SSE)
├── background/    # service worker (chrome.tabs, alarms, bloqueio, wallpaper)
├── popup/         # QR de pareamento, status, "Desvincular", nome do PC
├── pairing/       # QR em tela cheia
├── blocked/       # página "Site bloqueado pelo professor"
├── lib/           # firebase.js (REST+SSE), cloud-client.js, replay.js,
│   │              # keypair.js (X25519), crypto.js (AES), protocol.js, rules.js
│   └── vendor/    # qrcode.js (gerador de QR, MIT, vendorizado)
firebase/          # espelho das Security Rules (canônico no app) + emuladores
tests/             # rules, replay, firebase (unit) + rules-security (emulador)
```

## Instalação

Requer **Chrome ≥ 133**. Instalação normal: **Chrome Web Store (não listada)**
— link com o mantenedor; o Chrome **atualiza sozinho**. Modo desenvolvedor
(`src/` sem compactação) só para desenvolvimento — unpacked não se
auto-atualiza. Passo a passo em [`docs/instalacao.md`](docs/instalacao.md).

## Releases

`scripts/release.sh X.Y.Z` → tag → GitHub Action zipa e publica na Web Store
(API v2) + cria GitHub Release. Detalhes/segredos em
[`docs/instalacao.md`](docs/instalacao.md#publicar-uma-release-mantenedor).

## Testes

```bash
node --test tests/*.test.mjs          # unit (replay, firebase, rules)
cd firebase && firebase emulators:exec --only database --project demo-test \
  "cd .. && node --test tests/rules-security.test.mjs"   # Security Rules
```

## Roteiro

- [x] Transporte Firebase RTDB (REST + SSE, sem SDK) + Auth anônima
- [x] Pareamento por **QR** (token one-time, rotacionado a cada uso)
- [x] Vínculo exclusivo (TOFU) X25519 + AES-256-GCM ponta-a-ponta
- [x] Comandos **abrir URL** / **fechar abas** / **fechar tudo** (abas ou o
      navegador inteiro — "encerrar aula"); anti-replay persistido
- [x] **Monitorar abas** (somente URLs/títulos, sem captura de tela)
- [x] **Bloqueio de sites** (persiste offline) + página "Site bloqueado"
- [x] **Papel de parede** da turma (`chrome.wallpaper`, só ChromeOS)
- [x] **Nome do PC** editável no popup; **desvincular** com limpeza no banco
- [x] **Auto-update**: Web Store não listada + release por tag (GitHub Action)
- [ ] 1ª publicação na Web Store (manual, pendente)
- [ ] Teste de campo (professor + turma real)
- [ ] Comandos futuros: bloquear tela, mensagem

## Licença

[MIT](LICENSE) © 2026 Mano Afonso (@omanoloneto)
