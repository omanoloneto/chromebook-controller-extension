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
metadados de pareamento (chaves públicas, `deviceId`, `label`), presença, o
blob do papel de parede (risco aceito, como no v3) e os metadados do arquivo da
unidade (dias, horários do índice, tamanhos — §7). As fotos arquivadas ficam no
**Cloud Storage** do mesmo projeto (plano Blaze), também cifradas ponta a ponta.

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
                                    # ext = versão da extensão, exibida no app;
                                    # no Celita OS, celita-<versão do pacote> — §6)
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
    lock: "<envelope>"              # set_lock vigente ("Olhos em mim"; o PC guarda
                                    # cópia local e destrava sozinho no prazo `ate`)
    exam: "<envelope>"              # set_exam vigente (modo prova; idem)
    monitor: "<envelope>"           # set_monitor vigente (grade ao vivo; o professor
                                    # renova a cada 10 s e apaga ao fechar a grade)
  cmd/{pushId}: "<envelope>"        # fila professor→PC (open_url, close_tabs);
                                    # o PC deleta após o ack
  ack/{pushId}: "<envelope>"        # PC→professor; pushId = o do cmd correspondente;
                                    # professor deleta ao ler; PC poda além de 20
  up/{pushId}: "<envelope>"         # fila ALUNO→professor (chat, unblock_request,
                                    # raise_hand); o PC poda além de 20 e > 2 h;
                                    # o professor apaga pedido/mão ao agir, nunca
                                    # chat; qualquer professor apaga > 12 h
  report: {env: "<envelope>", ts}   # último tab_report (sobrescreve); ts = serverTimestamp
  snapshot: {env: "<envelope>", ts} # última foto da webcam (camera_snapshot; sobrescreve)
  presence/ {lastSeen}              # heartbeat do PC a cada 25s (serverTimestamp)

/device_uids/{uid}: deviceId        # índice reverso (escrito pela extensão);
                                    # usado só pelas rules (gate do wallpaper)

/handoff/{canal}: {pub, env, ts}    # login entregue ao app do professor no Celita OS
                                    # (§2.1): escrito pelo celular (conta Google),
                                    # lido e apagado pelo computador (Auth anônima)

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

/school/                            # workspace da escola (app >= 0.15; SÓ o app,
                                    # o GTK do Celita e — só schoolUid — o agente;
                                    # a extensão NUNCA lê /school). Escola
                                    # FECHADA: porteiro = MEMBRO (§4).
  meta/ {schoolUid, criadoEm}       # schoolUid = uid do FUNDADOR (bind/history/
                                    # wallpaper dele). meta: lida por qualquer conta
                                    # com e-mail (separa "não há escola" de "não
                                    # liberado"); meta/schoolUid: lida por qualquer
                                    # conta autenticada, inclusive a anônima do
                                    # agente (§7.1). Create-once, pelo próprio
                                    # fundador (e-mail verificado).
  keypair/ {keys, ts}               # keys = keypair da ESCOLA em claro, lida só
                                    # por MEMBRO. Create-once, só por quem já é o
                                    # meta/schoolUid (meta primeiro, depois keypair;
                                    # ou as duas num PATCH). Troca = console.
  members/{emailKey}: true          # e-mails liberados pelo fundador (Ajustes →
                                    # Professores da escola). emailKey = e-mail em
                                    # minúsculas com todo "." trocado por ","
                                    # (ana.silva@escola.com.br → ana,silva@escola,com,br);
                                    # exibir trocando "," por ".". Só o fundador
                                    # escreve; MEMBRO lê a lista; cada conta lê a
                                    # própria entrada. O fundador não precisa de
                                    # entrada (entra pelo uid).
  devices/{deviceId}: true          # roster único da escola
  stores/{k}: {rev, env}            # k = turmas|rules|units|names|prova; env =
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

/home/escola/                       # página inicial dos alunos (SÓ o app).
  rev: 1757300000000                # ÚNICO nó de leitura pública do banco: quem
  cfg: "{\"titulo\":...}"             # lê é escolacelita.com/home, uma página web
                                    # comum, que não tem como se autenticar. O
                                    # conteúdo é uma lista de links — sem aluno,
                                    # sem device, sem nada sigiloso — e por isso
                                    # vai em claro, não cifrado. Escrita só por
                                    # MEMBRO da escola (§4). No Celita OS o
                                    # agente também lê: `cfg.url` vira a política
                                    # do Chromium da página inicial (§6).

/home/menu/ {rev, ids[≤24]}         # apps fixados no menu dos alunos (público,
                                    # escrita MEMBRO); o agente do Celita grava
                                    # /etc/celita/menu-fixados quando a lista muda

/thumbs/{deviceId}/ {env, ts}       # última miniatura da tela (thumb_snapshot), só
                                    # enquanto há state/monitor vigente; o device
                                    # grava, professor/MEMBRO lê e só apaga. Fora de
                                    # /devices/{id} de propósito (streams do nó inteiro)

/archive/{deviceId}/                # arquivo de 15 dias da unidade (SÓ Celita OS,
  nav/{dia}/{pushId}: {env, ts}     # SÓ PC vinculado à escola — §7). Gravado pelo
                                    # agente; lido pelo app. nav = lotes nav-v1
                                    # (env = envelope, ts = serverTimestamp).
  fotos/{dia}/{ts13}: {u, r}        # índice das fotos: ts13 = ms com 13 dígitos;
                                    # u = uid anônimo do agente que enviou; r =
                                    # 16 bytes aleatórios em base64url (22 chars).
                                    # dia = AAAA-MM-DD em UTC−3 (§7.2). Fora de
                                    # /devices/{id} de propósito: agente e
                                    # extensão fazem stream do nó inteiro.
```

**Cloud Storage** (bucket `controle-de-aula-f53bd.firebasestorage.app`):

```
fotos/{uid}/{dia}/{ts13}_{r}.bin    # objeto foto-v1 (§7.3), < 400 KiB; uid, dia,
                                    # ts13 e r iguais aos do índice. Apagado pela
                                    # regra de ciclo de vida do bucket (idade > 15
                                    # dias, prefixo fotos/): firebase/storage-
                                    # lifecycle.json, aplicada no console (§8).
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

### 2.1 Login do app do professor no Celita OS pelo celular

O app do professor no Celita OS (`controle-de-aula-professor`) não tem SDK do
Google. Para ter e-mail nas rules (página inicial, escola) ele **entra na conta
do celular**: mostra um QR com uma chave X25519 efêmera e um canal aleatório;
o celular, já logado no Google, entrega o login cifrado para essa chave.

QR do computador:

```json
{ "v": 1, "t": "login", "c": "<canal 16 bytes b64url>", "pub": "<pub efêmera b64url>" }
```

Fluxo:

1. **Computador** gera o par efêmero e o canal, mostra o QR e escuta
   `/handoff/{canal}`.
2. **Celular** lê o QR (o mesmo leitor do pareamento; `t: "login"` distingue),
   obtém um `id_token` fresco do Google, gera um par efêmero próprio, deriva
   `HKDF(X25519(efêmeraCelular, pubComputador))` (mesma derivação do §2) e grava
   `/handoff/{canal} = {pub: <efêmeraCelular>, env, ts}`, com
   `env = seal({v:1, idToken, keys: "<priv:pub do professor>", teacherName, schoolUid?})`.
3. **Computador** abre o envelope, faz `accounts:signInWithIdp` com o `id_token`
   (**sem** vincular a conta anônima: assume o uid do celular), adota a chave do
   professor, guarda nome e escola, apaga o canal e reinicia o cliente. A partir
   daí é o mesmo professor: mesmo uid, mesma chave, mesmos PCs pareados.

Segurança: só quem viu o QR tem o `pub` do canal; o envelope só abre com a
chave efêmera que nunca sai do computador; o `id_token` expira em 1 h e o canal
é apagado ao ser consumido. As rules aceitam escrita só de conta com e-mail e
apagamento de qualquer conta autenticada.

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
| `state/lock`, `state/exam` | `payload.rev` monotônico (`>=`, igual reaplica), persistido; nulo/ilegível **não muda**; o PC guarda cópia local e destrava no prazo (`ate − env.ts`, teto 2 h / 4 h) | — |
| `state/monitor` | `payload.rev` monotônico (`>`), persistido; nó apagado = para na hora | `env.ts` ±120 s; prazo `ate − env.ts`, teto 45 s |
| `up/*` (PC→professor) | `(sid,seq)` em memória no professor; dedup por `(deviceId, mid)` | ≤ 12 h no passado, ≤ 120 s no futuro |

O guard de `cmd` é **persistido** no PC porque toda reconexão do stream SSE
re-entrega o nó inteiro (`put` completo) — sem persistência, um comando cujo
delete falhou seria re-executado.

**Ids** (app ≥ 0.20.0, GTK do Celita ≥ 0.13.0): `id` de comando e `mid` são
12 bytes aleatórios em base64url (16 caracteres). Cliente novo apaga só ack de
id que ele emitiu; o PC poda o resto (≤ 20) e repete os 20 últimos acks no
`tab_report` (`aplicado.acks`).

**Escritas do PC fora do canal de comandos** (`up`, `/thumbs`): vão pelo
caminho lateral (401/403 renova o token no máximo 1×/10 min e **não**
reconecta streams). Rules atrasadas nunca derrubam o stream de `cmd`.

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
- `fimDeAula: true` (app ≥ 0.20.0; ext ≥ 0.7.0; Celita ≥ 0.13.0) — mandado
  pelo "Encerrar aula": além de fechar, o cliente limpa o histórico do chat,
  fecha a janela de chat, apaga pedidos pendentes e contadores de limite.
  Cliente antigo ignora a chave.

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

**`capture_screen`** (agente Celita ≥ 0.5.0; app ≥ 0.16.0) — pede **1 captura
da tela** do aluno. Só o agente do Celita OS atende (a extensão sozinha responde
`tipo_desconhecido`): a imagem vai cifrada em `snapshot/` com
`type: "screen_snapshot"`, mesmo nó e mesmo formato da foto da câmera. Sem
sessão gráfica de aluno aberta: `ack {ok:false, error:"sem_sessao"}`.
```json
{ "v":1, "type":"capture_screen", "id":"a52", "payload":{} }
```

**`liberar_ias`** (agente Celita ≥ 0.11.0; app ≥ 0.18.0) — libera
(`liberar:true`) ou volta a bloquear as IAs **só na sessão aberta agora** no PC.
O agente guarda o id da sessão (boot + logind) e, enquanto ela for a ativa,
manda à extensão os filtros com `ias:false`; quando a pessoa sai da conta a
liberação morre sozinha. Sem ninguém numa conta controlada:
`ack {ok:false, error:"sem_sessao"}`. O relatório passa a trazer
`iasLiberadas:true` enquanto valer.
```json
{ "v":1, "type":"liberar_ias", "id":"a53", "payload":{ "liberar":true } }
```

**`atualizar`** (agente Celita ≥ 0.12.0; app ≥ 0.19.0) — o PC roda na hora a
mesma verificação do "Atualizar agora" da Central do Celita
(`systemctl start --no-block celita-update-manual.service`). O ack sai antes do
apt, que reinicia o agente no meio. Sem o atualizador:
`ack {ok:false, error:"atualizador_ausente"}`. O app decide quem está
desatualizado comparando `meta/os` com a maior versão do `celita-os-completo`
no índice público do canal (`…/celita-apt/dists/estavel/main/binary-amd64/Packages`);
PC com Celita sem `meta/os` é de antes da 1.24.0 e conta como desatualizado.
```json
{ "v":1, "type":"atualizar", "id":"a54", "payload":{} }
```

**`chat_message`** (app ≥ 0.20.0, ext ≥ 0.7.0, Celita ≥ 0.13.0) — mensagem do
professor para a janela de chat flutuante do aluno. `texto` 1..500, `de` ≤ 60,
`mid` = id aleatório. O PC anexa ao histórico da sessão e abre a janela (se a
tela estiver travada, guarda e abre ao destravar). Celita sem ninguém logado:
`ack {ok:false, error:"sem_sessao"}` — não fica para a próxima sessão. Cliente
antigo: `tipo_desconhecido`; o app então manda `show_message` com `popup:true`.
```json
{ "v":1, "type":"chat_message", "id":"pJ3x0Qm2aZr9Lw1K", "payload":{ "texto":"Abram a página 12.", "de":"Prof. Manoel", "mid":"Zr9Lw1KpJ3x0Qm2a" } }
```

**`unblock_result`** (mesmos mínimos) — resposta a um `unblock_request`.
Aprovado: o cliente espera ter aplicado `state/rules` com `rev ≥ rulesRev` (ou
`state/exam` com `rev ≥ examRev`), até 10 s, e navega toda aba bloqueada
daquele `site` para a URL que ela tentava abrir. Recusado: a página de
bloqueio mostra o motivo e o chat ganha o aviso.
```json
{ "v":1, "type":"unblock_result", "id":"…", "payload":{ "mid":"u…", "site":"pt.khanacademy.org", "approved":true, "rulesRev":1767369600000 } }
{ "v":1, "type":"unblock_result", "id":"…", "payload":{ "mid":"u…", "site":"youtube.com", "approved":false, "motivo":"Depois da prova." } }
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

**`set_rules`** — snapshot **completo** das regras (lista vazia limpa tudo).
`rules` = regras de **bloqueio** ("Bloquear (e me avisar)"); `alerts` = regras
de **aviso** ("Só me avisar"). O snapshot **pode variar por PC**: liberações
concedidas pelo professor (um site liberado só para um PC, com ou sem aula)
são simplesmente omitidas de `rules` daquele device — o cliente não sabe nem
precisa saber que existe uma exceção. `alerts` sai de **todas** as regras de
aviso, sem passar pelo filtro de liberações (liberação só afeta bloqueio). No
telão (PC do professor) as duas listas vão vazias. `rev` = epoch-ms
**monotônico por distribuição** (muda também quando uma liberação entra/sai,
não só na edição das regras). Limitação conhecida: as liberações ficam só no
celular de quem liberou; se outro professor editar as regras de sites, o
snapshot dele vai sem aquela liberação e o PC volta a bloquear (erro para o
lado seguro). Caps (nos dois lados, `rules` e `alerts`):
≤ 1000 regras, `pattern` ≤ 200 chars, mesma normalização:

```json
{ "v":1, "type":"set_rules", "id":"a45",
  "payload":{ "rev":1767369600000,
    "rules":[ { "pattern":"youtube.com" }, { "pattern":"reddit.com/r/games" } ],
    "alerts":[ { "pattern":"jogos.example.com" } ] } }
```

- **`alerts`** (app e GTK do Celita desta entrega): enviado **sempre** (lista,
  possivelmente vazia). O agente do Celita guarda `{rev, rules, alerts}` e usa
  `alerts` só no arquivo da unidade (foto e selo "Aviso", §7); chave `alerts`
  **ausente** (celular com app antigo) = mantém a lista anterior. O agente
  **nunca** repassa `alerts` à extensão; a extensão ignora a chave (chaves
  desconhecidas são ignoradas). A notificação ao professor continua avaliada
  no celular, para bloqueio e aviso.
- **`filtros`** (app ≥ 0.18.0; agente Celita ≥ 0.11.0; extensão ≥ 0.6.0) —
  filtros prontos da escola, enviados **sempre** (no telão, tudo `false`):
  `{shorts, reels, tiktok, ias: bool, canais: ["@handle" | "UC…"]}` (≤ 200
  canais). Vivem no mesmo arquivo das regras (`domain_rules.json`, sincronizado
  pela escola como `school/stores/rules`). Chave **ausente** = o agente mantém os
  anteriores; sem nada recebido ainda vale o padrão **tudo ligado** (pedido do
  usuário). O agente repassa à extensão `{rev, rules, filtros}` já com a
  liberação de IA da sessão aplicada. Na extensão (`src/lib/filtros.js`):
  - **URL** (service worker, `motivoFiltro`): `tiktok.com`; `youtube.com/shorts…`;
    `instagram.com/reels`, `/reel/…` e a aba Reels do perfil; a lista de IAs
    (`DOMINIOS_IA`: Gemini, AI Studio, NotebookLM, ChatGPT, Claude, Copilot,
    Perplexity, DeepSeek, Meta AI, Grok, Character.ai, Poe, Mistral, Pi, You,
    Phind, Blackbox, Qwen, Kimi, Duck.ai, labs.google) mais o Modo IA do Google
    (`/search?udm=50`), `bing.com/chat|copilotsearch` e `huggingface.co/chat`;
    `youtube.com/@canal` e `/channel/UC…` dos canais bloqueados.
  - **Página** (content scripts em `src/filtros/`, document_start, reagem a
    `chrome.storage.onChanged`): YouTube esconde prateleiras, cartões, abas,
    chip e atalhos de Shorts e os cartões dos canais bloqueados; no `/watch` o
    dono do vídeo é mandado ao service worker (`{t:'cda-canal', handle, id}`),
    que bloqueia a aba se o canal estiver na lista. Instagram esconde o botão e
    os links de Reels e os posts que são reel. Google esconde o botão do Modo IA
    e o bloco do resumo de IA, achado pelo título ("Visão geral criada por IA"
    / "AI Overview") — sem forçar `udm=14` (decisão do usuário).
  - A página de bloqueio recebe `?m=<motivo>` e mostra o texto do filtro.

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
confere o `hash` e aplica: no ChromeOS, `chrome.wallpaper.setWallpaper`
(`CENTER_CROPPED`); no Celita OS, o agente grava o JPEG em
`/var/lib/controle-de-aula/wallpaper.jpg` e aponta o `last-image` do xfdesktop
para ele, na sessão do aluno. O app persiste o hash vigente e o reenvia a cada
PC que (re)pareia. Caps: 10 MB decodificado (`imagem_grande`); o app limita o
upload a ~4 MB de imagem:

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

**`set_lock`** — "Olhos em mim" (app ≥ 0.20.0, ext ≥ 0.7.0, Celita ≥ 0.13.0).
`{rev, on, texto ≤200, mute, ate}` em `state/lock`. O app renova `ate = agora
+ 20 min` a cada 5 min enquanto `on`; o PC destrava sozinho em `agora +
clamp(ate − env.ts, 0, 2 h)` e guarda cópia local (volta travado depois de
reboot sem rede). Destravar = `on:false` (nunca apagar o nó). Celita: overlay
GTK em tela cheia em cada monitor, serviço transitório do systemd como o
aluno (respawn em 1 s, fora do cgroup do agente), grab de teclado/ponteiro,
`srvrkeys:none` enquanto travado, mute com `pactl` restaurado depois; conta de
aluno não entra no tty. ChromeOS: janela em tela cheia que se re-foca, abas
novas fechadas, abas mutadas; **não** trava atalhos do sistema nem apps fora
do Chrome. Cliente antigo ignora o nó; o app conta o PC como "versão antiga".
```json
{ "v":1, "type":"set_lock", "id":"…", "payload":{ "rev":1767369600000, "on":true, "texto":"Olhos no professor", "mute":true, "ate":1767370800000 } }
```

**`set_exam`** — modo prova (mesmos mínimos). `{rev, on, allow:[{pattern}]
≤1000, inicio?, ate}` em `state/exam`, **separado de `state/rules`** (quem
redistribui regras não desliga a prova). `allow` = lista da escola + liberações
deste PC; `inicio` = página inicial da escola. Com `on`, a URL de topo: (1)
página da extensão, nova aba, `about:blank` → libera; (2) esquema não http(s)
→ bloqueia; (3) host de `inicio` + prefixo do caminho → libera; (4) casa
`allow` (`regraCasa`) → só os filtros valem; (5) senão bloqueia com
`?m=prova`. `ate = agora + 2 h`, renovado a cada 5 min; teto 4 h. Iframes e
apps Android não são cobertos. Celita: o agente repassa `prova` à extensão no
`rules` da ponte e só confirma com a ponte ≥ 0.7.0 (senão fecha o navegador
uma vez para reabrir com a extensão nova).
```json
{ "v":1, "type":"set_exam", "id":"…", "payload":{ "rev":1767369600000, "on":true, "allow":[{"pattern":"khanacademy.org"}], "inicio":"https://escola.edu.br/portal", "ate":1767376800000 } }
```

**`set_monitor`** — grade ao vivo (mesmos mínimos). `{rev, ate}` em
`state/monitor`, renovado a cada 10 s com `ate = agora + 30 s` enquanto a
grade está aberta; apagado ao fechar. O PC aceita só `env.ts` a ±120 s do seu
relógio, captura a cada 10 s até `agora + clamp(ate − env.ts, 0, 45 s)` e
grava `/thumbs/{id}`; ao vencer, apaga a miniatura. Celita: a tela inteira
(`scrot -t 480x0`). ChromeOS: a aba ativa da janela em foco
(`captureVisibleTab`), só com a permissão opcional `<all_urls>` concedida no
popup; sem ela, marcador `sem_permissao`.
```json
{ "v":1, "type":"set_monitor", "id":"…", "payload":{ "rev":1767369600000, "ate":1767369630000 } }
```

### `tab_report` (PC → professor)

Monitoramento **somente de URLs/títulos** (as imagens vão por outros caminhos:
`snapshot/` sob demanda e o arquivo da unidade, §7). O envelope é
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

- **`bloqueio`** (extensão ≥ 0.6.0, opcional em cada evento, ≤ 20): motivo com
  que a extensão bloqueou a tentativa — `regra`, `shorts`, `reels`, `tiktok`,
  `ia`, `canal`. O agente trata qualquer evento marcado como tentativa
  bloqueada (foto e selo no arquivo, §7); o app notifica "Tentativa de site
  bloqueado" pelos motivos de filtro, que ele não reavalia.
- **`iasLiberadas`** (agente Celita ≥ 0.11.0): `true` enquanto `liberar_ias`
  valer na sessão aberta.
- **`aplicado`** (ext ≥ 0.7.0, Celita ≥ 0.13.0): confirmação positiva —
  `{trava:{rev, on, erro?}, prova:{rev, on, erro?}, acks:[{id, ok, error?}] ≤20}`.
  `erro` ∈ `sem_sessao` (Celita sem ninguém logado: armado),
  `navegador_antigo` (Celita com ponte < 0.7.0). O PC manda relatório logo
  depois de aplicar estado ou responder comando. O professor só afirma
  "travado ✓", "em prova ✓" ou "recebeu ✓" por ack ou por `aplicado`.

- Só URLs `http`/`https`. Exatamente **uma** aba com `active: true`.
- **Celita OS (agente ≥ 0.5.0):** dois campos a mais, exibidos pelo app
  ≥ 0.16.0 na tela do PC (ausentes no relatório da extensão, que segue só com
  abas): `apps` = janelas abertas fora do navegador
  (`[{name, title}]`, ≤ 30, `name` ≤ 40, `title` ≤ 120) e `user` = conta
  logada (≤ 32). Navegador fechado ⇒ `tabs`/`events` vazios, `apps` continua.
  `apps` segue o **critério da barra de tarefas**, lido direto do X
  (`python3-xlib`, sem XFCE e sem lista de nomes): janelas de
  `_NET_CLIENT_LIST` do tipo NORMAL (ou sem tipo e sem `WM_TRANSIENT_FOR`) e
  sem `_NET_WM_STATE_SKIP_TASKBAR`. O navegador (WM_CLASS `voges`/`chromium`)
  só some da lista quando há relatório fresco da extensão; sem ele, aparece
  como "Google Chrome". `name` = `Name=` do `.desktop` cujo `StartupWMClass`
  (ou nome do arquivo) casa com o WM_CLASS; reserva `/proc/<pid>/comm`.
- **Caps** (extensão aplica, app revalida): `tabs` ≤ 30, `events` ≤ 20 (log
  rolante completo), `url` ≤ 300 chars, `title` ≤ 120 chars.
- O app deduplica `events` por `(ts, url)` — robusto a relatórios perdidos.
- Ao desvincular, o PC **deleta** `report`/`ack`/`presence` (limpeza).

### `up` (PC → professor)

Fila do aluno em `up/{pushId}` (POST; id do servidor). Texto em claro:
`{sid, seq, ts, v:1, type, mid, payload}`, selado com a session key.

| type | payload |
|---|---|
| `chat` | `{texto 1..500}` |
| `unblock_request` | `{site, url ≤500, motivo ≤200, bloqueio:"regra"\|"prova"}` |
| `raise_hand` | `{}` |

- `site` = host minúsculo `^[a-z0-9.-]{1,100}$`, ≥ 2 rótulos, nunca sufixo
  público (`com`, `com.br`, `gov.br`…); quem recebe descarta o inválido.
- Rate-limit no PC (persistido): chat 1/2 s e 30/h por login; pedido 1 por
  site/60 s e ≤ 5 pendentes; mão 1/10 s. O professor mostra ≤ 20 pendentes por
  PC e silencia 10 min o PC que passar de 20 itens em 10 min.
- Destinatário: sem escola, o professor vinculado; na escola, quem tem a
  reserva viva do PC em `/school/aulas` (com notificação); PC livre aparece a
  todo MEMBRO, sem notificação; PC reservado por outro é ignorado (nem lido,
  nem apagado).
- Apaga: pedido/mão — quem agir; chat — ninguém (o PC poda > 2 h e > 20);
  qualquer professor apaga > 12 h.

### `thumb_snapshot` (PC → professor)

`/thumbs/{deviceId} = {env, ts}`; `env` = `{v:1, type:"thumb_snapshot",
jpegB64|null, w, h, motivo?}`, JPEG ≤ 480 px de largura, q 60, alvo < 40 KB.
`motivo` ∈ `sem_sessao`, `sem_permissao`, `aba_protegida`, `falhou` (com
`jpegB64:null`). Nunca arquivada.

### `camera_snapshot` / `screen_snapshot` (PC → professor)

Resposta ao `capture_camera` (ou `capture_screen`): 1 imagem, cifrada,
gravada em `snapshot: {env, ts}` (sobrescreve). O app decifra e mostra a
imagem; o `type` diz se é a webcam ou a tela.

```json
{ "type":"camera_snapshot", "v":1, "id":"a51", "jpegB64":"<jpeg base64>" }
{ "type":"screen_snapshot", "v":1, "id":"a52", "jpegB64":"<jpeg base64>" }
```

- Privacidade: imagem de **menor** — só liga com a policy do admin e o LED
  aceso; base legal/consentimento é responsabilidade da escola (LGPD).

## 4. Security Rules (resumo normativo)

Arquivo canônico: `firebase/database.rules.json` (espelhado nos dois repos).

- `meta` — gravável pelo device; `meta/uid` é **first-write-wins** (fixa o uid).
- `pairing` — gravável só pelo device; **ninguém lê** (as rules leem por dentro).
- `bind` — criação/atualização só com `token == pairing/token` atual **e** (vazio
  OU mesmo `teacherUid`) → TOFU no servidor. Delete: device, professor vinculado
  ou MEMBRO da escola.
- `state`, `cmd` — graváveis por `bind/teacherUid` ou MEMBRO; em `cmd` o device pode
  apenas **deletar** (consumir).
- `report`, `ack`, `presence` — graváveis só pelo device (`meta/uid`); em `ack`
  o professor pode apenas deletar.
- `up` — o device cria filhos (string < 4096; o nó precisa ter filhos); o
  professor vinculado ou MEMBRO pode apenas apagar filhos.
- `state` aceita também `lock`, `exam`, `monitor`.
- `/thumbs/{id}` — `.read` = device, professor vinculado ou MEMBRO; o device
  grava `{env < 262144, ts}` e nada mais; professor/MEMBRO só apaga.
- `/home/menu` — leitura pública; escrita MEMBRO; `rev` obrigatório; `ids/$i`
  com `$i` 0..23 e valor `^[A-Za-z0-9._-]+[.]desktop$` (≤ 64).
- `school/stores/{k}` aceita também `prova`.
- Leitura de `/devices/{id}` — o device, o professor vinculado e MEMBRO da escola.
- `/wallpapers/{tUid}` — escrita só do dono; leitura do dono ou de device cujo
  `bind/teacherUid == tUid` (resolvido via `/device_uids/{auth.uid}`).

**Escola fechada — expressão MEMBRO** (inline em cada regra que antes usava
`auth.token.email != null` como porteiro da escola):

```
(auth != null && (root.child('school/meta/schoolUid').val() === auth.uid || (auth.token.email != null && auth.token.email_verified === true && root.child('school/members').child(auth.token.email.toLowerCase().replace('.', ',')).val() === true)))
```

O `replace` do RTDB é literal e troca **todas** as ocorrências (provado no
emulador). O fundador passa pelo uid, sem entrada em `members`; os demais
precisam de e-mail **verificado** e da entrada `true`.

- MEMBRO vale em: `devices/{id}/.read`; as cláusulas de e-mail de `bind`;
  `state`; `cmd`; `ack/{pushId}`; `school/keypair/.read`; `school/devices`,
  `stores` e `aulas`; `history/{tUid}`; `home/escola/.write`; `wallpapers/{tUid}`.
- Continuam como antes: `handoff`, `teachers`, `backup`, `device_uids`, os
  caminhos do dono do PC (`meta/uid`) e os do professor isolado
  (`bind/teacherUid === auth.uid`).
- `school/meta` — `.read` = conta com e-mail; `schoolUid/.read` = qualquer
  conta autenticada; `.write` = só criação (`!data.exists()`), por conta com
  e-mail verificado, com `schoolUid === auth.uid`.
- `school/keypair/.write` = só criação, e só se `meta/schoolUid` (já gravado
  ou no mesmo PATCH) for o próprio `auth.uid`.
- `school/members` — `.read` = MEMBRO; `.write` = só o fundador;
  `members/{emailKey}/.read` = a própria conta (e-mail verificado, chave
  igual); `.validate` = valor `true` e chave `^[a-z0-9,_+'-]+@[a-z0-9,-]+$`
  (o app recusa e-mails com `$ # [ ] /` ou espaço).

**Arquivo `/archive/{deviceId}`** — DONO = `devices/{id}/meta/uid === auth.uid`;
ESCOLA = `school/meta/schoolUid` existe **e** `devices/{id}/bind/teacherUid`
é igual a ele (a guarda `exists()` impede `null === null` num PC sem vínculo).

- `.read` = DONO ou MEMBRO; `.write` no nó inteiro = só apagar, por DONO ou
  MEMBRO.
- `nav/{dia}` e `fotos/{dia}` — gravar = DONO **e** ESCOLA; apagar = DONO ou
  MEMBRO. `dia` casa `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` e o valor precisa ter
  filhos (nada de valor cru no dia).
- `nav/{dia}/{k}` = `{env: string < 65536, ts: number}`, nada mais.
- `fotos/{dia}/{ts13}` — `ts13` casa `^[0-9]{13}$`; `{u, r}` com
  `u === auth.uid` e `r` casando `^[A-Za-z0-9_-]{22}$`, nada mais.
- Qualquer outro filho de `archive/{id}` é recusado.

**Storage** — arquivo canônico `firebase/storage.rules` (espelhado nos dois
repos, como o `database.rules.json`; o `firebase.json` dos dois aponta as duas
rules e sobe os emuladores `database` e `storage`):

- `fotos/{deviceUid}/{day}/{file}` — `create`/`update` só pelo próprio
  `deviceUid`, com `day` no formato acima, `file` casando
  `^[0-9]{13}_[A-Za-z0-9_-]{22}[.]bin$` e tamanho < 400 KiB (`update`
  existe para o reenvio após timeout ser inofensivo); `get` = qualquer conta
  com `email_verified`; `delete` = só o próprio `deviceUid`.
- **Sem `list`** e todo o resto negado: o índice vive no RTDB atrás de
  MEMBRO e o nome leva 128 bits aleatórios (`r`), então só quem lê o índice
  monta o caminho.

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
  Chat, pedidos de liberação e miniaturas são cifrados com a chave do par
  PC↔escola, então **todo MEMBRO da escola** consegue decifrá-los; a separação
  "só o professor da aula vê" é de interface, não criptográfica. Miniaturas
  repousam em `/thumbs` só enquanto alguém olha a grade (PC e professor
  apagam), nunca são arquivadas, e não há aviso ao aluno (escolha do dono; a
  escola informa os responsáveis — LGPD). "Olhos em mim" não é lockdown: no
  Celita, um programa do aluno iniciado antes da trava pode brigar com o
  overlay (X11 não isola clientes); no ChromeOS, atalhos e apps fora do Chrome
  continuam acessíveis.
- **Histórico de aulas (retenção):** o app grava em `/history` os acessos de
  alunos VINCULADOS durante aulas ativas — cifrado (só o professor decifra),
  apagável na UI (por aula, por aluno ou tudo). Recomenda-se transparência
  com escola/responsáveis.
- **Escola fechada (lista de e-mails):** só o fundador e os e-mails que ele
  liberou em `/school/members` (Ajustes → Professores da escola) leem a chave
  da escola e os nós da escola. Quem não foi liberado vê "Seu e-mail (x) ainda
  não foi liberado. Peça ao professor que criou a escola para liberar em
  Ajustes → Professores da escola." (mesmo texto no app e no GTK do Celita),
  sem sair da escola nem mexer na chave. Ao abrir, o app confere a própria
  entrada, mas erro de rede ou demora (> 10 s) deixa seguir — as rules barram
  no servidor e o `permission-denied` do roster leva ao mesmo aviso; "Entrar
  na escola" só adota a chave depois de conferir. Limites registrados: o
  fechamento **não é retroativo** (até o deploy, qualquer conta Google lia a
  chave) e tirar alguém de `members` **não revoga** a chave que já está no
  celular/backup dele — revogar de verdade = trocar a keypair da escola e
  parear de novo. O porteiro nas rules usa `auth.token.email` — NUNCA
  `auth.provider` (conta linkada emite sign_in_provider 'anonymous' + email).
- **Arquivo da unidade (§7):** fotos e histórico cifrados ponta a ponta com
  a chave de sessão do par PC↔escola; 15 dias; só Celita OS; só PC vinculado
  à escola. Metadados em claro aceitos: dias, `ts13` do índice, tamanhos dos
  objetos. O `get` do Storage exige só e-mail verificado (as rules do Storage
  não leem o RTDB): quem guardou caminhos do índice (ex.: ex-membro) ainda
  baixa o objeto cifrado até ele expirar. Sem aviso visível no PC; a escola,
  como controladora, informa os responsáveis pelos próprios canais (LGPD
  art. 14).
- **Requisitos do console:** Auth anônima ON; rules publicadas. (Auth padrão
  não apaga contas anônimas; só com upgrade p/ Identity Platform existe
  "Automatic clean-up" — manter OFF nesse caso.)

## 6. Cliente Celita OS (agente do sistema)

No Celita OS o cliente do protocolo **não é a extensão**: é o
`controle-de-aula-agent`, um serviço do sistema (Python, systemd) que sobe no
boot e mantém identidade, pareamento, stream, presença e relatório — tudo
acima, sem mudança de formato. A extensão no Voges vira só o braço para abas,
ligada ao agente por native messaging. Consequências para o app: o PC aparece
online desde a tela de login, o `tab_report` chega com `tabs` vazias enquanto
ninguém abriu o navegador, `meta/ext` vem como `celita-<versão>`, e os tipos
`capture_screen`/`screen_snapshot` e os campos `apps`/`user` só existem nesse
cliente. O pareamento por QR é o mesmo (a extensão exibe o QR que o agente
gera).

- **`meta/ext` = `celita-<versão do pacote>`**: o build do `.deb` grava a
  versão do pacote no `VERSION` do agente (e falha se não trocar exatamente
  uma linha). **`meta/os`** (agente ≥ 0.12.0, ≤ 20 caracteres) = versão
  instalada do `celita-os-completo` (`dpkg-query`), lida a cada registro — o
  apt reinicia o agente ao atualizar, então ela acompanha. É a que o app mostra
  entre parênteses ao lado do nome do PC (app ≥ 0.19.0), com
  " · desatualizado" quando for mais velha que a publicada no canal.
- **Página inicial:** o agente lê `/home/escola` (público) ao conectar, a
  cada sessão nova e a cada 60 s. Com resposta 200 e `cfg.url` válida
  (http/https, ≤ 2048) grava a política gerenciada
  `/etc/chromium/policies/managed/controle-de-aula-inicio.json`
  (`HomepageLocation`, `RestoreOnStartupURLs`, botão Início), só se mudou;
  nó `null` ou sem `url` válida apaga o arquivo; erro de rede/HTTP não mexe.
  A nova aba continua sendo a página do Celita (não redireciona).
- **Chamadas laterais** (arquivo, Storage, `/home/escola`,
  `school/meta/schoolUid`): 401/403 renova o token no máximo 1 vez a cada
  10 min, sem reconectar os streams; negação persistente = backoff de 10 min
  daquela funcionalidade.
- **Chat do aluno, trava e miniaturas** (agente ≥ 0.13.0): a janela
  "Falar com o professor" e o overlay da trava rodam como serviços
  transitórios do systemd com o uid do aluno (fora do cgroup do agente);
  a janela fala com o agente por `/run/controle-de-aula/aluno.sock` (grupo
  `nopasswdlogin`, só a sessão ativa). O histórico do chat fica no agente,
  por sessão. Miniaturas: `scrot -t 480x0` num diretório root `0711` com
  arquivos pré-criados para o aluno; leitura sem seguir links, só arquivo
  regular do uid certo, ≤ 256 KiB.
- **Apps fixados da escola:** o agente lê `/home/menu` junto com
  `/home/escola` e grava `/etc/celita/menu-fixados` (linha-marca
  `# controle-de-aula:`) só quando a lista muda; remove só arquivo com a
  marca. O "Fixar para todos" do menu grava o mesmo arquivo: vale o último.

## 7. Arquivo da unidade (fotos e histórico — Celita OS)

Pedido do usuário (2026-09-28). Só o agente do Celita grava; só o app lê.
Chave = **session key do par PC↔escola** (a mesma dos reports). A extensão
dos Chromebooks (ChromeOS) não participa.

### 7.1 Quem coleta e quando

- **Só PC vinculado à escola:** `bind.teacherUid == /school/meta/schoolUid`
  (o agente lê `schoolUid` com a conta anônima, guarda em cache e revê a cada
  conexão). Fora disso (professor isolado, que é anônimo e não teria como ver
  as fotos) não fotografa, não arquiva e descarta as filas. Desvincular
  descarta filas e cursores; o que já subiu fica (a retenção cuida).
- **Fotos (webcam) em qualquer conta** — aluno ou professor, inclusive no PC
  do professor: sessão gráfica ativa de conta humana (logind: Class=user,
  State=active, x11/wayland, uid ≥ 1000). Foto `login` ~10 s depois da entrada
  na conta; depois `login + 30 min·k` (`periodica`). Falha de captura: repete
  em 60 s, até 3 vezes, sem mexer no agendamento. Sessão que termina antes da
  foto de login não gera foto. Sem aviso visível no PC.
- **Tentativas** (`bloqueado`/`alerta`) e **histórico**: só nas contas
  controladas (onde a extensão roda e manda `report` pela ponte). O agente
  compara cada evento novo com `rules` (→ `bloqueado`, tem precedência) e
  `alerts` (→ `alerta`) pelo matching normativo; tentativa tira foto na hora,
  no máximo 1 a cada 60 s (evento dentro da janela reaproveita a última foto,
  se ela saiu) e não mexe no agendamento. O evento só ganha `foto` se a
  captura deu certo.
- Eventos com `ts` antes da entrada na conta (o navlog da extensão sobrevive
  entre sessões) ou mais de 60 s no futuro são ignorados. Dois cursores por
  sessão: um de exame (detecção) e um de envio (histórico, só avança com POST
  bem-sucedido), com dedup `ts|url` na fronteira.
- **Fila local** em `/var/lib/controle-de-aula`: toda foto é cifrada e gravada
  primeiro em `fotos-pendentes/` (dir 0700, arquivos 0600, teto 48, descarta
  > 15 dias) e só depois enviada; o histórico passa por `nav-pendente.json`
  (0600, teto 2000 eventos, descarta > 15 dias).

### 7.2 Dia e relógio

- **Dia** = data de `(ts_ms − 3 h)` em UTC (`AAAA-MM-DD`) — São Paulo é UTC−3
  fixo desde 2019. Mesma função no agente e no app (paridade testada perto da
  meia-noite UTC). O app nunca usa a data local do celular para nomes de nó;
  horas exibidas ficam no fuso do celular.
- **Relógio do PC:** o agente mede `offset = Date das respostas do Firebase
  − hora local` (RTDB e Storage; respostas sem `Date` não contam). Só com
  `|offset| > 2 min` o offset é somado ao que **sai** do PC: `ts` e nome da
  foto, `ts` dos eventos do lote, `login` do lote e do header, dia e
  retenção. Comparações internas (entrada na conta, cursores, dedup) ficam no
  relógio local cru, o mesmo da extensão e do logind — uma mudança de offset
  nunca reclassifica eventos. `login` é corrigido uma vez, ao criar o registro
  da sessão.

### 7.3 Foto arquivada ("foto-v1") — binário, sem base64

```
objeto    = nonce(12) || AES-256-GCM(key, nonce, plaintext)           (sem AAD)
plaintext = utf8(json_header) || 0x0A || jpeg_bytes
json_header = {"v":1,"type":"archived_photo","ts":<ms>,"motivo":"login"|"periodica"|"bloqueado"|"alerta",
               "user":"<login da conta>","login":<ms da entrada na conta>,"url":"<só em bloqueado/alerta>"}
```

JSON compacto (sem espaços, UTF-8): o primeiro `0x0A` separa. Abrir
**rejeita** `v != 1`, `type != "archived_photo"` e `header.ts` diferente do
`ts13` do nome. Funções: Python `seal_photo`/`open_photo` (`crypto.py`),
Dart `SessionCrypto.sealPhoto`/`openPhoto` (`lib/src/secure/crypto.dart`).
Vetor de paridade fixo: `agent/tests/fixtures/foto-v1.json` (Celita) =
`test/fixtures/foto-v1.json` (app).

Envio: `POST {storage}/v0/b/{bucket}/o?name=<fotos/{uid}/{dia}/{ts13}_{r}.bin>`
com `Authorization: Firebase <idToken>` e `Content-Type:
application/octet-stream`; depois do upload,
`PUT archive/{deviceId}/fotos/{dia}/{ts13} = {"u": uid, "r": r}`. Nunca
`getDownloadURL`. O app monta o caminho só com `u` e `r` do índice e baixa com
`getData` (teto 1 MiB).

### 7.4 Histórico arquivado ("nav-v1") — envelope de sempre (base64 de nonce||ct)

`POST archive/{deviceId}/nav/{dia}` = `{"env": seal(key, OBJ), "ts": {".sv":"timestamp"}}`

```
OBJ = {"v":1,"type":"archived_nav","user":"<login>","login":<ms>,
       "events":[{"ts":<ms>,"url":"...","title":"...","acao":"bloqueado"|"alerta" (opcional),
                  "foto":<ts13> (opcional — só se a foto saiu)}]}
```

- Cortes: `url` ≤ 300, `title` ≤ 120, ≤ 50 eventos por lote, envelope
  < 64 KiB (o agente parte o lote ao meio até caber). Sem `sid/seq`.
- Um lote nunca cruza a meia-noite nem a sessão (dia do nó = dia dos eventos).
- "Finalizados" = todos menos o último; o último entra só depois de 60 s ou no
  fim da sessão (a extensão ainda pode preencher o título). Envio a cada 60 s
  (ou 50 eventos).
- O app descarta lote com `v != 1` ou `type != "archived_nav"` ("Parte do
  histórico deste dia não pôde ser aberta."), tira duplicatas por
  `login|user|ts|url` (POST reenviado após timeout), ordena por `ts` e agrupa
  por entrada na conta (`login` + `user`).

### 7.5 Qual foto mostrar para um site (app)

1. Se o evento tem `foto` e o índice `fotos/{dayOf(foto)}/{foto}` existe, é
   essa (o dia vem da própria foto: perto da meia-noite ela pode ser do dia
   anterior).
2. Senão, no dia do evento: `antes = orderByKey().startAt(ts13(max(login,
   início do dia))).endAt(ts13(ts)).limitToLast(1)` e `depois =
   orderByKey().startAt(ts13(ts)).limitToFirst(1)`; vale a mais próxima do
   `ts`. Se for a "depois", abre e confere `header.login`/`header.user` com os
   do lote; se não bater (ou não abrir), usa a "antes", se houver; se a
   "depois" não abrir e não houver "antes", mostra o erro da foto (apagada,
   ilegível ou falha de download). No passo 1, se a foto marcada não abrir,
   mostra o erro — não procura outra.
3. Sem nenhuma: "Nenhuma foto deste horário."

### 7.6 Retenção (15 dias: hoje e os 14 anteriores)

- **Agente** (quem poda de verdade): ao conectar e a cada 6 h,
  `GET archive/{id}/nav?shallow=true` e `.../fotos?shallow=true` e um PATCH com
  `null` nos dias `D <= hoje − 15`.
- **App** (reserva): 1 vez por dia por celular (data guardada nas prefs), para
  cada PC de `school/devices`, `update` multi-caminho com
  `archive/{id}/nav/{d}` e `archive/{id}/fotos/{d}` = `null` para `d` de
  hoje−45 a hoje−15. Só poda depois de receber o relógio do servidor
  (`.info/serverTimeOffset` com conexão ativa; espera até 30 s, senão pula o
  dia) — um celular com a data adiantada apagaria dias ainda válidos.
  "Desconectar este PC" **não** apaga o arquivo.
- **Storage:** regra de ciclo de vida do bucket (idade > 15 dias, prefixo
  `fotos/`), versionada em `firebase/storage-lifecycle.json` e aplicada no
  console (§8, passo 2).
- O `/history` (ficha por aula/aluno gravada pelo celular) **não muda**: os 15
  dias valem só para `/archive` e as fotos.

## 8. Ordem de implantação (escola fechada + arquivo)

1. Auditoria do Auth (só leitura): listar as contas com e-mail e conferir com o
   usuário — é a semente de `/school/members`. Conta desconhecida ⇒ fotos e
   histórico esperam uma troca de keypair da escola + re-pareamento.
2. Criar o bucket em modo produção; publicar `storage.rules` e a regra de ciclo
   de vida.
3. App novo (com "Professores da escola") no celular do fundador;
   `/school/members` semeado.
4. Deploy do `database.rules.json`.
5. Pacote do Celita (agente) e APK para os professores.

### Recursos de turma (app 0.20.0, extensão 0.7.0, Celita 0.13.0)

1. Publicar o `database.rules.json` novo no console (superconjunto: clientes
   antigos não percebem).
2. Pacote do Celita 0.13.0 (embute a extensão 0.7.0) e extensão 0.7.0 na Web
   Store. Nos Chromebooks, conceder "Permitir miniatura da tela" no popup
   (uma vez por aparelho) para a grade mostrar a tela.
3. APK 0.20.0 para os professores.
Fora de ordem nada quebra: escrita nova negada mostra ao professor "O
servidor da escola ainda não foi atualizado para este recurso".

## 9. Tipos reservados (futuro)
`lock_screen`, `unlock_screen` e `focus_mode` foram aposentados: a trava é
estado (`set_lock` em `state/lock`) e o modo prova também (`set_exam` em
`state/exam`). Nenhum tipo reservado no momento.
