# Controle de Aula — Extensão (Chromebook)

Extensão Chrome (Manifest V3) que se conecta **sozinha** ao celular do professor
na **rede local** e age no Chromebook (ex.: abrir um site). Faz parte do projeto
**Controle de Aula**:

| Componente | Repositório | Papel |
|------------|-------------|-------|
| **Extensão** (este repo) | `chromebook-controller-extension` | **Cliente** no Chromebook |
| **App de controle** | [`chromebook-controller-app`](https://github.com/omanoloneto/chromebook-controller-app) | **Servidor** no celular Android |

> ⚠️ **Status:** em desenvolvimento. Descoberta automática, vínculo TOFU e o
> comando **abrir URL** já implementados (handshake/cripto validados em teste).
> Conexão real entre 2 aparelhos ainda não testada em campo.

## Como funciona (sem QR)

- O **celular roda um servidor** local (porta fixa 47615) e publica um **banner**.
- A **extensão descobre o celular** varrendo a rede, **vincula-se** ao **primeiro**
  professor que a encontra (**TOFU**) e faz **short-poll** buscando comandos.
- Vínculo **exclusivo**: o PC fica preso àquele celular (chave pública fixada).
- Tudo **criptografado ponta-a-ponta** (X25519 → AES-256-GCM). Sem nuvem.

```
CELULAR (servidor :47615)        CHROMEBOOK (esta extensão, cliente)
GET / -> banner          ◄────   varre a LAN, acha o celular
POST /bind (X25519)      ◄────   TOFU: vincula ao 1o professor
open_url (cifrado) ──────────►   abre a aba (chrome.tabs)
```

Detalhes: [`docs/arquitetura.md`](docs/arquitetura.md) e
[`docs/protocolo.md`](docs/protocolo.md).

## Estrutura

```
src/
├── manifest.json
├── offscreen/     # orquestra descoberta + vínculo + short-poll
├── background/    # service worker (chrome.tabs, alarms, reset/IP manual)
├── popup/         # status do vínculo, "Desvincular", IP manual (fallback)
├── lib/           # discovery.js, keypair.js (X25519), crypto.js (AES), client.js
└── icons/
```

## Instalação

Requer **Chrome ≥ 144**. `chrome://extensions` → Modo do desenvolvedor →
**Carregar sem compactação** → pasta `src/` (aceite o aviso de `http://*/*`,
necessário para varrer a LAN). Passo a passo em
[`docs/instalacao.md`](docs/instalacao.md).

## Roteiro

- [x] Descoberta automática do celular na LAN (varredura, sem QR)
- [x] Vínculo exclusivo (TOFU) com X25519 + AES-256-GCM
- [x] Comando **abrir URL**; reconexão automática (alarms)
- [x] Fallback de IP manual + "Desvincular professor"
- [ ] Robustez em redes grandes/segmentadas (hoje: faixas `/24` comuns)
- [ ] Comandos futuros: bloquear tela, mensagem, fechar abas

## Licença

[MIT](LICENSE) © 2026 Mano Afonso (@omanoloneto)
