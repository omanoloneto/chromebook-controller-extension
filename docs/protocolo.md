# Protocolo do Controle de Aula

> 📌 **Documento compartilhado.** Este arquivo é **idêntico** nos dois
> repositórios (`chromebook-controller-extension` e
> `chromebook-controller-app`). Ao alterar o protocolo, atualize os **dois**.
>
> **Versão do protocolo:** `1` (campo `v` em toda mensagem).

O protocolo tem duas partes: **pareamento** (estabelecer a conexão WebRTC sem
servidor) e **mensagens** (comandos trocados depois de conectado).

---

## 1. Pareamento (handshake por QR code)

WebRTC precisa de uma troca inicial de SDP/ICE (a "sinalização"). Como não há
servidor, usamos **dois QR codes**. Papéis:

- **Extensão (Chromebook)** = *offerer* (quem convida).
- **App (celular)** = *answerer* (quem responde).

```
EXTENSÃO (Chromebook)                          APP (celular)
─────────────────────                          ─────────────
1. cria RTCPeerConnection + DataChannel
2. createOffer / setLocalDescription
3. espera o ICE gathering terminar
   (junta os candidatos da rede local)
4. mostra QR #1  ───────────────────────────►  5. escaneia QR #1
   (offer + candidatos)                         6. setRemoteDescription(offer)
                                                7. createAnswer / setLocalDescription
                                                8. espera o ICE gathering terminar
9. escaneia QR #2  ◄─────────────────────────  9. mostra QR #2 (answer + candidatos)
10. setRemoteDescription(answer)
11. DataChannel abre → conectado ✅  ◄────────► conectado ✅
```

> 💡 O passo 9 exige que o **Chromebook leia o QR do celular** (a maioria dos
> Chromebooks tem câmera frontal). É o handshake mínimo, 100% sem servidor.
>
> **Alternativa futura:** um pequeno assistente de sinalização na própria LAN
> para dispensar o segundo QR.

### Conteúdo de cada QR

Cada QR carrega um JSON **comprimido** (para caber). Estrutura antes de comprimir:

```json
{
  "v": 1,
  "role": "offer",            // "offer" no QR #1, "answer" no QR #2
  "sdp": "<descrição SDP completa, já com os candidatos ICE>",
  "name": "Chromebook da Sala 12"
}
```

- O SDP usa *non-trickle ICE*: esperamos juntar todos os candidatos antes de
  gerar o QR, então o SDP já vem completo.
- Recomenda-se comprimir (ex.: deflate + base64url) para reduzir o tamanho do QR.

---

## 2. Mensagens (depois de conectado)

Trafegam pelo `RTCDataChannel` (confiável e ordenado). São **JSON em uma linha**,
codificado em UTF-8.

### Formato base

```json
{
  "v": 1,
  "type": "open_url",
  "id": "f1e2d3c4",          // id único da mensagem (para casar com o ACK)
  "ts": 1750000000000,       // timestamp em ms (epoch)
  "payload": { }              // depende do "type"
}
```

### Comando: `open_url` (função prioritária — MVP)

Pede ao Chromebook para abrir uma URL.

```json
{
  "v": 1,
  "type": "open_url",
  "id": "f1e2d3c4",
  "ts": 1750000000000,
  "payload": {
    "url": "https://exemplo.com.br",
    "newTab": true,           // true = nova aba; false = reusa a aba atual
    "focus": true             // dar foco à aba aberta
  }
}
```

Comportamento esperado na extensão:
- Valida o `url` (apenas `http`/`https`).
- `newTab: true` → `chrome.tabs.create({ url, active: focus })`.
- `newTab: false` → `chrome.tabs.update({ url, active: focus })` na aba ativa.
- Responde com um `ack`.

### Resposta: `ack`

Toda mensagem que pede ação é respondida com um `ack`, casando pelo `id`.

```json
{
  "v": 1,
  "type": "ack",
  "id": "f1e2d3c4",          // mesmo id da mensagem original
  "ts": 1750000000050,
  "ok": true,
  "error": null               // mensagem de erro quando ok = false
}
```

### Manutenção da conexão: `ping` / `pong`

```json
{ "v": 1, "type": "ping", "id": "p1", "ts": 1750000000000 }
{ "v": 1, "type": "pong", "id": "p1", "ts": 1750000000010 }
```

Usados como *keepalive* (importante por causa da hibernação do service worker no
Manifest V3) e para detectar queda de conexão.

---

## 3. Tipos de mensagem reservados (futuro)

Ainda **não implementados**, listados para manter a numeração/nomes coerentes:

| `type` | Significado |
|--------|-------------|
| `lock_screen` | Bloquear/congelar a tela do Chromebook. |
| `unlock_screen` | Liberar a tela. |
| `show_message` | Exibir um aviso em tela cheia. |
| `close_tabs` | Fechar abas (foco em uma só). |
| `focus_mode` | Permitir apenas uma lista de sites. |

---

## 4. Regras de compatibilidade

- O receptor **ignora** mensagens com `type` desconhecido (não derruba a
  conexão) e, se possível, responde `ack` com `ok: false`.
- Mensagens com `v` diferente da versão suportada são rejeitadas com `ack`
  `ok: false` e `error: "versao_incompativel"`.
- Novos campos em `payload` devem ser **opcionais**, para não quebrar versões
  antigas.
