# Controle de Aula — Extensão (Chromebook)

Extensão Chrome (Manifest V3) que transforma o **Chromebook do professor** em um
aparelho controlável à distância pelo **celular do professor**. Faz parte do
projeto **Controle de Aula**, formado por dois componentes independentes:

| Componente | Repositório | Onde roda |
|------------|-------------|-----------|
| **Extensão** (este repo) | `chromebook-controller-extension` | Chromebook do professor (ligado ao projetor) |
| **App de controle** | [`chromebook-controller-app`](https://github.com/omanoloneto/chromebook-controller-app) | Celular Android do professor |

> ⚠️ **Status:** projeto em fase inicial. Este repositório contém a **estrutura,
> a documentação e os esqueletos de código**. As funções ainda **não estão
> implementadas** — veja o [roteiro](#roteiro).

## Para que serve

O professor liga o Chromebook ao projetor/TV da sala e instala esta extensão.
Pelo celular (app), ele controla o que aparece na tela sem precisar voltar à mesa.

A **primeira função** prevista é **enviar uma URL / abrir uma aba**: o professor
digita ou escolhe um site no celular e ele abre na hora no Chromebook projetado.

## Como funciona (resumo)

- Comunicação **direta entre celular e Chromebook**, pela **rede local** da escola.
- Sem servidor central e **sem nuvem** — usa **WebRTC (DataChannel)**.
- O pareamento é feito por **QR code** (handshake de dois QR codes). Veja
  [`docs/protocolo.md`](docs/protocolo.md).

```
┌─────────────┐   comando (JSON)    ┌──────────────────────┐
│  Celular    │ ──────────────────► │  Chromebook          │
│  (app)      │   WebRTC DataChannel│  (esta extensão)     │
│  controle   │ ◄────────────────── │  abre a aba/URL      │
└─────────────┘        ACK          └──────────────────────┘
        \_______________ rede local da escola _______________/
```

Detalhes em [`docs/arquitetura.md`](docs/arquitetura.md).

## Estrutura do repositório

```
chromebook-controller-extension/
├── src/
│   ├── manifest.json          # Manifest V3
│   ├── background/            # service worker (mantém a conexão WebRTC)
│   ├── popup/                # interface da extensão (pareamento/status)
│   ├── pairing/             # geração e leitura de QR code
│   ├── lib/                # WebRTC e protocolo de mensagens
│   └── icons/             # ícones da extensão (a fazer)
├── docs/                # documentação (arquitetura, protocolo, instalação)
└── README.md
```

## Instalação (desenvolvimento)

Resumo: ative o **Modo do desenvolvedor** em `chrome://extensions`, clique em
**Carregar sem compactação** e aponte para a pasta `src/`. Passo a passo em
[`docs/instalacao.md`](docs/instalacao.md).

## Roteiro

- [ ] Pareamento por QR code (handshake WebRTC sem servidor)
- [ ] Comando **abrir URL / nova aba** (função prioritária)
- [ ] Tela de status da conexão no popup
- [ ] Ícones definitivos
- [ ] Comandos futuros: bloquear/liberar tela, mensagem na tela, fechar abas

## Contribuindo

Veja [`CONTRIBUTING.md`](CONTRIBUTING.md). Toda a documentação do projeto é em
português.

## Licença

[MIT](LICENSE) © 2026 Mano Afonso (@omanoloneto)
