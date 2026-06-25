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
| **Offscreen document** | `src/offscreen/` | **Dono da `RTCPeerConnection` / `RTCDataChannel`** (papel *offerer*). Roda fora do service worker porque WebRTC não existe em service workers. Cria o offer, aceita o answer e recebe as mensagens do celular. |
| **Service worker** | `src/background/` | Orquestra: cria/garante o offscreen, encaminha mensagens do popup, executa os comandos no navegador (`chrome.tabs`) e atualiza o ícone/status. |
| **Popup** | `src/popup/` | Interface do professor: iniciar pareamento, mostrar o QR #1, **ler o QR #2 com a câmera** (`BarcodeDetector`) e mostrar o status. |
| **Biblioteca** | `src/lib/` | `signal.js` (codificação dos QR), `protocol.js` (mensagens do DataChannel), `ipc.js` (mensagens internas) e `vendor/qrcode.js` (geração de QR). |

### Por que um *offscreen document*?

No Manifest V3, o **service worker não roda WebRTC** e ainda pode ser
**encerrado quando ocioso**. A `RTCPeerConnection` precisa de um documento com
DOM que persista — o *offscreen document* (`chrome.offscreen`, motivo
`WEB_RTC`) cumpre esse papel e sobrevive ao fechamento do popup.

```
popup  ←→  service worker  ←→  offscreen (RTCPeerConnection)
(UI/QR)     (rotas/chrome.tabs)   (conexão com o celular)
```

## Permissões usadas

| Permissão | Para quê |
|-----------|----------|
| `tabs` | Abrir e focar abas (`chrome.tabs.create` / `update`). |
| `offscreen` | Criar o *offscreen document* que hospeda a `RTCPeerConnection`. |
| `storage` | Guardar o pareamento já feito para reconectar sem novo QR (futuro). |
| Câmera (`getUserMedia`) | Ler o QR de resposta do celular durante o pareamento. Solicitada em tempo de uso, não no manifest. |

## Decisões em aberto

- Reconexão automática após o service worker hibernar.
- Suporte a mais de um Chromebook controlado pelo mesmo celular (turma inteira).
- Autenticação/PIN além do QR, para evitar pareamento indevido.
