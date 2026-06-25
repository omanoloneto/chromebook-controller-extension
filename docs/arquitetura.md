# Arquitetura — Extensão (Chromebook, cliente)

## Visão geral

O **Controle de Aula** funciona na **rede local**, sem nuvem. Os papéis são:

- **Celular (app) = servidor HTTP** local. Mostra **1 QR** com `{ip, porta, chave}`.
- **Extensão (este repo) = cliente.** Lê o QR (câmera), pede permissão para o IP
  do celular e faz **long-poll** buscando comandos. Quando chega um `open_url`,
  abre a aba no Chromebook.

```
        REDE LOCAL DA ESCOLA (mesma Wi-Fi)
┌────────────────────────────────────────────────────────┐
│   CELULAR (servidor)              CHROMEBOOK (extensão)  │
│   abre porta :p                   offscreen: long-poll   │
│   mostra QR  ── câmera ─────────► pairing: lê o QR        │
│   fila de comandos                                       │
│   open_url ─ cifrado (AES-GCM) ─► abre a aba (chrome.tabs)│
│            ◄──── ACK cifrado ────                         │
└────────────────────────────────────────────────────────┘
```

> **Por que o celular é o servidor?** Uma extensão Chrome MV3 **não pode abrir
> porta** (a API de socket servidor só existia nos Chrome Apps). Como a extensão
> só faz conexões de **saída**, quem escuta tem que ser o celular.

## Componentes da extensão (Manifest V3)

| Parte | Pasta | Responsabilidade |
|-------|-------|------------------|
| **Offscreen document** | `src/offscreen/` | Hospeda o **cliente de long-poll** (`lib/client.js`). Roda fora do service worker porque o loop de `fetch` precisa de um contexto que **não hiberna**. |
| **Service worker** | `src/background/` | Garante o offscreen, salva o pareamento em `chrome.storage.local`, executa `chrome.tabs` (`open_url`), atualiza o ícone e usa `chrome.alarms` para reanimar/reconectar. |
| **Aba de pareamento** | `src/pairing/` | **Lê o QR do celular** (`getUserMedia` + `BarcodeDetector`), pede `host_permission` do IP e salva o pareamento. Roda numa aba porque a câmera não funciona no popup. |
| **Popup** | `src/popup/` | Lançador: mostra status e o botão **Parear** (abre a aba de pareamento). **Sem botão de cancelar.** |
| **Biblioteca** | `src/lib/` | `crypto.js` (AES-256-GCM), `client.js` (long-poll), `protocol.js` (validação de URL/tipos), `ipc.js` (mensagens internas). `pairing/qr.js` decodifica o QR. |

```
popup  →(abre aba)→  pairing  →(salva creds)→  service worker  ⇄  offscreen (long-poll → servidor do celular)
```

## Ciclo de vida (MV3) e reconexão

- O **service worker hiberna** após ~30s ocioso e **não roda WebRTC nem mantém
  loops longos**. Por isso o long-poll vive no **offscreen document** (motivo
  `WORKERS`, sem limite de vida).
- O pareamento `{ip, porta, chave, nome}` fica em `chrome.storage.local`. Um
  `chrome.alarms` periódico reanima o SW, que garante o offscreen vivo — assim a
  conexão **se restabelece sozinha** (não há botão de cancelar/reconectar).

## Local Network Access (LNA) — atenção em Chromebook gerenciado

O Chrome 142+ liga o **LNA** (permissão para acessar a rede local). Extensões com
`host_permission` correto são isentas do prompt, mas correções para extensões só
entraram no **Chrome 144** (inclusive o caso de extensão instalada por política,
comum em escola). Por isso:

- `minimum_chrome_version: "144"`.
- `optional_host_permissions: ["http://*/*"]` + pedido do **IP exato** lido do QR
  (menor superfície e satisfaz o prompt).
- Em frota gerenciada, o admin pode liberar via política
  `LocalNetworkAccessAllowedForUrls`. Ver [`instalacao.md`](instalacao.md).

## Permissões

| Permissão | Para quê |
|-----------|----------|
| `tabs` | Abrir/focar abas (`chrome.tabs.create`/`update`). |
| `offscreen` | Hospedar o cliente de long-poll. |
| `storage` | Guardar o pareamento e reconectar sozinho. |
| `alarms` | Reanimar o service worker e garantir o offscreen. |
| `optional_host_permissions: http://*/*` | Pedido em tempo de uso só para `http://<ip-do-celular>/*`. |
| Câmera (`getUserMedia`) | Ler o QR do celular. Solicitada em tempo de uso, na aba. |

## Decisões em aberto

- Reconexão quando o **IP do celular muda** (sem mDNS, exige reparear).
- Vários Chromebooks controlados pelo mesmo celular (turma).
- Comandos além de `open_url` (bloquear tela, mensagem, fechar abas).
