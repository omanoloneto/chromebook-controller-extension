# Controle de Aula — Extensão (Chromebook)

Extensão Chrome (Manifest V3) que recebe comandos do **celular do professor**
pela **rede local** e age no Chromebook (ex.: abrir um site na tela projetada).
Faz parte do projeto **Controle de Aula**, com dois componentes:

| Componente | Repositório | Papel |
|------------|-------------|-------|
| **Extensão** (este repo) | `chromebook-controller-extension` | **Cliente** no Chromebook |
| **App de controle** | [`chromebook-controller-app`](https://github.com/omanoloneto/chromebook-controller-app) | **Servidor** no celular Android |

> ⚠️ **Status:** em desenvolvimento. O pareamento e o comando **abrir URL** já
> estão implementados. Não testado ainda entre dois aparelhos reais.

## Como funciona

- O **celular roda um servidor** local e mostra **1 QR** (`ip`, `porta`, `chave`).
- A **extensão é cliente**: lê o QR com a câmera, pede permissão para o IP do
  celular e faz **long-poll** buscando comandos.
- Tudo **criptografado ponta-a-ponta** (AES-256-GCM); a chave vai **só no QR**.
- **Sem nuvem, sem servidor central, sem botão de cancelar** (reconecta sozinho).

```
CELULAR (servidor)                         CHROMEBOOK (esta extensão, cliente)
mostra QR {ip,porta,chave} ── câmera ───►  lê o QR, pede permissão do IP
open_url (cifrado) ─────────────────────►  abre a aba (chrome.tabs)
                   ◄──────── ACK cifrado    devolve confirmação
```

> **Por que o celular é o servidor?** Uma extensão MV3 **não pode abrir porta**;
> só faz conexões de saída. Detalhes em [`docs/arquitetura.md`](docs/arquitetura.md)
> e [`docs/protocolo.md`](docs/protocolo.md).

## Estrutura do repositório

```
chromebook-controller-extension/
├── src/
│   ├── manifest.json          # Manifest V3
│   ├── offscreen/            # hospeda o cliente de long-poll (não hiberna)
│   ├── background/          # service worker (orquestra + chrome.tabs + alarms)
│   ├── pairing/            # ABA: lê o QR do celular (câmera) e pede permissão
│   ├── popup/             # lançador: status + botão "Parear"
│   ├── lib/              # crypto.js, client.js, protocol.js, ipc.js
│   └── icons/
├── docs/                # arquitetura, protocolo, instalação
└── README.md
```

## Instalação (desenvolvimento)

Requer **Chrome ≥ 144**. Ative o **Modo do desenvolvedor** em
`chrome://extensions`, **Carregar sem compactação** e aponte para a pasta
`src/`. Passo a passo e notas de rede em [`docs/instalacao.md`](docs/instalacao.md).

## Roteiro

- [x] Pareamento com **1 QR** (lido pelo Chromebook)
- [x] Transporte cifrado (AES-256-GCM) por long-poll HTTP
- [x] Comando **abrir URL / nova aba**
- [x] Reconexão automática (storage + alarms), sem botão de cancelar
- [ ] Reconexão quando o IP do celular muda (sem mDNS)
- [ ] Comandos futuros: bloquear/liberar tela, mensagem, fechar abas

## Contribuindo

Veja [`CONTRIBUTING.md`](CONTRIBUTING.md). Documentação em português.

## Licença

[MIT](LICENSE) © 2026 Mano Afonso (@omanoloneto)
