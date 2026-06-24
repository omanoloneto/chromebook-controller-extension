# Instalação — Extensão (desenvolvimento)

> A extensão ainda **não está na Chrome Web Store**. Por enquanto, instala-se
> como *unpacked* (sem compactação), em modo de desenvolvedor.

## Pré-requisitos

- Um **Chromebook** (ou Chrome no desktop) com o navegador atualizado.
- Este repositório baixado/clonado no aparelho.

## Passo a passo

1. Abra o Chrome e acesse `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta **`src/`** deste repositório.
5. A extensão aparece na lista. Fixe o ícone na barra para abrir o popup.

## Atualizando após mudanças

Depois de editar arquivos em `src/`, volte em `chrome://extensions` e clique no
ícone de **recarregar** (↻) no cartão da extensão.

## Uso (quando implementado)

1. No Chromebook, abra o popup da extensão e toque em **Parear**.
2. A extensão mostra o **QR #1**.
3. No app (celular), escaneie o QR #1; o app mostra o **QR #2**.
4. No Chromebook, escaneie o QR #2 com a câmera.
5. Conectado! Agora o celular pode enviar URLs para o Chromebook.

Detalhes do handshake em [`protocolo.md`](protocolo.md).

## Problemas comuns

- **Não conecta:** confirme que celular e Chromebook estão na **mesma rede
  Wi-Fi**. Redes de escola às vezes isolam aparelhos (*client isolation*); nesse
  caso, peça ao suporte de TI para liberar.
- **Service worker "inativo":** normal no Manifest V3; ele reativa ao receber
  uma mensagem. Se a conexão cair, basta reabrir o popup.
