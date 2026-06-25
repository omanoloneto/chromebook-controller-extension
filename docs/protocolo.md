# Protocolo do Controle de Aula (v3)

> 📌 **Documento compartilhado** — idêntico nos dois repositórios. Ao alterar,
> atualize os **dois**.

Modelo: **celular = servidor** multi-cliente na LAN; **Chromebooks (extensão) =
clientes** que se **descobrem** sozinhos, **vinculam** (TOFU) e fazem short-poll.

```
CELULAR (servidor, porta fixa 47615)        CHROMEBOOK (extensão, cliente)
GET /  -> banner {teacherPub,...}    ◄────   varre a LAN, lê o banner
POST /bind (X25519) -> sessão        ◄────   TOFU: vincula ao 1o professor achado
POST /poll?id (cifrado) -> comando   ◄────   short-poll; abre a aba
POST /ack?id  (cifrado)              ◄────   confirma
```

## 1. Descoberta (banner)

A extensão **não** conhece a própria sub-rede (limite do MV3). Ela **varre faixas
privadas comuns** (`192.168.0/1/2/3.x`, `10.0.0/1.x`, `172.16.0.x`) na **porta
fixa 47615**, fazendo `GET /`. O servidor responde **em claro**:

```json
{ "app": "controle-de-aula", "v": 3, "name": "Professor", "teacherPub": "<base64url 32 bytes>" }
```

`teacherPub` = chave pública X25519 de longo prazo do celular do professor.

> Best-effort: só acha em redes `/24` comuns, **sem client/AP isolation**. Há
> **fallback manual** (informar o IP do celular na extensão).

## 2. Vínculo (TOFU + X25519)

A extensão gera (1x) seu par X25519 (`devicePub`/`devicePriv`) e um `deviceId`.

- `POST /bind` com corpo JSON `{ devicePub, deviceId, label }`.
- O servidor deriva a **chave de sessão** e responde `{ ok: true, teacherPub }`.
- **Derivação (os dois lados):**
  `sessão = HKDF-SHA256( X25519(priv, peerPub), salt="controle-de-aula", info="session-key-v3", 32 bytes )`.
  O segredo **nunca trafega** (derivado independentemente). Há **teste de paridade**
  com vetor fixo (`keypair.js` ↔ `keypair.dart`).
- **TOFU/exclusividade:** a extensão **fixa** a `teacherPub` do 1º professor achado
  e passa a ignorar banners de outras `teacherPub`. Reset: "Desvincular professor".

## 3. Transporte cifrado (por sessão)

Igual ao envelope AES-256-GCM já usado, agora com a **chave de sessão** do passo 2
e **roteado por `deviceId`**:

- `POST /poll?id=<deviceId>` — corpo = envelope `{type:"poll"}`. Resposta 200 com
  envelope de **comando** ou **`pong`**. Resposta **404** = servidor não conhece a
  sessão → a extensão refaz `/bind`.
- `POST /ack?id=<deviceId>` — corpo = envelope `{type:"ack", id, ok, error}`.

**Envelope (base64):** `nonce(12) || ciphertext || tag(16)` (AES-256-GCM). Texto em
claro = JSON `{ seq, ts, type, ... }`. `seq` monotônico **por sessão e por
direção**; janela de `ts` ±120s. Sem AAD (seq/ts vão dentro do JSON autenticado).

### Comando `open_url`
```json
{ "type":"open_url", "id":"a42", "payload":{ "url":"https://...", "newTab":true, "focus":true } }
```
`broadcast` (turma toda) = enfileirar o mesmo comando em todas as sessões.

## 4. Segurança (resumo)

- **AES-256-GCM** ponta-a-ponta; **X25519** deriva a chave (segredo nunca trafega).
- **Anti-replay** por `seq` crescente + janela de `ts`.
- **Exclusividade TOFU:** a extensão fixa a pubkey do professor.
- **Risco aceito:** TOFU é vulnerável a um professor rival que vincule primeiro e a
  MITM ativo **no 1º contato** na LAN. Depois do vínculo, a sessão é cifrada e a
  pubkey fixada. **Fora do escopo:** rede com *client isolation*.

## 5. Tipos reservados (futuro)
`lock_screen`, `unlock_screen`, `show_message`, `close_tabs`, `focus_mode`.
