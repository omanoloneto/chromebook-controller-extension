# Protocolo do Controle de Aula

> 📌 **Documento compartilhado.** Este arquivo é **idêntico** nos dois
> repositórios (`chromebook-controller-extension` e
> `chromebook-controller-app`). Ao alterar o protocolo, atualize os **dois**.

Dois papéis, invertidos em relação ao "WebRTC" antigo:

- **Celular (app) = SERVIDOR HTTP** na rede local (abre uma porta).
- **Chromebook (extensão) = CLIENTE** (só faz requisições de saída — uma extensão
  MV3 não pode abrir porta).

```
CELULAR (servidor)                         CHROMEBOOK (cliente)
mostra QR {ip,porta,chave}  ── câmera ──►   lê o QR, pede permissão do IP
fila de comandos                            POST /poll (long-poll ~25s)
professor digita URL ─► open_url (cifrado)► recebe, abre a aba (chrome.tabs)
                         ◄── POST /ack ───   devolve ACK cifrado
```

---

## 1. Pareamento — 1 QR (lido pelo Chromebook)

O celular mostra **um** QR. O Chromebook escaneia com a câmera (na aba de
pareamento). Conteúdo do QR: **`base64url(JSON)`** (sem padding):

```json
{
  "v": 2,
  "ip": "192.168.1.50",
  "port": 53117,
  "key": "<base64url de 32 bytes>",
  "name": "Celular do professor"
}
```

- `ip`/`port`: onde o servidor do celular está escutando na LAN. Porta efêmera
  aleatória por sessão.
- `key`: chave de **256 bits** (AES). **Só existe no QR** — nunca trafega pela
  rede. O canal físico (câmera) é o que torna o pareamento seguro.

Depois de ler, a extensão pede `host_permission` para `http://<ip>/*` (gesto do
usuário) e passa a fazer long-poll.

---

## 2. Transporte — long-poll HTTP, tudo cifrado

A extensão (cliente) faz requisições ao servidor do celular. Todo **corpo** é um
**envelope cifrado** (texto, base64). Não há `/auth` nem sessão: **a chave do QR
já é a credencial** — quem consegue cifrar/decifrar com ela é a parte pareada.

### Envelope (AES-256-GCM)

Bytes no fio (depois, em base64 padrão): **`nonce(12) || ciphertext || tag(16)`**.
Texto em claro (antes de cifrar) é um JSON UTF-8:

```json
{ "seq": 42, "ts": 1750000000000, "type": "open_url",
  "id": "a42", "payload": { "url": "https://...", "newTab": true, "focus": true } }
```

- `nonce`: 12 bytes aleatórios por mensagem (nunca reutilizar com a mesma chave).
- `seq`: contador monotônico **por direção** (cliente→servidor e servidor→cliente
  têm contadores separados).
- `ts`: epoch em ms.
- **Sem AAD** — `seq`/`ts` já viajam dentro do JSON, autenticado pelo tag do GCM.

> **Interop JS↔Dart:** o Web Crypto **anexa** o tag ao ciphertext; o `SecretBox`
> do Dart mantém separado. Por isso o formato no fio é fixado como
> `nonce || ciphertext || tag`. Há teste de paridade com vetor fixo nos dois
> lados (mesma chave/nonce/plaintext → mesmo envelope).

### Endpoints (todos no servidor do celular)

| Rota | Quem chama | O que faz |
|------|-----------|-----------|
| `GET /` | qualquer | Responde `controle-de-aula` (teste de conectividade crua). |
| `POST /poll` | extensão | Corpo = envelope `{type:"poll"}`. O servidor **segura** a resposta até ter comando ou ~25s; responde 200 com envelope de **comando** ou de **`pong`** (keepalive + autentica o servidor a cada ciclo). |
| `POST /ack` | extensão | Corpo = envelope `{type:"ack", id, ok, error}` referente a um comando. |

Corpo inválido (não decifra, `seq` repetido ou `ts` fora da janela de ±120s) →
**401**, sem vazar detalhe.

### Comando: `open_url` (função prioritária — MVP)

```json
{ "type": "open_url", "id": "a42",
  "payload": { "url": "https://exemplo.com.br", "newTab": true, "focus": true } }
```
Na extensão: valida `url` (http/https) → `chrome.tabs.create`/`update` → responde
`ack`.

### `pong` (keepalive)

```json
{ "type": "pong" }
```
Resposta de `/poll` quando não há comando. Confirma que o servidor está vivo e
detém a chave.

---

## 3. Segurança (resumo)

- **Confidencialidade + integridade:** AES-256-GCM em todo comando/ACK.
- **Autenticação mútua implícita:** só quem tem a chave do QR cifra/decifra.
- **Anti-replay:** `seq` estritamente crescente por direção + janela de `ts` (±120s).
- **Chave fora da rede:** entregue só pelo QR (canal físico via câmera).
- **Menor superfície:** a extensão pede permissão só para `http://<ip-do-celular>/*`.

Ameaça coberta: outro aparelho na mesma Wi-Fi não consegue ler nem injetar
comandos (sem a chave). **Fora do escopo:** rede com *client isolation* (bloqueia
qualquer conexão LAN) e aparelho fisicamente comprometido.

---

## 4. Tipos reservados (futuro)

`lock_screen`, `unlock_screen`, `show_message`, `close_tabs`, `focus_mode`.
Receptor ignora `type` desconhecido e responde `ack` com `ok:false`.
