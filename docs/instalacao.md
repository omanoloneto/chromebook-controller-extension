# Instalação — Extensão (desenvolvimento)

> Ainda **não está na Chrome Web Store**. Instala-se como *unpacked*.

## Pré-requisitos

- **Chrome ≥ 133** (ChromeOS ou desktop).
- **Internet** no Chromebook — o transporte é Firebase; não precisa estar na
  mesma rede do celular do professor.

## Instalar

1. `chrome://extensions` → ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta **`src/`**.
3. As permissões de host são só os endpoints do Firebase (sem o antigo aviso
   de "ler dados em todos os sites").

## Como funciona (pareamento por QR)

1. Instalada, a extensão autentica no Firebase (conta anônima) e o **popup
   exibe um QR de pareamento** (há também um botão "Abrir QR em tela cheia").
2. O professor abre o app no celular, toca em **escanear QR** e aponta a câmera
   para a tela do Chromebook. Pronto: o PC fica **vinculado** àquele professor
   (TOFU — vínculo exclusivo) e aparece na lista do app. É **1x por PC**.
3. O professor digita uma URL no app → abre no Chromebook (de qualquer rede).
4. Uma vez vinculado, o professor passa a ver **as abas abertas e as URLs
   visitadas** neste Chromebook (somente URLs/títulos — **sem captura de tela**;
   transparência: avise a turma/escola de que o monitoramento existe).
5. O professor também pode **fechar abas**, **bloquear sites** (aparece a página
   "Site bloqueado pelo professor" — o bloqueio persiste mesmo offline) e
   **trocar o papel de parede** (só em ChromeOS).
6. No popup dá para definir o **nome deste PC** (ex.: "PC 07"), que aparece na
   lista do professor.

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
