# Arquitetura — Extensão (Chromebook, cliente)

## Visão geral

Na rede local, sem nuvem:

- **Celular (app) = servidor** multi-cliente (porta fixa **47615**). Mostra um
  **banner** em `GET /` com sua chave pública.
- **Extensão (este repo) = cliente.** **Descobre** o celular varrendo a LAN,
  **vincula-se** a ele (TOFU) e faz **short-poll** buscando comandos. Ao receber
  `open_url`, abre a aba.

```
        REDE LOCAL (mesma Wi-Fi)
┌──────────────────────────────────────────────────────────┐
│  CELULAR (servidor :47615)        CHROMEBOOK (extensão)   │
│  GET /  -> banner          ◄────  offscreen varre a LAN   │
│  POST /bind (X25519)       ◄────  TOFU: vincula ao 1o     │
│  open_url (cifrado) ───────────►  abre a aba (chrome.tabs)│
│           ◄──── ACK cifrado                               │
└──────────────────────────────────────────────────────────┘
```

> **Por que a extensão é cliente?** MV3 não abre porta, não anuncia mDNS
> (`chrome.mdns` é de Chrome Apps) e não lê o próprio IP (`chrome.system.network`
> idem). Então ela **varre faixas comuns** para achar o celular.

## Componentes

| Parte | Pasta | Responsabilidade |
|-------|-------|------------------|
| **Offscreen** | `src/offscreen/` | Orquestra: descoberta → vínculo (TOFU) → short-poll. Vive fora do service worker (que hiberna). |
| **Service worker** | `src/background/` | Garante o offscreen, `chrome.alarms` (reanima), executa `chrome.tabs`, ícone, reset/IP-manual. |
| **Popup** | `src/popup/` | Status do vínculo, **"Desvincular professor"** e **fallback de IP manual**. |
| **Biblioteca** | `src/lib/` | `discovery.js` (varredura), `keypair.js` (X25519+HKDF), `crypto.js` (AES-256-GCM), `client.js` (short-poll), `protocol.js`, `ipc.js`. |

## Descoberta (best-effort)

`discovery.js` varre `192.168.0/1/2/3.x`, `10.0.0/1.x`, `172.16.0.x` na porta 47615
(lotes com timeout curto, para na 1ª leva que achar). **Só funciona** em rede `/24`
comum **sem client/AP isolation**. Fallback: informar o IP do celular no popup
(`SET_MANUAL_IP`), testado antes da varredura.

## Vínculo exclusivo (TOFU)

- A extensão gera 1x um par X25519 + `deviceId` (em `chrome.storage.local`).
- Ao achar um celular, deriva a chave de sessão (`keypair.js`) e faz `/bind`.
- **Fixa** a `teacherPub` do 1º professor; ignora outros. Reset pelo popup.
- Detalhes do handshake/segurança: [`protocolo.md`](protocolo.md).

## Permissões

| Permissão | Para quê |
|-----------|----------|
| `tabs` | Abrir/focar abas. |
| `offscreen` | Hospedar o orquestrador/cliente. |
| `storage` | Guardar par de chaves, vínculo e dica de IP. |
| `alarms` | Reanimar o service worker. |
| `host_permissions: http://*/*` | **Obrigatória** (aceita na instalação) para varrer a LAN sem prompt por IP. |

## Pontos de atenção

- **Chrome ≥ 144** (LNA, ver `instalacao.md`).
- **`http://*/*`** gera aviso forte na instalação ("ler dados em todos os sites").
- **TOFU:** risco de vínculo rival/MITM no 1º contato (LAN).
- **IP do celular muda** → reconexão automática via redescoberta.
