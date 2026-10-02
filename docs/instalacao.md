# Instalação — Extensão

## Pré-requisitos

- **Chrome ≥ 133** (ChromeOS ou desktop).
- **Internet** no Chromebook — o transporte é Firebase; não precisa estar na
  mesma rede do celular do professor.

## Instalar (Chrome Web Store — recomendado, com auto-update)

A extensão é publicada **não listada** na Chrome Web Store: só instala quem tem
o link, e o **Chrome atualiza sozinho** (checa a cada ~5h; `chrome://extensions`
→ "Atualizar" força na hora).

1. Abra o link da extensão na Web Store:
   **https://chromewebstore.google.com/detail/lhgjobopefkabgcifkkgmcnlmokjpjin**
2. "Usar no Chrome". Pronto — sem modo desenvolvedor, sem pasta.
3. **Permitir miniatura da tela** (uma vez por Chromebook, na preparação): depois
   de parear, abra o popup da extensão → **"Permitir miniatura da tela"** →
   confirme o pedido do Chrome. Isso deixa o professor ver uma miniatura da aba
   ativa na grade ao vivo, **só enquanto ele está olhando**. Sem esse passo
   tudo funciona, mas a grade mostra "Miniatura não permitida neste Chromebook" para este PC.
   A atualização para a 0.7.0 **não** pede reaprovação: a permissão é opcional
   justamente para a extensão continuar ativa.

### Migrando do modo desenvolvedor (unpacked)

A versão da loja tem **ID de extensão diferente** → identidade/vínculo zeram:

1. `chrome://extensions` → **remova** a versão "sem compactação".
2. Instale pela loja (link acima).
3. Abra o popup → **escaneie o QR de novo** com o app do professor (re-pareamento 1x).

## Instalar (modo desenvolvedor — só p/ desenvolvimento)

> Unpacked **nunca se auto-atualiza** — não usar em produção.

1. `chrome://extensions` → ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta **`src/`**.
3. As permissões de host são só os endpoints do Firebase (sem o antigo aviso
   de "ler dados em todos os sites").

## Publicar uma release (mantenedor)

```bash
scripts/release.sh 0.5.0
```

Valida (tree limpo, main, versão crescente), faz bump do `src/manifest.json`,
commit `release: v0.5.0`, tag e push. A **GitHub Action**
(`.github/workflows/release.yml`) zipa, sobe na Web Store (API v2, fica
"pending review" — tipicamente 24–72h; unlisted também passa por review) e cria
a GitHub Release com o zip.

Setup 1x (segredos no repo): `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
`CWS_REFRESH_TOKEN`, `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID` — via
`gh secret set <NOME> -R omanoloneto/chromebook-controller-extension`.
Passo a passo das credenciais (Cloud Console → Chrome Web Store API → OAuth
client "Web application" com redirect p/ o OAuth Playground → refresh token com
scope `chromewebstore`; consent screen **em "In production"**, senão o token
expira em 7 dias): ver o plano de release ou
https://developer.chrome.com/docs/webstore/using-api

Gotchas: review pendente bloqueia novo upload (espere aprovar ou cancele a
submissão); versão enviada "queima" mesmo se rejeitada (sempre crescente);
API v1 morre em 15/out/2026 (este fluxo já usa a v2).

## Como funciona (pareamento por QR)

1. Instalada, a extensão autentica no Firebase (conta anônima) e o **popup
   exibe um QR de pareamento** (há também um botão "Abrir QR em tela cheia").
2. O professor abre o app no celular, toca em **escanear QR** e aponta a câmera
   para a tela do Chromebook. Pronto: o PC fica **vinculado** àquele professor
   (TOFU — vínculo exclusivo) e aparece na lista do app. É **1x por PC**.
3. O professor digita uma URL no app → abre no Chromebook (de qualquer rede).
4. Uma vez vinculado, o professor passa a ver **as abas abertas e as URLs
   visitadas** neste Chromebook (transparência: avise a turma/escola de que o
   monitoramento existe). Com a permissão opcional concedida, ele também vê uma
   **miniatura da aba ativa** na grade ao vivo, só enquanto a grade está aberta;
   a imagem não é guardada.
5. O professor também pode **fechar abas**, **bloquear sites** (aparece a página
   "Site bloqueado pelo professor" — o bloqueio persiste mesmo offline) e
   **trocar o papel de parede** (só em ChromeOS).
6. No popup dá para definir o **nome deste PC** (ex.: "PC 07"), que aparece na
   lista do professor.
7. **Aluno → professor:** no popup, **"Falar com o professor"** abre a janela de
   chat e **"✋ Levantar a mão"** avisa o professor. Na página "Site bloqueado",
   o aluno pode **pedir liberação** com um motivo curto.
8. **"Olhos em mim"** trava a tela com um recado do professor; o **modo prova**
   deixa abrir só os sites liberados. Os dois destravam sozinhos se o professor
   sumir (prazo), e o fim de aula apaga a conversa do chat.

O ícone fica verde quando conectado.

## Se não conectar

- Confira a **internet** do Chromebook.
- O QR é de **uso único**: se o professor escaneou um QR antigo (foto/print),
  abra o popup de novo — ele mostra o QR atual.
- Estado "vínculo divergente": desvincule pelo popup e re-pareie.

## Trocar de professor / professor reinstalou o app

O PC fica vinculado a um professor. Para vincular a outro (ou se o app do
professor foi reinstalado — a identidade dele muda), abra o popup →
**"Desvincular professor"** → o QR reaparece → o professor escaneia de novo.

## Privacidade

Ao desvincular, a extensão **apaga do banco** o relatório de abas, os acks e a
presença deste PC. Os relatórios viajam **cifrados ponta-a-ponta** (só o
celular do professor consegue abrir) — o Firebase/Google não vê o conteúdo.
