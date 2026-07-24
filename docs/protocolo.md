# Protocolo do Controle de Aula (v4 — Firebase)

> 📌 **Documento compartilhado** — idêntico nos dois repositórios. Ao alterar,
> atualize os **dois**.

Modelo: **Firebase Realtime Database = transporte** (projeto
`controle-de-aula-f53bd`); **celular (app) e Chromebooks (extensão) = clientes**
do RTDB, cada um autenticado com **Auth anônima**. Não há mais servidor local
nem varredura de LAN — os aparelhos podem estar em **redes diferentes**; basta
internet.

A criptografia ponta-a-ponta **continua a mesma do v3**: X25519 + HKDF derivam a
chave de sessão; comandos/relatórios/acks viajam como **envelopes AES-256-GCM
opacos** — o Firebase nunca vê o conteúdo. Em claro no banco ficam apenas:
metadados de pareamento (chaves públicas, `deviceId`, `label`), presença e o
blob do papel de parede (risco aceito, como no v3).

```
CELULAR (app, professor)          RTDB          CHROMEBOOK (extensão, aluno)
scan do QR ──► grava bind ───────► ◄─────────── exibe QR {id, pub, tok}
cmd/{push} (envelope) ───────────► ◄─ stream ── executa, ack, deleta
state/rules|wallpaper (envelope) ► ◄─ stream ── aplica (persiste offline)
◄──────────── report (envelope) ── ◄─────────── PUT a cada mudança/60s
◄──────────── presence.lastSeen ── ◄─────────── heartbeat 25s
```

## 1. Layout do banco

```
/devices/{deviceId}/
  meta/ {uid, pub, label, v:4, ext} # claro; escrito pela EXTENSÃO (uid = Auth anônima;
                                    # ext = versão da extensão, exibida no app)
  pairing/ {token}                  # token one-time do QR; ninguém lê (só as rules);
                                    # rotacionado após cada bind e cada unbind
  bind/ {teacherUid, teacherPub, teacherName, token, ts, numero?}
                                    # claro; escrito pelo PROFESSOR ao escanear (TOFU).
                                    # numero (app >= 0.13) = unidade 1..9999 DESTE
                                    # professor — MENOR número livre no pareamento
                                    # (app >= 0.14.1; antes: máx+1); re-parear o mesmo
                                    # PC mantém o número. A extensão exibe "Unidade N"
                                    # grande no popup e assume "Unidade N" como label
                                    # (meta/label). Ausente (app antigo): popup cai
                                    # para o label.
  state/
    rules: "<envelope>"             # snapshot de regras (substitui; PC atrasado lê ao conectar)
    wallpaper: "<envelope>"         # comando set_wallpaper vigente
    classview: "<envelope>"         # snapshot da turma p/ o PC do professor (telão);
                                    # ausente/null = este PC não é o telão
    unit: "<envelope>"              # set_unit vigente (número da unidade editado
                                    # pelo professor depois do pareamento)
  cmd/{pushId}: "<envelope>"        # fila professor→PC (open_url, close_tabs);
                                    # o PC deleta após o ack
  ack/{pushId}: "<envelope>"        # PC→professor; pushId = o do cmd correspondente;
                                    # professor deleta ao ler; PC poda além de 20
  report: {env: "<envelope>", ts}   # último tab_report (sobrescreve); ts = serverTimestamp
  snapshot: {env: "<envelope>", ts} # última foto da webcam (camera_snapshot; sobrescreve)
  presence/ {lastSeen}              # heartbeat do PC a cada 25s (serverTimestamp)

/device_uids/{uid}: deviceId        # índice reverso (escrito pela extensão);
                                    # usado só pelas rules (gate do wallpaper)

/teachers/{teacherUid}/
  devices/{deviceId}: true          # roster que o app escuta

/wallpapers/{teacherUid}/ {hash, jpeg, ts}   # jpeg = base64 em claro (risco aceito)

/history/{teacherUid}/{sessionId}/  # histórico de aulas (OPCIONAL, gravado
  meta: "<envelope>"                # pelo APP; a extensão não participa).
  ev/{pushId}: "<envelope>"         # sessionId = epoch-ms do início da aula.
                                    # meta = {turma, inicio, fim?, alunos[]};
                                    # ev = {aluno, eventos:[{url,title,ts}]}.
                                    # TUDO cifrado com chave derivada da
                                    # keypair do professor (HKDF,
                                    # info='history-key-v1') — só o celular
                                    # dele decifra; reinstalar o app torna o
                                    # histórico antigo indecifrável. Rules:
                                    # owner-only. Retenção: até apagar na UI.

/school/                            # workspace da escola (app >= 0.15; SÓ o app —
  meta/ {schoolUid, criadoEm}       # a extensão NUNCA lê /school). Gate nas rules:
  keypair/ {keys, ts}               # professor = auth Google (auth.token.email).
                                    # keys = keypair da ESCOLA em claro (risco
                                    # aceito: modelo aberto — qualquer login
                                    # Google do app entra). Create-once: troca
                                    # de chave só pelo console. schoolUid = uid
                                    # do FUNDADOR (bind/history/wallpaper dele).
  devices/{deviceId}: true          # roster único da escola
  stores/{k}: {rev, env}            # k = turmas|rules|units|names; env =
                                    # arquivo local inteiro {json} cifrado com
                                    # chave HKDF da keypair da escola
                                    # (info 'school-store-v1'); LWW por rev
                                    # (relógio do servidor)
  aulas/{deviceId}: {uid, ts, env}  # trava "1 PC em 1 aula por vez"; env =
                                    # {professor, turma} cifrado; heartbeat
                                    # renova ts; órfã >15min sofre takeover
                                    # (validado nas rules)

/backup/{teacherUid}/               # backup p/ troca de celular (SÓ o app).
  keypair: "<blob PBKDF2+AES>"      # teacher_key.txt cifrado pelo PIN do prof
                                    # (PBKDF2-HMAC-SHA256, salt no blob) — nem
                                    # o banco abre; PIN errado/esquecido = inútil.
  stores: "<envelope>"             # JSONs locais (turmas/nomes/regras/favoritos/
                                    # prefs/aula) cifrados com a chave do
                                    # histórico. Rules owner-only.
```

**Presença:** o cliente REST/SSE não tem `onDisconnect`, então presença é
heartbeat — `PUT presence/lastSeen = serverTimestamp` a cada **25s**. O app
considera **online** se `agora - lastSeen < 60s` (comparação com timestamps do
servidor, corrigida por `.info/serverTimeOffset`).

## 2. Pareamento (QR + TOFU)

A extensão gera (1x) seu par X25519 (`devicePub`/`devicePriv`), um `deviceId` e
um **token de pareamento** (16 bytes aleatórios, base64url). O QR exibido no
Chromebook (popup e página em tela cheia) codifica JSON:

```json
{ "v": 4, "id": "<deviceId>", "pub": "<devicePub b64url>", "tok": "<token b64url>", "label": "Chromebook-ab12" }
```

Fluxo:

1. **Extensão** autentica (Auth anônima), registra `meta/`, `pairing/token` e
   `/device_uids/{uid}`, e fica em estado "aguardando pareamento" escutando o
   próprio nó.
2. **Professor escaneia** o QR com o app. O app deriva a chave de sessão
   (X25519+HKDF, idêntico ao v3) e grava
   `bind = {teacherUid, teacherPub, teacherName, token, ts, numero}` (`numero`
   = unidade sequencial deste professor, ver §1). As **rules**
   validam: `token` igual ao `pairing/token` atual **e** (nó `bind` vazio **ou**
   mesmo `teacherUid`) — **TOFU imposto no servidor**. Em seguida o app grava o
   roster e o estado vigente (`state/rules` sempre, `state/wallpaper` se
   houver; `state/classview` é gravado se este device for o telão, ou
   **deletado** se não for — mata um snapshot órfão de pareamento anterior).
3. **Extensão** vê o `bind` aparecer no stream: confere o token (defesa em
   profundidade), **fixa** `teacherPub` (TOFU), guarda o `numero`, assume
   `Unidade {numero}` como label (atualiza `meta/label`), deriva a chave de
   sessão e **rotaciona** `pairing/token` — o QR escaneado morre. Começa o
   loop normal.

**Derivação (igual ao v3, paridade testada `keypair.js` ↔ `keypair.dart`):**
`sessão = HKDF-SHA256( X25519(priv, peerPub), salt="controle-de-aula", info="session-key-v3", 32 bytes )`.
(O rótulo `session-key-v3` é um label de KDF, não versão do protocolo — mantido
para não invalidar os testes de paridade.)

Casos de borda:

- **QR velho/reusado** → rules rejeitam (token já rotacionado). App mostra "QR
  expirado — abra o popup da extensão".
- **Re-scan pelo mesmo professor** → permitido (mesmo `teacherUid`), mas exige o
  token atual.
- **Desvincular (aluno)** → extensão deleta `bind`, `report`, `ack`, `presence`
  (limpeza de privacidade), rotaciona o token e volta ao estado de pareamento.
- **Esquecer PC (professor)** → app deleta `bind` + entrada no roster; a
  extensão detecta e volta ao pareamento.
- **Reinstalação do app** (chave/uid do professor perdidos) → o `bind` antigo
  fica preso ao `teacherUid` morto; recuperação = aluno desvincula e re-escaneia.
- **Uid anônimo da extensão perdido** → identidade nova (deviceId novo) +
  re-pareamento. Obs.: no Auth padrão contas anônimas **nunca** expiram; o
  "auto-delete" só existe se o projeto for upgradeado para **Identity
  Platform** — nesse caso, manter a limpeza automática **OFF**.

## 3. Transporte cifrado (por sessão)

**Envelope (base64):** `nonce(12) || ciphertext || tag(16)` (AES-256-GCM),
idêntico ao v3. Texto em claro = JSON com cabeçalho **v4**:

```json
{ "sid": 1767369500000, "seq": 7, "ts": 1767369540123, "type": "open_url", ... }
```

- **`sid`** (novo no v4) = época de sessão: epoch-ms amostrado **uma vez** no
  início do processo remetente (app ou documento offscreen). **`seq`** =
  contador monotônico dentro do `sid`.
- **Aceitação (anti-replay, os dois lados):** aceita se `sid > lastSid`
  (época nova → zera contador) **ou** (`sid == lastSid` **e** `seq > lastSeq`);
  então atualiza. O remetente **não** persiste contadores (reinício = `sid`
  novo). O remetente **pode** amostrar um `sid` novo POR MENSAGEM (app ≥ 0.15
  faz isso, no relógio do servidor — necessário no workspace multi-professor:
  com sid fixo por processo, dois celulares alternando comandos no mesmo PC
  derrubariam um ao outro); a regra de aceitação não muda. Racional: o
  Firebase é tratado como transporte não confiável — AEAD barra forja,
  `sid/seq/rev` barra replay.
- **Janela de `ts` por canal** (envelopes agora repousam no banco, não são
  selados na entrega):

| Canal | Guard | Janela de `ts` |
|-------|-------|----------------|
| `cmd/*` (professor→PC) | `(sid,seq)` **persistido** no PC | ≤ 12 h |
| `state/rules` | `payload.rev` monotônico (`>=`), persistido | — (snapshot idempotente) |
| `state/wallpaper` | `payload.hash` ≠ último aplicado | — (cosmético) |
| `state/classview` | `payload.rev` monotônico (`>`), persistido; **delete/envelope ilegível limpa** o snapshot (PC deixa de se considerar telão) | — (snapshot idempotente) |
| `state/unit` | `payload.rev` monotônico (`>`), persistido; ilegível/null **ignora** (número vigente continua — re-pareamento reescreve) | — (snapshot idempotente) |
| `report` (PC→professor) | `(sid,seq)` em memória | ±120 s no recebimento ao vivo; a 1ª leitura ao abrir o app pode ser antiga → aceita, com `lastReportAt` vindo do `ts` (servidor) do nó |
| `ack` | `(sid,seq)` em memória | ±120 s |

O guard de `cmd` é **persistido** no PC porque toda reconexão do stream SSE
re-entrega o nó inteiro (`put` completo) — sem persistência, um comando cujo
delete falhou seria re-executado.

### Comandos one-shot (fila `cmd/`)

Mesmos payloads do v3. O professor **`push()`** um envelope por comando; o PC
executa, grava o ack em `ack/{mesmo pushId}` e **deleta** o cmd.

**`open_url`**
```json
{ "type":"open_url", "id":"a42", "payload":{ "url":"https://...", "newTab":true, "focus":true } }
```
`broadcast` (turma toda) = selar e enfileirar o mesmo comando em **cada** device
(envelopes diferem — cada sessão tem sua chave).

Se o navegador estiver **fechado** (pós "encerrar aula"), o cliente **reabre o
Chrome** com uma janela nova já na URL (`chrome.windows.create`) — a extensão
continua viva sem janelas no ChromeOS.

**`close_tabs`** — exatamente UM de `domain` | `url`. Fechar 0 abas ainda é
`ack {ok:true}` (idempotente). Se fechar todas as abas da janela, o cliente abre
uma aba vazia antes:

```json
{ "v":1, "type":"close_tabs", "id":"a43", "payload":{ "domain":"youtube.com" } }
{ "v":1, "type":"close_tabs", "id":"a44", "payload":{ "url":"https://www.youtube.com/watch?v=abc" } }
```

**`close_all_tabs`** (v0.4.1+) — fecha tudo, sem filtro. `closeWindows`
(default `false`):

- `false` → fecha todas as abas, abrindo **1 aba vazia antes** (não derruba a
  janela) — o "limpar abas" avulso.
- `true` → fecha **todas as janelas** do Chrome (`chrome.windows`) — usado
  pelo "Encerrar aula" do app; no ChromeOS o aluno cai na área de trabalho e a
  extensão continua rodando (offscreen não é janela). Em Chrome desktop (dev),
  fechar a última janela pode encerrar o navegador.

Fechar 0 abas/janelas ainda é `ack {ok:true}` (idempotente). Cliente < 0.4.1
responde `ack {ok:false, error:"tipo_desconhecido"}` — inofensivo.

```json
{ "v":1, "type":"close_all_tabs", "id":"a47", "payload":{ "closeWindows": true } }
```

**`show_message`** (v0.4.2+) — sem `popup`: notificação do sistema no
Chromebook (`chrome.notifications`, priority 2; som = padrão). Usado pelo app
para "apitar" no **PC do professor** quando um aluno acessa site proibido.
Com **`popup: true`** (app ≥ 0.15.2, ext ≥ 0.4.8): abre a página "Mensagem do
professor" em aba nova (mensagem individual professor→aluno); `de` = nome do
professor exibido no título. Extensão antiga ignora os campos extras e degrada
para notificação. Caps no executor: `title` ≤ 100, `body` ≤ 500 (era 200),
`de` ≤ 60. Cliente < 0.4.2: `ack {ok:false, error:"tipo_desconhecido"}`.

```json
{ "v":1, "type":"show_message", "id":"a48", "payload":{ "title":"⚠ William", "body":"youtube.com" } }
{ "v":1, "type":"show_message", "id":"a49", "payload":{ "title":"Mensagem do professor", "body":"Volte para a atividade.", "popup":true, "de":"Prof. Manoel" } }
```

**`capture_camera`** (v0.5.0+) — pede **1 foto da webcam** do aluno. A extensão
captura via `getUserMedia` no offscreen document e grava a imagem **cifrada**
(JPEG base64) em `snapshot/` (não no ack — grande demais). O ack traz só
`ok/erro`. **Exige** a policy do admin `VideoCaptureAllowedUrls` com a origem
`chrome-extension://<id>/` na OU dos alunos — senão `getUserMedia` rejeita com
`NotAllowedError` (o offscreen não tem UI para o prompt). O **LED da câmera
acende** durante a captura (hardware, não desligável).
```json
{ "v":1, "type":"capture_camera", "id":"a51", "payload":{} }
```

**Ack**
```json
{ "type":"ack", "id":"a43", "ok":true }
{ "type":"ack", "id":"a46", "ok":false, "error":"so_chromeos" }
{ "type":"ack", "id":"a51", "ok":false, "error":"camera_NotAllowedError" }
```

### Comandos de estado (`state/`)

`set_rules`, `set_wallpaper`, `set_class_view` e `set_unit` **não** entram na
fila: o app **sobrescreve** `state/*` com o envelope novo. Isso substitui tanto o
antigo "enfileirar substituindo" quanto o reenvio a cada `/bind` — um PC que
conecta atrasado simplesmente **lê `state/*` ao conectar** (o RTDB persiste).
Sem ack para comandos de estado (aplicação é idempotente e guardada por
`rev`/`hash`).

**`set_rules`** — snapshot **completo** das regras de bloqueio (lista vazia
limpa tudo). Só regras de **bloqueio** viajam; regras de **alerta** são
avaliadas apenas no celular. O snapshot **pode variar por PC**: liberações
concedidas pelo professor durante a aula (um site liberado só para um PC) são
simplesmente omitidas do snapshot daquele device — o cliente não sabe nem
precisa saber que existe uma exceção. `rev` = epoch-ms **monotônico por
distribuição** (muda também quando uma liberação entra/sai, não só na edição
das regras). Caps (nos dois lados): ≤ 1000 regras, `pattern` ≤ 200 chars:

```json
{ "v":1, "type":"set_rules", "id":"a45",
  "payload":{ "rev":1767369600000,
    "rules":[ { "pattern":"youtube.com" }, { "pattern":"reddit.com/r/games" } ] } }
```

O cliente persiste as regras (`chrome.storage`) — o bloqueio continua valendo
**offline**. A navegação bloqueada é registrada no navlog **antes** do
redirecionamento e cai na página "Site bloqueado pelo professor".

**Matching normativo** (`regraCasa(pattern, url)` — idêntico em `rules.js` e
`domain_rules.dart`, **inalterado do v3**):

1. URL não-`http(s)` ⇒ nunca casa.
2. `host` = hostname minúsculo.
3. Padrão é **normalizado ao salvar**: trim, minúsculas, sem `http(s)://`, sem
   porta, sem `/` final. `www.` NÃO é removido.
4. Padrão **sem** `/` (domínio): casa se `host == pattern` OU `host` termina em
   `'.' + pattern`. Ex.: `youtube.com` casa `m.youtube.com`, NÃO `notyoutube.com`.
5. Padrão **com** `/` (prefixo): divide no 1º `/`; casa se o host casa (regra 4)
   E o `pathname` minúsculo começa com o restante.

| padrão | URL | casa? |
|---|---|---|
| `youtube.com` | `https://www.youtube.com/watch?v=1` | ✔ |
| `youtube.com` | `https://m.youtube.com/` | ✔ |
| `youtube.com` | `https://notyoutube.com/` | ✖ |
| `youtube.com` | `chrome://extensions` | ✖ |
| `reddit.com/r/games` | `https://www.reddit.com/r/games/top` | ✔ |
| `reddit.com/r/games` | `https://reddit.com/r/other` | ✖ |
| `reddit.com/r/games` | `https://reddit.com/R/GAMES` | ✔ |

**`set_wallpaper`** — o envelope viaja só com o `hash`; o app grava o blob (1x,
compartilhado pela turma) em `/wallpapers/{teacherUid} = {hash, jpeg: base64, ts}`.
O PC busca esse nó via REST (as rules limitam a leitura a devices vinculados),
confere o `hash` e chama `chrome.wallpaper.setWallpaper` (`CENTER_CROPPED`).
Fora do ChromeOS: aplicação falha silenciosa (log) — comandos de estado não têm
ack. Caps: 10 MB decodificado (`imagem_grande`); o app limita o upload a ~4 MB
de imagem:

```json
{ "v":1, "type":"set_wallpaper", "id":"a46", "payload":{ "hash":"9f2ab41c" } }
```

> **Risco aceito (igual ao v3):** o jpeg fica **em claro** no banco, legível
> por qualquer device vinculado àquele professor. É só um papel de parede.

**`set_class_view`** (v0.4.3+) — snapshot da turma para o **PC do professor**
(telão). Os `tab_report` são E2E por par professor↔device, então um PC nunca
lê o que os outros reportam; o **app agrega** (só ele decifra tudo) e
**re-cifra** este snapshot com a chave de sessão do telão, gravando em
`state/classview` **apenas do device marcado como PC do professor**. A
extensão que tem um snapshot válido persistido se considera o telão (papel
implícito — não existe flag separada) e oferece a página "Ver a turma".

- Conteúdo espelha a aba Aula do app: **fora de aula** = todos os PCs
  pareados (sem `aluno`); **aula ativa** = só os PCs vinculados a aluno.
  O telão nunca aparece na própria lista.
- Por PC: `nome`, `aluno?`, `online`, `aba? {titulo, dominio}` (**só o
  domínio da aba ativa — a URL completa não viaja**), `alerta?` (domínio).
  Sem `deviceId` — o telão não precisa de identificadores.
- O app reenvia com `rev` novo quando algo muda (debounce ~1,5 s) **e** a
  cada **60 s** (heartbeat — alimenta o "atualizado há Xs" da página e
  propaga transições online→offline). `rev` = epoch-ms monotônico.
- **Desmarcar o telão / desvincular / re-parear com outro papel** → o app
  **deleta** `state/classview`. Delete, nó ausente no reconnect ou envelope
  ilegível (app reinstalado = chave nova) ⇒ a extensão **limpa** o snapshot
  e deixa de se considerar telão.
- Caps (nos dois lados): ≤ **60** PCs, `nome` ≤ 40, `aluno` ≤ 60,
  `turma` ≤ 60, `titulo` ≤ 120, `dominio`/`alerta` ≤ 100 chars.
- Cliente < 0.4.3 ignora o nó (rota desconhecida em `state/`) — inofensivo.
  O app trata `permission-denied` (rules antigas) como best-effort.

```json
{ "v":1, "type":"set_class_view", "id":"a49",
  "payload":{ "rev":1767369600000,
    "aula":{ "ativa":true, "turma":"8º B" },
    "pcs":[ { "nome":"PC 07", "aluno":"William", "online":true,
              "aba":{ "titulo":"Khan Academy", "dominio":"pt.khanacademy.org" },
              "alerta":"youtube.com" } ] } }
```

> **Risco aceito (por design):** o snapshot (nomes de alunos + título/domínio
> da aba ativa) chega **cifrado** só ao telão, mas a página existe para ser
> **exibida publicamente** (projetor). Quem controla a exposição é o
> professor, abrindo ou não a página.

**`set_unit`** (v0.4.6+) — número da unidade **editado pelo professor** depois
do pareamento (o `bind` é inatualizável: as rules exigem o `pairing/token`
atual, já rotacionado). Vai por estado — não por fila — para sobreviver a PC
offline por dias. A extensão aplica: `binding.numero`, label do PC vira
`Unidade {numero}` (atualiza `meta/label` — o app ouve e sincroniza o nome).
`numero` inteiro 1..9999. O app garante unicidade por professor (número
ocupado = os dois PCs **trocam**). Re-pareamento reescreve `state/unit` com a
chave de sessão nova. Cliente < 0.4.6 ignora a rota — inofensivo.

```json
{ "v":1, "type":"set_unit", "id":"a50", "payload":{ "rev":1767369700000, "numero":2 } }
```

### `tab_report` (PC → professor)

Monitoramento **somente de URLs/títulos — sem captura de tela**. O envelope é
E2E: o Google só vê ciphertext. O PC **sobrescreve** `report = {env, ts}` quando
o estado muda (fingerprint das abas) **ou** a cada **60s** (heartbeat de report;
a presença já cobre o "estou vivo" a cada 25s). Payload interno idêntico ao v3:

```json
{
  "sid": 1767369500000, "seq": 12, "ts": 1767369588456,
  "type": "tab_report", "v": 1,
  "tabs":   [ { "url":"https://...", "title":"...", "active":true } ],
  "events": [ { "url":"https://...", "title":"...", "ts":1767369540123 } ]
}
```

- Só URLs `http`/`https`. Exatamente **uma** aba com `active: true`.
- **Caps** (extensão aplica, app revalida): `tabs` ≤ 30, `events` ≤ 20 (log
  rolante completo), `url` ≤ 300 chars, `title` ≤ 120 chars.
- O app deduplica `events` por `(ts, url)` — robusto a relatórios perdidos.
- Ao desvincular, o PC **deleta** `report`/`ack`/`presence` (limpeza).

### `camera_snapshot` (PC → professor)

Resposta ao `capture_camera`: 1 foto da webcam, cifrada, gravada em
`snapshot: {env, ts}` (sobrescreve). O app decifra e mostra a imagem.

```json
{ "type":"camera_snapshot", "v":1, "id":"a51", "jpegB64":"<jpeg base64>" }
```

- Privacidade: imagem de **menor** — só liga com a policy do admin e o LED
  aceso; base legal/consentimento é responsabilidade da escola (LGPD).

## 4. Security Rules (resumo normativo)

Arquivo canônico: `firebase/database.rules.json` (espelhado nos dois repos).

- `meta` — gravável pelo device; `meta/uid` é **first-write-wins** (fixa o uid).
- `pairing` — gravável só pelo device; **ninguém lê** (as rules leem por dentro).
- `bind` — criação/atualização só com `token == pairing/token` atual **e** (vazio
  OU mesmo `teacherUid`) → TOFU no servidor. Delete: device ou professor vinculado.
- `state`, `cmd` — graváveis só por `bind/teacherUid`; em `cmd` o device pode
  apenas **deletar** (consumir).
- `report`, `ack`, `presence` — graváveis só pelo device (`meta/uid`); em `ack`
  o professor pode apenas deletar.
- Leitura de `/devices/{id}` — só o device e o professor vinculado.
- `/wallpapers/{tUid}` — escrita só do dono; leitura do dono ou de device cujo
  `bind/teacherUid == tUid` (resolvido via `/device_uids/{auth.uid}`).

## 5. Segurança (resumo)

- **AES-256-GCM** ponta-a-ponta; **X25519** deriva a chave (segredo nunca
  trafega nem repousa no banco).
- **Anti-replay** por `sid/seq` (+ `rev`/`hash` nos comandos de estado) e janela
  de `ts` por canal (§3).
- **TOFU duplo:** imposto pelas rules (`bind` não pode ser sobrescrito por outro
  professor) e pela extensão (pina `teacherPub`).
- **Token one-time no QR:** quem não vê a tela do Chromebook não consegue
  vincular; rotacionado após cada uso.
- **Riscos aceitos:** blob do wallpaper em claro no banco; metadados de
  pareamento (pubkeys, labels) em claro; ciphertext do último `report` repousa
  no banco (E2E — só a chave do professor abre; deletado ao desvincular);
  snapshot `classview` repousa cifrado no nó do telão e é exibido publicamente
  por design (§3, `set_class_view`).
- **Histórico de aulas (retenção):** o app grava em `/history` os acessos de
  alunos VINCULADOS durante aulas ativas — cifrado (só o professor decifra),
  apagável na UI (por aula, por aluno ou tudo). Recomenda-se transparência
  com escola/responsáveis.
- **Workspace da escola (aberto):** qualquer conta Google que use o app entra
  no workspace e lê a chave da escola — risco aceito pelo usuário (escola
  pequena). Mitigação futura anotada: restringir por domínio de e-mail nas
  rules (`auth.token.email.endsWith(...)`). O gate de professor nas rules é
  `auth.token.email != null` — NUNCA `auth.provider` (conta linkada emite
  sign_in_provider 'anonymous' + email).
- **Requisitos do console:** Auth anônima ON; rules publicadas. (Auth padrão
  não apaga contas anônimas; só com upgrade p/ Identity Platform existe
  "Automatic clean-up" — manter OFF nesse caso.)

## 6. Tipos reservados (futuro)
`lock_screen`, `unlock_screen`, `focus_mode`.
