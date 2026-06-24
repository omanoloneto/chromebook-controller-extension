# Arquitetura — Extensão (Chromebook)

## Visão geral

O **Controle de Aula** tem dois componentes que conversam **diretamente pela
rede local**, sem nenhum servidor central:

- **App de controle** (celular Android) — envia comandos.
- **Extensão** (este repo, no Chromebook do professor) — recebe comandos e age
  no navegador (por exemplo, abrindo uma URL).

```
        REDE LOCAL DA ESCOLA (mesma Wi-Fi)
┌──────────────────────────────────────────────────────┐
│                                                        │
│   ┌───────────────┐                ┌────────────────┐  │
│   │   Celular     │  WebRTC P2P    │   Chromebook   │  │
│   │   (app)       │ ─────────────► │   (extensão)   │  │
│   │               │   DataChannel  │                │  │
│   │  - escolhe    │ ◄───────────── │  - abre aba    │  │
│   │    a URL      │      ACK       │  - dá foco     │  │
│   └───────────────┘                └────────────────┘  │
│                                                        │
└──────────────────────────────────────────────────────┘
```

## Por que WebRTC na rede local?

- **Sem nuvem, sem custo de servidor.** O `RTCDataChannel` cria um canal P2P
  direto entre os dois aparelhos.
- **Privacidade.** Nenhum dado de aula sai da rede da escola.
- **Latência baixa.** Os dois aparelhos estão no mesmo Wi-Fi; o ICE encontra os
  *host candidates* da LAN e a conexão é direta.

O único ponto difícil do WebRTC sem servidor é a **sinalização** (troca inicial
de SDP/ICE). Resolvemos isso com **QR code** — ver
[`protocolo.md`](protocolo.md).

## Componentes da extensão (Manifest V3)

| Parte | Pasta | Responsabilidade |
|-------|-------|------------------|
| **Service worker** | `src/background/` | Mantém a `RTCPeerConnection`, trata mensagens recebidas e executa os comandos (ex.: `chrome.tabs.create`). |
| **Popup** | `src/popup/` | Interface do professor: iniciar pareamento, mostrar QR, status da conexão. |
| **Pareamento** | `src/pairing/` | Gera o QR do *offer* e lê o QR do *answer* (câmera). |
| **Biblioteca** | `src/lib/` | `webrtc.js` (conexão) e `protocol.js` (formato das mensagens). |

> ⚠️ No Manifest V3 o service worker pode ser **encerrado quando ocioso**.
> Manter uma conexão WebRTC viva exige cuidado (ex.: porta de conexão ativa,
> *keepalive* via DataChannel, ou reabertura rápida). Esse é um ponto de atenção
> da implementação — documentado aqui para não ser esquecido.

## Permissões usadas

| Permissão | Para quê |
|-----------|----------|
| `tabs` | Abrir e focar abas (`chrome.tabs.create` / `update`). |
| `storage` | Guardar o pareamento já feito para reconectar sem novo QR. |
| Câmera (`getUserMedia`) | Ler o QR de resposta do celular durante o pareamento. Solicitada em tempo de uso, não no manifest. |

## Decisões em aberto

- Reconexão automática após o service worker hibernar.
- Suporte a mais de um Chromebook controlado pelo mesmo celular (turma inteira).
- Autenticação/PIN além do QR, para evitar pareamento indevido.
