# Instalação — Extensão (desenvolvimento)

> A extensão ainda **não está na Chrome Web Store**. Por enquanto, instala-se
> como *unpacked* (sem compactação), em modo de desenvolvedor.

## Pré-requisitos

- **Chrome ≥ 144** (ChromeOS ou desktop). Versões anteriores podem bloquear o
  acesso à rede local (ver [Local Network Access](#local-network-access-lna)).
- Celular e Chromebook na **mesma rede Wi-Fi**, **sem client/AP isolation**.
- Este repositório baixado no aparelho.

## Passo a passo (instalar)

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta **`src/`** deste repositório (a `src`, não a raiz do repo).
5. Fixe o ícone na barra.

Para atualizar após editar arquivos: clique em **recarregar** (↻) no cartão.

## Uso (parear e enviar)

1. No **celular**, abra o app **Controle de Aula** — ele mostra **1 QR**.
2. No **Chromebook**, abra o popup da extensão → **Parear** (abre uma aba).
3. A aba pede **câmera** → permita → aponte para o QR do celular.
4. Clique em **Conectar a `<ip>`** → permita o acesso à **rede local** quando
   pedido.
5. Pronto: o status fica **Conectado**. No app, digite uma URL e ela abre no
   Chromebook.

> A conexão é **direta e criptografada** (a chave vai só no QR). Não há botão de
> cancelar: enquanto o app estiver aberto, a extensão reconecta sozinha.

## Local Network Access (LNA)

O Chrome 142+ exige permissão para acessar a rede local. A extensão pede acesso
só para `http://<ip-do-celular>/*` (no clique de **Conectar**). Em **Chromebook
gerenciado** pela escola, o administrador pode liberar sem prompt com a política
**`LocalNetworkAccessAllowedForUrls`** (Google Admin Console). Se o acesso for
bloqueado, confirme que o Chrome está **≥ 144**.

## Problemas comuns

- **"Permissão de rede local negada":** aceite o prompt; em frota gerenciada,
  peça ao admin a política acima.
- **Conecta mas nada abre:** confirme a **mesma Wi-Fi** e que a rede **não isola
  clientes**. Teste cru: abra `http://<ip>:<porta>/` numa aba — deve responder
  `controle-de-aula`.
- **Câmera não abre:** clique no ícone de câmera na barra de endereço da aba e
  permita.
